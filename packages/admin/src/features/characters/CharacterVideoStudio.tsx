"use client";

import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  characterVideoProductionSpec,
  creativeReviewDecisionRequestSchema,
  creativeReviewDecisionResultSchema,
  creativeRunCreateRequestSchema,
  creativeRunCreateResultSchema,
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CharacterWorkspaceDetail,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Request } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";

type CharacterVideoPermissions = {
  readonly read: boolean;
  readonly create: boolean;
  readonly review: boolean;
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

function newIdempotencyKey() {
  return `character-video-${crypto.randomUUID()}`;
}

export function CharacterVideoStudio({
  data,
  onCreateImage,
  permissions,
}: {
  readonly data: CharacterWorkspaceDetail;
  readonly onCreateImage: () => void;
  readonly permissions: CharacterVideoPermissions;
}) {
  const { t } = useAdminI18n();
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
  const [runs, setRuns] = useState<CreativeRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<CreativeRunDetail | null>(null);
  const [loading, setLoading] = useState(permissions.read);
  const [busy, setBusy] = useState<"create" | "review" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewQuality, setReviewQuality] =
    useState<ReviewQuality>(emptyReviewQuality);
  const [identityConsistency, setIdentityConsistency] =
    useState<"passed" | "failed">("passed");
  const [score, setScore] = useState("90");
  const [reviewReason, setReviewReason] = useState("");
  const createIdempotencyKey = useRef(newIdempotencyKey());
  const reviewIdempotencyKey = useRef(newIdempotencyKey());

  const loadRun = useCallback(async (runId: string) => {
    const detail = await adminV2Request(
      `/api/v2/admin/creative/runs/${runId}`,
      { schema: creativeRunDetailSchema },
    );
    if (
      detail.purpose !== "character_video" ||
      detail.target.type !== "character" ||
      detail.target.id !== data.character.id
    ) {
      throw new Error("The selected video Run does not belong to this Character.");
    }
    setSelectedRun(detail);
    setRuns((current) =>
      current.some((run) => run.id === detail.id)
        ? current
        : [detail, ...current]
    );
    return detail;
  }, [data.character.id]);

  const loadRuns = useCallback(async () => {
    if (!permissions.read) return [];
    const query = new URLSearchParams({
      limit: "20",
      targetType: "character",
      targetId: data.character.id,
      sort: "updated_desc",
    });
    const response = await adminV2Request(
      `/api/v2/admin/creative/runs?${query}`,
      { schema: creativeRunListResponseSchema },
    );
    const videoRuns = [...response.items].filter(
      (run) => run.purpose === "character_video",
    );
    setRuns(videoRuns);
    if (videoRuns[0]) await loadRun(videoRuns[0].id);
    else setSelectedRun(null);
    return videoRuns;
  }, [data.character.id, loadRun, permissions.read]);

  useEffect(() => {
    if (!permissions.read) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        await loadRuns();
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Character videos could not be loaded",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadRuns, permissions.read]);

  const shouldPoll =
    selectedRun !== null &&
    ["pending", "running"].includes(selectedRun.executionOutcome);
  useEffect(() => {
    if (!selectedRun || !shouldPoll) return;
    const runId = selectedRun.id;
    const timer = window.setInterval(() => {
      void loadRun(runId).catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Video progress could not be refreshed",
        );
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadRun, selectedRun, shouldPoll]);

  const createVideo = async () => {
    if (!permissions.create || !sourceAssetId) return;
    const body = creativeRunCreateRequestSchema.parse({
      title: `${data.character.name} motion portrait`,
      purpose: "character_video",
      targetType: "character",
      targetId: data.character.id,
      profileId: characterVideoProductionSpec.profileKey,
      referenceAssetIds: [sourceAssetId],
      orientation: characterVideoProductionSpec.orientation,
      count: characterVideoProductionSpec.outputCount,
      brief,
      consistencyMode: "balanced",
      priority: "normal",
      reason: "Create one reviewable Character video candidate",
    });
    setBusy("create");
    setError(null);
    setMessage(null);
    try {
      const result = await adminV2Request("/api/v2/admin/creative/runs", {
        method: "POST",
        idempotencyKey: createIdempotencyKey.current,
        schema: creativeRunCreateResultSchema,
        body,
      });
      createIdempotencyKey.current = newIdempotencyKey();
      await loadRun(result.batch.id);
      setMessage(
        "Video generation started. This page will keep the progress current.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Video generation could not start",
      );
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      if (selectedRun) await loadRun(selectedRun.id);
      else await loadRuns();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Character videos could not be refreshed",
      );
    } finally {
      setBusy(null);
    }
  };

  const selectedItem = selectedRun?.items[0] ?? null;
  const selectedSource =
    sources.find((source) => source.assetId === sourceAssetId) ?? null;
  const numericScore = Number(score);
  const approvalReady =
    Object.values(reviewQuality).every(Boolean) &&
    identityConsistency === "passed" &&
    Number.isInteger(numericScore) &&
    numericScore >= CHARACTER_IDENTITY_APPROVAL_MIN_SCORE &&
    numericScore <= 100 &&
    reviewReason.trim().length >= 3;
  const rejectionReady = reviewReason.trim().length >= 3;

  const reviewVideo = async (decision: "approved" | "rejected") => {
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
    setBusy("review");
    setError(null);
    setMessage(null);
    try {
      await adminV2Request(
        `/api/v2/admin/creative/runs/${selectedRun.id}/items/${selectedItem.id}/decisions`,
        {
          method: "POST",
          idempotencyKey: reviewIdempotencyKey.current,
          schema: creativeReviewDecisionResultSchema,
          body,
        },
      );
      reviewIdempotencyKey.current = newIdempotencyKey();
      await loadRun(selectedRun.id);
      setMessage(
        decision === "approved"
          ? "Video approved for the Character video library. Nothing was published automatically."
          : "Video rejected. The immutable decision remains in Run history.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Video review could not be saved",
      );
    } finally {
      setBusy(null);
    }
  };

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
      {error ? <p className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t(error)}</p> : null}
      {message ? <p className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">{t(message)}</p> : null}

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
                <video className="h-[360px] w-full rounded-lg bg-black object-contain sm:aspect-[4/3] sm:h-auto sm:max-h-[620px]" controls playsInline preload="metadata" src={selectedItem.asset.url} />
              ) : (
                <div className="grid min-h-96 place-items-center rounded-lg border border-[var(--ad-border)] bg-black/[0.02] text-center text-[var(--ad-text-muted)]">
                  <div>
                    {selectedItem.executionState === "failed" ? <Video className="mx-auto h-7 w-7" /> : <Loader2 className="mx-auto h-7 w-7 animate-spin" />}
                    <p className="mt-3 text-sm font-semibold">{t(videoExecutionLabel(selectedItem))}</p>
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
                  <select className={fieldClass} disabled={busy !== null} onChange={(event) => setPreferredSourceAssetId(event.target.value)} value={sourceAssetId}>
                    {sources.map((source) => <option key={source.assetId} value={source.assetId}>{t(source.label, source.labelValues)}</option>)}
                  </select>
                </span>
              </label>
            )}
            <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Motion brief")}
              <textarea className={`${textAreaClass} mt-1 min-h-32`} disabled={busy !== null} onChange={(event) => setBrief(event.target.value)} value={brief} />
            </label>
            <WorkspaceButton className="mt-4 w-full justify-center" disabled={loading || busy !== null || !permissions.create || !sourceAssetId || brief.trim().length === 0} onClick={() => void createVideo()} tone="primary">
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{t("Create video")}
            </WorkspaceButton>
          </div>
          <details className="mt-4 border-t border-[var(--ad-border)] pt-3 text-xs">
            <summary className="cursor-pointer font-semibold text-[var(--ad-text-muted)]">{t("Model")}</summary>
            <dl className="mt-3 grid gap-2 text-[var(--ad-text-muted)]">
              <div className="flex justify-between gap-3"><dt>{t("Model")}</dt><dd className="font-semibold text-[var(--ad-ink)]">{t(characterVideoProductionSpec.modelLabel)}</dd></div>
              <div className="flex justify-between gap-3"><dt>{t("Clip")}</dt><dd>{t("{seconds} seconds · {fps} fps", { seconds: characterVideoProductionSpec.durationSeconds, fps: characterVideoProductionSpec.fps })}</dd></div>
              <div className="flex justify-between gap-3"><dt>{t("Frame")}</dt><dd>{t("{width}×{height} · {orientation}", { width: characterVideoProductionSpec.width, height: characterVideoProductionSpec.height, orientation: characterVideoProductionSpec.orientation })}</dd></div>
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
                    onClick={() => void loadRun(run.id)}
                    type="button"
                  >
                    <span>{t("Video")} {index + 1}</span>
                    <span className="mt-1 block truncate text-[var(--ad-text-muted)]">{new Date(run.updatedAt).toLocaleString()}</span>
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
