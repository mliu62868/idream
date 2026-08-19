"use client";

import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  characterVideoProductionRecipe,
  creativeReviewDecisionRequestSchema,
  creativeRunCreateRequestSchema,
  type CharacterWorkspaceDetail,
  type CreativeReviewDecisionRequest,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import {
  Check,
  ImageIcon,
  Loader2,
  RefreshCcw,
  Sparkles,
  ThumbsDown,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { formatDreamcoins, formatDuration } from "@/components/admin/ui/format";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { useAuthorityResource } from "@/lib/authority-resource";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";
import { cn } from "@/lib/utils";

type CharacterVideoPermissions = {
  readonly read: boolean;
  readonly create: boolean;
  readonly review: boolean;
};

type RunCommittedMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

type CharacterVideoCreateRequest = ReturnType<
  typeof creativeRunCreateRequestSchema.parse
>;

type CharacterVideoReviewSnapshot = {
  readonly runId: string;
  readonly itemId: string;
  readonly body: CreativeReviewDecisionRequest;
};

type CharacterVideoSourceOption = {
  readonly assetId: string;
  readonly label: string;
  readonly labelValues?: Readonly<Record<string, string | number>>;
  readonly url: string;
  readonly thumbnailUrl: string | null;
};

const adoptedSourceLabels = {
  character_cover: "Primary portrait",
  character_hero: "Character hero",
  character_chat: "Chat moment",
} as const;

const reviewChecks = [
  ["artifactFree", "No visible artifacts or flicker"],
  ["singleSubject", "Exactly one intended subject"],
  ["intentMatch", "Motion matches the brief"],
  ["noVisibleText", "No unintended visible text"],
] as const;

type ReviewQuality = Record<(typeof reviewChecks)[number][0], boolean>;

const emptyReviewQuality = (): ReviewQuality => ({
  artifactFree: false,
  singleSubject: false,
  intentMatch: false,
  noVisibleText: false,
});

export function characterVideoSourceOptions(
  data: Pick<CharacterWorkspaceDetail, "project" | "visual">,
): readonly CharacterVideoSourceOption[] {
  const assets = new Map(
    [
      ...data.visual.videoSources,
      ...data.visual.anchors,
      ...data.visual.references,
    ]
      .filter((asset) => asset.available && asset.url)
      .map((asset) => [asset.mediaAssetId, asset] as const),
  );
  const options: CharacterVideoSourceOption[] = [];
  const used = new Set<string>();
  for (const purpose of Object.keys(adoptedSourceLabels) as Array<
    keyof typeof adoptedSourceLabels
  >) {
    const assetId = data.project.draftAssetPack[purpose];
    const asset = assetId ? assets.get(assetId) : undefined;
    if (!asset || !asset.url || used.has(asset.mediaAssetId)) continue;
    used.add(asset.mediaAssetId);
    options.push({
      assetId: asset.mediaAssetId,
      label: adoptedSourceLabels[purpose],
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
    });
  }
  for (const asset of assets.values()) {
    if (!asset.url || used.has(asset.mediaAssetId)) continue;
    used.add(asset.mediaAssetId);
    options.push({
      assetId: asset.mediaAssetId,
      label: "Character image {id}",
      labelValues: { id: options.length + 1 },
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
    });
  }
  return options;
}

function videoExecutionLabel(item: CreativeRunDetail["items"][number] | null) {
  if (!item) return "Waiting for generation details";
  if (item.asset) return "Video ready for review";
  return {
    dispatching: "Preparing video generation",
    provider_queued: "Waiting for video capacity",
    generating: "Generating video",
    finalizing: "Saving generated video",
    ready: "Video ready for review",
    failed: "Video generation failed",
  }[item.executionState];
}

function isDefinitiveMutationRejection(
  cause: unknown,
): cause is AdminV2RequestError {
  return cause instanceof AdminV2RequestError &&
    [400, 401, 403, 404, 409, 422].includes(cause.status);
}

function createRequestSignature(
  characterId: string,
  body: CharacterVideoCreateRequest,
) {
  return JSON.stringify({ characterId, body });
}

function reviewRequestSignature(snapshot: CharacterVideoReviewSnapshot) {
  return JSON.stringify(snapshot);
}

function savedCreateRequest(
  intent: DurableMutationIntent,
  characterId: string,
) {
  const parsed = creativeRunCreateRequestSchema.safeParse(
    intent.requestSnapshot,
  );
  if (
    !parsed.success ||
    parsed.data.purpose !== "character_video" ||
    parsed.data.targetType !== "character" ||
    parsed.data.targetId !== characterId ||
    parsed.data.profileId !== characterVideoProductionRecipe.profileKey
  ) {
    return null;
  }
  return parsed.data;
}

function savedReviewSnapshot(value: unknown): CharacterVideoReviewSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.runId !== "string" || typeof snapshot.itemId !== "string") {
    return null;
  }
  const body = creativeReviewDecisionRequestSchema.safeParse(snapshot.body);
  return body.success
    ? { runId: snapshot.runId, itemId: snapshot.itemId, body: body.data }
    : null;
}

function createdRunProjectionMatches(
  detail: CreativeRunDetail,
  body: CharacterVideoCreateRequest,
) {
  return detail.purpose === "character_video" &&
    detail.target.type === "character" &&
    detail.target.id === body.targetId &&
    detail.title === body.title &&
    detail.reviewContext.profile.key === body.profileId &&
    detail.reviewContext.brief === body.brief &&
    detail.reviewContext.orientation === body.orientation &&
    detail.reviewContext.referenceAssetCount === body.referenceAssetIds.length &&
    detail.items.length === body.count;
}

// SPEC: 播放器出问题必须说出问题，不能一直转圈。
// INTENT: 生成成功（状态标"已成功"）只代表产出了文件，不代表这台机器放得出来。原先
// <video> 没有任何失败处理：解码失败、下载中断、浏览器不支持该编码，表现全都是永远转圈，
// 运营既判断不出是"还在加载"还是"坏了"，也拿不到可以拿去复核的地址。
// 两种失败都要盖到：error 事件（有明确 MediaError）与静默停滞（连元数据都没拿到）。
const VIDEO_STALL_TIMEOUT_MS = 15_000;

// INTENT: 稳定引用，避免"列表还没到"时每次渲染都换一个空数组。
const EMPTY_VIDEO_RUNS: readonly CreativeRun[] = [];

const videoErrorReasons: Record<number, string> = {
  1: "Playback was aborted before the video loaded.",
  2: "The video download failed. Check network access to the asset URL.",
  3: "The video downloaded but could not be decoded. The file may be corrupt.",
  4: "This browser cannot play the video's format, or the asset URL is unreachable.",
};

export function videoPlaybackIssueMessage(issue: "stalled" | number) {
  if (issue === "stalled") return "The video did not start playing in this browser.";
  return videoErrorReasons[issue] ?? "The video could not be played.";
}

function VideoPlayback({ src }: { src: string }) {
  const { t } = useAdminI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [issue, setIssue] = useState<"stalled" | number | null>(null);

  // 换视频靠调用方的 key 重挂载来重置状态，effect 只挂看门狗。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // readyState 0 = HAVE_NOTHING：连元数据都没解出来，且没有触发 error。
      if (videoRef.current?.readyState === 0) setIssue("stalled");
    }, VIDEO_STALL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      <video
        className="h-[360px] w-full rounded-lg bg-black object-contain sm:aspect-[4/3] sm:h-auto sm:max-h-[620px]"
        controls
        onError={(event) => setIssue(event.currentTarget.error?.code ?? 0)}
        onLoadedMetadata={() => setIssue(null)}
        playsInline
        preload="metadata"
        ref={videoRef}
        src={src}
      />
      {issue !== null ? (
        <div
          className="mt-2 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]"
          role="alert"
        >
          <p className="font-semibold">
            {t(videoPlaybackIssueMessage(issue))}
          </p>
          <p className="mt-1">
            {t("The generation run still succeeded — this is a playback problem.")}{" "}
            <a className="underline" href={src} rel="noreferrer" target="_blank">
              {t("Open the file directly")}
            </a>
          </p>
        </div>
      ) : null}
    </>
  );
}

export function CharacterVideoStudio({
  actorId,
  data,
  onCreateImage,
  permissions,
  runCommittedMutation,
}: {
  readonly actorId: string;
  readonly data: CharacterWorkspaceDetail;
  readonly onCreateImage: () => void;
  readonly permissions: CharacterVideoPermissions;
  readonly runCommittedMutation: RunCommittedMutation;
}) {
  const { locale, t } = useAdminI18n();
  const createIntentScope =
    `character-video:create:${actorId}:${data.character.id}`;
  const reviewIntentScope =
    `character-video:review:${actorId}:${data.character.id}`;
  const sources = useMemo(() => characterVideoSourceOptions(data), [data]);
  const [preferredSourceAssetId, setPreferredSourceAssetId] = useState(
    () => sources[0]?.assetId ?? "",
  );
  const sourceAssetId = sources.some(
    (source) => source.assetId === preferredSourceAssetId,
  )
    ? preferredSourceAssetId
    : sources[0]?.assetId ?? "";
  const [brief, setBrief] = useState(() =>
    t(
      "Subtle natural breathing, a gentle smile, and direct eye contact. Keep the camera steady and preserve the exact face and background.",
    )
  );
  // SPEC: 选中哪个 Run 是这一屏唯一的"取数身份"；null 表示跟随列表最新一条。
  // INTENT: 原来 loadRuns 与 loadRun 互写 runs/selectedRun 两份 state——列表取完顺手把
  //         第一条的详情也取了，详情取完又把自己塞回列表。两条路径都能改对方的状态，
  //         "现在到底在看哪个 Run"没有单一出处。改成 id 驱动后，列表与详情各是一份
  //         只读投影，谁也写不了对方。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "review" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewQuality, setReviewQuality] =
    useState<ReviewQuality>(emptyReviewQuality);
  const [identityConsistency, setIdentityConsistency] =
    useState<"passed" | "failed">("passed");
  const [score, setScore] = useState("90");
  const [reviewReason, setReviewReason] = useState("");
  const [createIntent, setCreateIntent] = useState<DurableMutationIntent | null>(
    () => readActiveDurableMutationIntent({ scope: createIntentScope }),
  );
  const [reviewIntent, setReviewIntent] = useState<DurableMutationIntent | null>(
    () => readActiveDurableMutationIntent({ scope: reviewIntentScope }),
  );
  const runList = useAuthorityResource({
    key: data.character.id,
    enabled: permissions.read,
    load: useCallback(async () => {
      const query = new URLSearchParams({
        limit: "20",
        purpose: "character_video",
        targetType: "character",
        targetId: data.character.id,
        sort: "updated_desc",
      });
      const response = await adminV2Operation("GET /api/v2/admin/creative/runs", {
        query,
      });
      // INVARIANT: 这一屏只认 character_video，串了别的 purpose 宁可整块报错也不渲染。
      if (response.items.some((run) => run.purpose !== "character_video")) {
        throw new Error("The Character video query returned a non-video Run.");
      }
      return [...response.items];
    }, [data.character.id]),
  });
  const listedRuns = runList.data ?? EMPTY_VIDEO_RUNS;
  // SPEC: 没有显式选择时看最新一条。
  const activeRunId = selectedRunId ?? listedRuns[0]?.id ?? null;

  // INVARIANT: 详情必须是这个 Character 的视频 Run；不是就报错，不渲染别人的画面。
  const fetchRunDetail = useCallback(async (runId: string) => {
    const detail = await adminV2Operation("GET /api/v2/admin/creative/runs/:id", {
      path: { id: runId },
    });
    if (
      detail.purpose !== "character_video" ||
      detail.target.type !== "character" ||
      detail.target.id !== data.character.id
    ) {
      throw new Error("The selected video Run does not belong to this Character.");
    }
    return detail;
  }, [data.character.id]);

  const runDetail = useAuthorityResource(
    {
      key: activeRunId ?? "",
      enabled: permissions.read && activeRunId !== null,
      load: useCallback(
        () => fetchRunDetail(activeRunId ?? ""),
        [activeRunId, fetchRunDetail],
      ),
    },
    {
      // SPEC: 生成中的视频 Run 每 5s 刷新一次；连续失败按 2 倍退避，封顶 40s。
      // INTENT: 这里最早是无退避的 setInterval——后端一旦不稳，它会以固定 5s 持续加压，
      //         而且 setInterval 不等上一轮返回，慢响应时请求会叠在一起。
      pollWhile: ({ data: detail, consecutiveFailures }) =>
        detail && ["pending", "running"].includes(detail.executionOutcome)
          ? 5_000 * 2 ** Math.min(consecutiveFailures, 3)
          : null,
    },
  );
  const selectedRun = runDetail.data;
  // SPEC: 刚创建、还没进过列表的 Run 也要出现在历史里。
  // INTENT: 这是从两份只读投影推出来的，不再是 loadRun 往 runs 里回写的副作用。
  const runs: readonly CreativeRun[] =
    selectedRun && !listedRuns.some((run) => run.id === selectedRun.id)
      ? [selectedRun, ...listedRuns]
      : listedRuns;
  // SPEC: loading 只表示"这一屏还没有可看的内容"，前台刷新不清空已有画面。
  const loading =
    (runList.loading && runList.data === null) ||
    (activeRunId !== null && runDetail.loading && selectedRun === null);

  const { setData: setRunDetailData } = runDetail;
  // SPEC: 恢复/校验路径已经拿到 detail 了，直接让它成为当前 Run。
  // INTENT: 换 Run 时 setData 写在旧 key 上会立刻被新一轮取数覆盖成同一份数据，
  //         所以两句都发无需分支；同 Run 时 setData 才是真正生效的那一句。
  const showRun = useCallback((detail: CreativeRunDetail) => {
    setSelectedRunId(detail.id);
    setRunDetailData(detail);
  }, [setRunDetailData]);

  const verifyCreatedRun = async (
    intent: DurableMutationIntent,
    body: CharacterVideoCreateRequest,
    runId: string,
  ) => {
    const detail = await fetchRunDetail(runId);
    showRun(detail);
    if (!createdRunProjectionMatches(detail, body)) {
      throw new Error(
        "The exact created video Run is not present in the latest projection yet.",
      );
    }
    clearDurableMutationIntent(intent);
    setCreateIntent(null);
    return detail;
  };

  const createVideo = async () => {
    if (!permissions.create || (!sourceAssetId && !createIntent)) return;
    setBusy("create");
    setError(null);
    setMessage(null);
    let intent = createIntent;
    let body = intent
      ? savedCreateRequest(intent, data.character.id)
      : creativeRunCreateRequestSchema.parse({
          title: `${data.character.name} motion portrait`,
          purpose: "character_video",
          targetType: "character",
          targetId: data.character.id,
          profileId: characterVideoProductionRecipe.profileKey,
          referenceAssetIds: [sourceAssetId],
          orientation: characterVideoProductionRecipe.orientation,
          count: characterVideoProductionRecipe.outputCount,
          brief,
          consistencyMode: "balanced",
          priority: "normal",
          reason: "Create one reviewable Character video candidate",
        });
    try {
      if (
        intent &&
        (intent.status === "reconciliation_required" || !body)
      ) {
        const receipt = await reconcileDurableMutationIntent({
          intent,
          commandType: "creative.run.create",
          expectedCharacterId: data.character.id,
          expectedPurpose: "character_video",
        });
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(intent);
          setCreateIntent(null);
          setMessage(
            "The old video request had no committed effect. A new request is now safe.",
          );
          return;
        }
        if (
          receipt.state !== "committed" ||
          !receipt.committedTargetId ||
          receipt.verification?.kind !== "creative_run" ||
          receipt.verification.runId !== receipt.committedTargetId
        ) {
          throw new Error(
            `The saved video request is ${receipt.state}. Keep its exact request locked until a committed receipt is available.`,
          );
        }
        const recoveredBody = creativeRunCreateRequestSchema.safeParse(
          receipt.verification.requestSnapshot,
        );
        if (
          !recoveredBody.success ||
          recoveredBody.data.purpose !== "character_video" ||
          recoveredBody.data.targetType !== "character" ||
          recoveredBody.data.targetId !== data.character.id
        ) {
          throw new Error(
            "The recovered receipt does not contain this Character's exact video request.",
          );
        }
        body = recoveredBody.data;
        intent = updateDurableMutationIntent(intent, {
          status: "committed_projection_pending",
          committedTargetId: receipt.committedTargetId,
          requestSnapshot: body,
        });
        setCreateIntent(intent);
        await verifyCreatedRun(intent, body, receipt.committedTargetId);
        setMessage(
          "The committed video request was recovered and verified in its exact Run.",
        );
        return;
      }
      if (!body) {
        throw new Error(
          "The saved video request no longer matches the active contract and must be reconciled.",
        );
      }
      if (
        intent?.status === "committed_projection_pending" &&
        intent.committedTargetId
      ) {
        await verifyCreatedRun(intent, body, intent.committedTargetId);
        setMessage(
          "The committed video Run is now visible. No duplicate request was submitted.",
        );
        return;
      }
      const signature = createRequestSignature(data.character.id, body);
      if (!intent) {
        const claim = await claimDurableMutationIntent({
          scope: createIntentScope,
          signature,
          requestSnapshot: body,
        });
        intent = claim.intent;
        setCreateIntent(intent);
        if (intent.signature !== signature) {
          setError(
            "Another tab already started a different video request. Resume its exact saved request first.",
          );
          return;
        }
      }
      let currentIntent = intent;
      const mutation = await runCommittedMutation({
        action: "Create Character video",
        commit: async () => {
          const result = await adminV2Operation("POST /api/v2/admin/creative/runs", {
            idempotencyKey: currentIntent.idempotencyKey,
            body,
          });
          currentIntent = updateDurableMutationIntent(currentIntent, {
            status: "committed_projection_pending",
            committedTargetId: result.batch.id,
          });
          intent = currentIntent;
          setCreateIntent(currentIntent);
          return result;
        },
      });
      await verifyCreatedRun(currentIntent, body, mutation.result.batch.id);
      setMessage(
        mutation.result.replayed
          ? "The existing video Run was recovered. This page will keep its progress current."
          : "Video generation started. This page will keep the progress current.",
      );
    } catch (cause) {
      if (intent?.status === "committed_projection_pending") {
        setError(
          cause instanceof Error
            ? `The video Run was committed, but exact projection verification is pending: ${cause.message}`
            : "The video Run was committed, but exact projection verification is pending.",
        );
      } else if (intent?.status === "reconciliation_required") {
        setError(
          cause instanceof Error
            ? cause.message
            : "The saved video request could not be reconciled.",
        );
      } else if (intent && isDefinitiveMutationRejection(cause)) {
        clearDurableMutationIntent(intent);
        setCreateIntent(null);
        setError(cause.message);
      } else if (intent) {
        const unknown = updateDurableMutationIntent(intent, {
          status: "outcome_unknown",
        });
        setCreateIntent(unknown);
        setError(
          "Video creation outcome is unknown. Resume video creation to replay the exact request with the same key.",
        );
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Video generation could not start",
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      // SPEC: 有选中 Run 就只刷它，否则刷列表——列表刷完自然带出最新一条的详情。
      if (activeRunId) await runDetail.refresh();
      else await runList.refresh();
    } finally {
      setBusy(null);
    }
  };

  const selectedItem = selectedRun?.items[0] ?? null;
  const selectedSource =
    sources.find((source) => source.assetId === sourceAssetId) ?? null;
  const estimate =
    data.visual.videoGenerationEstimate?.profileKey ===
      characterVideoProductionRecipe.profileKey
      ? data.visual.videoGenerationEstimate
      : null;
  const lockedCreateRequest = createIntent
    ? savedCreateRequest(createIntent, data.character.id)
    : null;
  const createActionLabel = createIntent
    ? createIntent.status === "committed_projection_pending"
      ? "Verify created video"
      : createIntent.status === "reconciliation_required"
        ? "Reconcile saved video request"
        : "Resume video creation"
    : "Create video";
  const reviewRecoveryLabel =
    reviewIntent?.status === "committed_projection_pending"
      ? "Verify saved review"
      : reviewIntent?.status === "reconciliation_required"
        ? "Reconcile saved review"
        : "Resume saved review";
  const numericScore = Number(score);
  const approvalReady =
    Object.values(reviewQuality).every(Boolean) &&
    identityConsistency === "passed" &&
    Number.isInteger(numericScore) &&
    numericScore >= CHARACTER_IDENTITY_APPROVAL_MIN_SCORE &&
    numericScore <= 100 &&
    reviewReason.trim().length >= 3;
  const rejectionReady = reviewReason.trim().length >= 3;

  const verifySavedReview = async (
    intent: DurableMutationIntent,
    snapshot: CharacterVideoReviewSnapshot,
  ) => {
    const detail = await fetchRunDetail(snapshot.runId);
    showRun(detail);
    const projected = detail.items.some(
      (item) =>
        item.id === snapshot.itemId &&
        item.review?.id === intent.committedTargetId,
    );
    if (!projected) {
      throw new Error(
        "The exact decision is not present on the latest video Run item yet.",
      );
    }
    clearDurableMutationIntent(intent);
    setReviewIntent(null);
    setReviewQuality(emptyReviewQuality());
    setReviewReason("");
    setMessage(
      snapshot.body.decision === "approved"
        ? "Video approved for the Character video library. Nothing was published automatically."
        : "Video rejected. The immutable decision remains in Run history.",
    );
    return detail;
  };

  const commitSavedReview = async (
    intent: DurableMutationIntent,
    snapshot: CharacterVideoReviewSnapshot,
  ) => {
    let currentIntent = intent;
    try {
      const mutation = await runCommittedMutation({
        action: "Review Character video",
        commit: async () => {
          const result = await adminV2Operation(
            "POST /api/v2/admin/creative/runs/:id/items/:itemId/decisions",
            {
              path: { id: snapshot.runId, itemId: snapshot.itemId },
              idempotencyKey: currentIntent.idempotencyKey,
              body: snapshot.body,
            },
          );
          currentIntent = updateDurableMutationIntent(currentIntent, {
            status: "committed_projection_pending",
            committedTargetId: result.decisionId,
          });
          setReviewIntent(currentIntent);
          return result;
        },
      });
      void mutation;
      await verifySavedReview(currentIntent, snapshot);
    } catch (cause) {
      if (currentIntent.status === "committed_projection_pending") {
        setError(
          cause instanceof Error
            ? `The review was committed, but exact decision verification is pending: ${cause.message}`
            : "The review was committed, but exact decision verification is pending.",
        );
      } else if (isDefinitiveMutationRejection(cause)) {
        clearDurableMutationIntent(currentIntent);
        setReviewIntent(null);
        setError(cause.message);
      } else {
        currentIntent = updateDurableMutationIntent(currentIntent, {
          status: "outcome_unknown",
        });
        setReviewIntent(currentIntent);
        setError(
          "Review outcome is unknown. Resume saved review to replay the exact decision with the same key.",
        );
      }
    }
  };

  const resumeReview = async () => {
    if (!permissions.review || !reviewIntent) return;
    setBusy("review");
    setError(null);
    setMessage(null);
    try {
      let intent = reviewIntent;
      let snapshot = savedReviewSnapshot(intent.requestSnapshot);
      if (intent.status === "reconciliation_required" || !snapshot) {
        const receipt = await reconcileDurableMutationIntent({
          intent,
          commandType: "creative.review.decision",
        });
        if (receipt.state === "cancelled") {
          clearDurableMutationIntent(intent);
          setReviewIntent(null);
          setMessage(
            "The old review request had no committed effect. A new decision is now safe.",
          );
          return;
        }
        if (
          receipt.state !== "committed" ||
          !receipt.committedTargetId ||
          receipt.verification?.kind !== "creative_review_decision" ||
          receipt.verification.decisionId !== receipt.committedTargetId
        ) {
          throw new Error(
            `The saved review is ${receipt.state}. Keep its exact decision locked until a committed receipt is available.`,
          );
        }
        snapshot = savedReviewSnapshot(receipt.verification.requestSnapshot);
        if (!snapshot) {
          throw new Error(
            "The recovered review receipt is missing its exact Run item request.",
          );
        }
        intent = updateDurableMutationIntent(intent, {
          status: "committed_projection_pending",
          committedTargetId: receipt.committedTargetId,
          requestSnapshot: snapshot,
        });
        setReviewIntent(intent);
      }
      if (!snapshot) return;
      if (intent.status === "committed_projection_pending") {
        await verifySavedReview(intent, snapshot);
      } else {
        await commitSavedReview(intent, snapshot);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The saved video review could not be recovered",
      );
    } finally {
      setBusy(null);
    }
  };

  const reviewVideo = async (decision: "approved" | "rejected") => {
    if (reviewIntent) {
      await resumeReview();
      return;
    }
    if (!permissions.review || !selectedRun || !selectedItem?.asset) return;
    const body = creativeReviewDecisionRequestSchema.parse({
      entityVersion: selectedRun.version,
      ...(selectedItem.review
        ? { supersedesDecisionId: selectedItem.review.id }
        : {}),
      decision,
      identityConsistency,
      ...(Number.isInteger(numericScore) ? { score: numericScore } : {}),
      quality: reviewQuality,
      reason: reviewReason.trim(),
    });
    const snapshot = {
      runId: selectedRun.id,
      itemId: selectedItem.id,
      body,
    } satisfies CharacterVideoReviewSnapshot;
    const claim = await claimDurableMutationIntent({
      scope: reviewIntentScope,
      signature: reviewRequestSignature(snapshot),
      requestSnapshot: snapshot,
    });
    setReviewIntent(claim.intent);
    setBusy("review");
    setError(null);
    setMessage(null);
    try {
      if (claim.intent.signature !== reviewRequestSignature(snapshot)) {
        setError(
          "Another tab already started a different video review. Resume its exact saved decision first.",
        );
        return;
      }
      await commitSavedReview(claim.intent, snapshot);
    } finally {
      setBusy(null);
    }
  };

  // SPEC: 写入失败优先，然后是详情取数失败（含轮询失败），最后才是列表失败。
  // INTENT: 三种失败原来共用一个 error，谁最后写谁显示。拆开之后要显式定一个次序：
  //         越靠近运营刚才那个动作的越先说。轮询失败当年就是红色报错，保持不变。
  const shownError = error ??
    runDetail.error ??
    runDetail.refreshError ??
    runList.error;

  if (!permissions.read) {
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5">
        <h3 className="font-semibold">{t("Character video")}</h3>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t("Creative Run read access is required.")}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="character-video-title" className="space-y-5">
      {shownError ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t(shownError)}</p> : null}
      {message ? <p className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">{t(message)}</p> : null}
      {reviewIntent ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <span>
            {t(
              reviewIntent.status === "committed_projection_pending"
                ? "A review receipt is committed. Verify its exact decision before another review."
                : "A saved review must be resumed with its original request key before another review.",
            )}
          </span>
          <WorkspaceButton
            disabled={busy !== null || !permissions.review}
            onClick={() => void resumeReview()}
          >
            {t(reviewRecoveryLabel)}
          </WorkspaceButton>
        </div>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div>
              <h3 className="font-semibold" id="character-video-title">{t("Video")}</h3>
              <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{selectedRun?.title ?? t("No video generated yet")}</p>
            </div>
            <div className="flex items-center gap-2">
              {selectedRun ? <StatusBadge value={selectedRun.executionOutcome} /> : null}
              <WorkspaceButton aria-label={t("Refresh")} disabled={busy !== null} onClick={() => void refresh()}>
                <RefreshCcw className={cn("h-4 w-4", busy === "refresh" && "animate-spin")} />
                {t("Refresh")}
              </WorkspaceButton>
            </div>
          </div>

          {loading ? (
            <div className="grid min-h-96 place-items-center rounded-lg border border-[var(--ad-border)] text-[var(--ad-text-muted)]"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : selectedRun && selectedItem ? (
            <>
              {selectedItem.asset ? (
                <VideoPlayback key={selectedItem.asset.url} src={selectedItem.asset.url} />
              ) : (
                <div className="grid min-h-96 place-items-center rounded-lg border border-[var(--ad-border)] bg-black/[0.02] text-center text-[var(--ad-text-muted)]">
                  <div className="max-w-md px-5">
                    {selectedItem.executionState === "failed" ? <Video className="mx-auto h-7 w-7" /> : <Loader2 className="mx-auto h-7 w-7 animate-spin" />}
                    <p className="mt-3 text-sm font-semibold">{t(videoExecutionLabel(selectedItem))}</p>
                    {/* SPEC: 失败要说原因，并给出真正能重跑的去处。
                        INTENT: 契约的 failure.operatorGuidance / errorCode 此前只有视觉实验台读；
                        重试是 CreativeRunWorkspace 那台带幂等键的持久命令机，不在这里复制第二份。 */}
                    {selectedItem.executionState === "failed" ? (
                      <div className="mt-3 text-xs" role="alert">
                        {selectedItem.failure ? (
                          <>
                            <p className="leading-5 text-[var(--ad-red-text)]">
                              {selectedItem.failure.operatorGuidance}
                            </p>
                            <code className="mt-2 block font-mono text-[11px]">
                              {selectedItem.failure.errorCode}
                            </code>
                          </>
                        ) : null}
                        <Link
                          className="mt-3 inline-flex min-h-8 items-center font-semibold underline"
                          href={`/admin/creative/runs/${encodeURIComponent(selectedRun.id)}`}
                        >
                          {t("Open run to retry")}
                        </Link>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="grid min-h-96 place-items-center rounded-lg border border-[var(--ad-border)] bg-black/[0.02] text-center text-[var(--ad-text-muted)]">
              <div><Video className="mx-auto h-7 w-7" /><p className="mt-3 text-sm">{t("No video generated yet")}</p></div>
            </div>
          )}

          {selectedItem?.asset ? (
            <details className="mt-4 border-t border-[var(--ad-border)] pt-3" open={!selectedItem.review}>
              <summary className="cursor-pointer text-sm font-semibold">{t("Video review")}</summary>
              <div className="mt-4 max-w-2xl">
                {selectedItem.review ? (
                  <div className="text-sm">
                    <StatusBadge tone={selectedItem.review.decision === "approved" ? "good" : "bad"} value={selectedItem.review.decision} />
                    <p className="mt-3 leading-6">{selectedItem.review.reason}</p>
                    <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Identity")} {t(selectedItem.review.identityConsistency)}{selectedItem.review.score !== null ? ` · ${selectedItem.review.score}/100` : ""}</p>
                  </div>
                ) : (
                  <>
                    <fieldset className="grid gap-2 sm:grid-cols-2">
                      <legend className="sr-only">{t("Video quality checks")}</legend>
                      {reviewChecks.map(([key, label]) => (
                        <label className="flex min-h-10 items-center gap-3 rounded-md bg-[var(--ad-surface-subtle)] px-3 text-xs" key={key}>
                          <input checked={reviewQuality[key]} onChange={(event) => setReviewQuality((current) => ({ ...current, [key]: event.target.checked }))} type="checkbox" />
                          <span>{t(label)}</span>
                        </label>
                      ))}
                    </fieldset>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Identity")}<select className={`${fieldClass} mt-1`} onChange={(event) => setIdentityConsistency(event.target.value as "passed" | "failed")} value={identityConsistency}><option value="passed">{t("Passed")}</option><option value="failed">{t("Failed")}</option></select></label>
                      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Score")}<input className={`${fieldClass} mt-1`} max={100} min={0} onChange={(event) => setScore(event.target.value)} step={1} type="number" value={score} /></label>
                    </div>
                    <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evidence and reason")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReviewReason(event.target.value)} placeholder={t("Describe motion, identity stability, artifacts, and intent match")} value={reviewReason} /></label>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <WorkspaceButton disabled={busy !== null || !permissions.review || !rejectionReady} onClick={() => void reviewVideo("rejected")} tone="danger"><ThumbsDown className="h-4 w-4" />{t("Reject")}</WorkspaceButton>
                      <WorkspaceButton disabled={busy !== null || !permissions.review || !approvalReady} onClick={() => void reviewVideo("approved")} tone="primary">{busy === "review" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{t("Approve video")}</WorkspaceButton>
                    </div>
                  </>
                )}
              </div>
            </details>
          ) : null}
        </div>

        <aside className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5 xl:sticky xl:top-4" aria-label={t("New Character video")}>
          <h3 className="font-semibold">{t("New video")}</h3>
          <div className="mt-4">
            {sources.length === 0 ? (
              <div className="text-sm">
                <strong>{t("Create a Character image first")}</strong>
                <WorkspaceButton className="mt-3" onClick={onCreateImage} tone="primary"><ImageIcon className="h-4 w-4" />{t("Create a Character image")}</WorkspaceButton>
              </div>
            ) : (
              <label className="block text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Source image")}
                <span className="mt-2 flex items-center gap-3">
                  {selectedSource ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the source is an authorized media render URL
                    <img alt={t("{name} video source", { name: data.character.name })} className="h-14 w-14 shrink-0 rounded-md object-cover" src={selectedSource.thumbnailUrl ?? selectedSource.url} />
                  ) : null}
                  <select className={fieldClass} disabled={busy !== null || createIntent !== null} onChange={(event) => setPreferredSourceAssetId(event.target.value)} value={sourceAssetId}>
                    {sources.map((source) => <option key={source.assetId} value={source.assetId}>{t(source.label, source.labelValues)}</option>)}
                  </select>
                </span>
              </label>
            )}
            <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Motion brief")}
              <textarea className={`${textAreaClass} mt-1 min-h-32`} disabled={busy !== null || createIntent !== null} onChange={(event) => setBrief(event.target.value)} value={brief} />
            </label>
            {createIntent ? (
              <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]" role="status">
                {t(
                  lockedCreateRequest
                    ? "The saved request keeps its original source image and motion brief until recovery completes."
                    : "The saved request must be reconciled before these controls can be edited.",
                )}
              </p>
            ) : null}
            <div
              aria-label={t("Generation estimate")}
              className="mt-4 rounded-md bg-[var(--ad-surface-subtle)] px-3 py-2 text-xs leading-5 text-[var(--ad-text-muted)]"
            >
              <p>
                {estimate?.estimatedCostDreamcoins !== null &&
                estimate?.estimatedCostDreamcoins !== undefined
                  ? t("Estimated cost: {cost}", {
                      cost: formatDreamcoins(estimate.estimatedCostDreamcoins, locale),
                    })
                  : t("Estimated cost unavailable")}
              </p>
              <p>
                {estimate?.averageDurationMs !== null &&
                estimate?.averageDurationMs !== undefined
                  ? t("Estimated duration: {duration} · {days}-day average · {count} completed run", {
                      duration: formatDuration(estimate.averageDurationMs),
                      days: estimate.windowDays,
                      count: estimate.completedSampleCount,
                    })
                  : t("Estimated duration unavailable until this profile has completed health samples")}
              </p>
            </div>
            <WorkspaceButton className="mt-4 w-full justify-center" disabled={loading || busy !== null || !permissions.create || (!createIntent && (!sourceAssetId || brief.trim().length === 0))} onClick={() => void createVideo()} tone="primary">
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{t(createActionLabel)}
            </WorkspaceButton>
          </div>
          <details className="mt-4 border-t border-[var(--ad-border)] pt-3 text-xs">
            <summary className="cursor-pointer font-semibold text-[var(--ad-text-muted)]">{t("Model")}</summary>
            <dl className="mt-3 grid gap-2 text-[var(--ad-text-muted)]">
              <div className="flex justify-between gap-3"><dt>{t("Model")}</dt><dd className="font-semibold text-[var(--ad-ink)]">{t(characterVideoProductionRecipe.modelLabel)}</dd></div>
              <div className="flex justify-between gap-3"><dt>{t("Clip")}</dt><dd>{t("{seconds} seconds · {fps} fps", { seconds: characterVideoProductionRecipe.durationSeconds, fps: characterVideoProductionRecipe.fps })}</dd></div>
              <div className="flex justify-between gap-3"><dt>{t("Frame")}</dt><dd>{t("{width}×{height} · {orientation}", { width: characterVideoProductionRecipe.width, height: characterVideoProductionRecipe.height, orientation: characterVideoProductionRecipe.orientation })}</dd></div>
              {selectedItem ? <><div className="flex justify-between gap-3"><dt>{t("Workflow")}</dt><dd className="max-w-48 truncate">{selectedItem.lineage.workflowKey ?? t("Pending")}</dd></div><div className="flex justify-between gap-3"><dt>{t("Provider request")}</dt><dd className="max-w-48 truncate">{selectedItem.lineage.providerRequestId ?? t("Pending")}</dd></div></> : null}
            </dl>
          </details>
          {runs.length ? (
            <details className="mt-3 border-t border-[var(--ad-border)] pt-3">
              <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">{t("Video Run history")} ({runs.length})</summary>
              <div className="mt-3 grid gap-2" aria-label={t("Video Run history")}>
                {runs.map((run, index) => (
                  <button
                    className={cn("rounded-md px-3 py-2 text-left text-xs", selectedRun?.id === run.id ? "bg-[var(--ad-surface-subtle)] font-semibold" : "hover:bg-[var(--ad-surface-subtle)]")}
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    type="button"
                  >
                    <span>{t("Video")} {index + 1}</span>
                    <span className="mt-1 block truncate text-[var(--ad-text-muted)]">{new Date(run.updatedAt).toLocaleString(adminDateLocale(locale))}</span>
                  </button>
                ))}
              </div>
            </details>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
