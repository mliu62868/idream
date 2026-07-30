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
    <section
      aria-labelledby="character-video-title"
      className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
    >
      <div className="flex flex-col gap-4 border-b border-[var(--ad-border)] p-4 sm:p-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
            {t("Image-to-video")}
          </p>
          <h3 className="mt-1 text-xl font-semibold" id="character-video-title">
            {t("{name}'s videos", { name: data.character.name })}
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
            {t("Choose one Character image, describe the motion, then review the generated clip. Approval never publishes it automatically.")}
          </p>
        </div>
        <WorkspaceButton
          disabled={busy !== null}
          onClick={() => void refresh()}
        >
          <RefreshCcw className={cn("h-4 w-4", busy === "refresh" && "animate-spin")} />
          {t("Refresh")}
        </WorkspaceButton>
      </div>

      <dl className="grid border-b border-[var(--ad-border)] sm:grid-cols-3">
        {[
          ["Model", t(characterVideoProductionSpec.modelLabel)],
          [
            "Clip",
            t("{seconds} seconds · {fps} fps", {
              seconds: characterVideoProductionSpec.durationSeconds,
              fps: characterVideoProductionSpec.fps,
            }),
          ],
          [
            "Frame",
            t("{width}×{height} · {orientation}", {
              width: characterVideoProductionSpec.width,
              height: characterVideoProductionSpec.height,
              orientation: characterVideoProductionSpec.orientation,
            }),
          ],
        ].map(([label, value]) => (
          <div className="border-b border-[var(--ad-border)] px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0" key={label}>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
              {t(label)}
            </dt>
            <dd className="mt-1 text-sm font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      {error ? (
        <p className="m-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
          {t(error)}
        </p>
      ) : null}
      {message ? (
        <p className="m-4 rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">
          {t(message)}
        </p>
      ) : null}

      <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside aria-label={t("New Character video")}>
          <h4 className="font-semibold">{t("Create video")}</h4>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("One source image becomes one reviewable four-second clip.")}
          </p>
          {sources.length === 0 ? (
            <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
              <strong>{t("Create a Character image first")}</strong>
              <p className="mt-1 text-xs leading-5">
                {t("Video generation needs one available Character image as its first-frame authority.")}
              </p>
              <WorkspaceButton
                className="mt-3"
                onClick={onCreateImage}
                tone="primary"
              >
                <ImageIcon className="h-4 w-4" />
                {t("Create a Character image")}
              </WorkspaceButton>
            </div>
          ) : (
            <>
              <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Source image")}
                <select
                  className={`${fieldClass} mt-1`}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setPreferredSourceAssetId(event.target.value)}
                  value={sourceAssetId}
                >
                  {sources.map((source) => (
                    <option key={source.assetId} value={source.assetId}>
                      {t(source.label, source.labelValues)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-3 overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.03]">
                {selectedSource ? (
                  // The workspace source is already an authorized render URL.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={t("{name} video source", { name: data.character.name })}
                    className="aspect-[2/3] max-h-56 w-full object-cover"
                    src={selectedSource.thumbnailUrl ?? selectedSource.url}
                  />
                ) : (
                  <div className="grid min-h-40 place-items-center text-[var(--ad-text-muted)]">
                    <ImageIcon className="h-6 w-6" />
                  </div>
                )}
              </div>
            </>
          )}
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Motion brief")}
            <textarea
              className={`${textAreaClass} mt-1 min-h-32`}
              disabled={busy !== null}
              onChange={(event) => setBrief(event.target.value)}
              value={brief}
            />
          </label>
          <WorkspaceButton
            className="mt-4 w-full justify-center"
            disabled={
              loading ||
              busy !== null ||
              !permissions.create ||
              !sourceAssetId ||
              brief.trim().length === 0
            }
            onClick={() => void createVideo()}
            tone="primary"
          >
            {busy === "create"
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Sparkles className="h-4 w-4" />}
            {t("Create video")}
          </WorkspaceButton>
          {!permissions.create ? (
            <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
              {t("Creative Run write access is required.")}
            </p>
          ) : null}
        </aside>

        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
                {t("Latest video Run")}
              </p>
              <h4 className="mt-1 font-semibold">
                {selectedRun ? selectedRun.title : t("No video generated yet")}
              </h4>
            </div>
            {selectedRun ? (
              <div className="flex gap-2">
                <StatusBadge value={selectedRun.executionOutcome} />
                <StatusBadge value={selectedRun.reviewState} />
              </div>
            ) : null}
          </div>

          {loading ? (
            <div className="mt-4 grid min-h-72 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] text-sm text-[var(--ad-text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : selectedRun && selectedItem ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div>
                {selectedItem.asset ? (
                  <video
                    className="aspect-[2/3] max-h-[620px] w-full rounded-lg bg-black object-contain"
                    controls
                    playsInline
                    preload="metadata"
                    src={selectedItem.asset.url}
                  />
                ) : (
                  <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] text-center text-[var(--ad-text-muted)]">
                    <div>
                      {selectedItem.executionState === "failed"
                        ? <Video className="mx-auto h-7 w-7" />
                        : <Loader2 className="mx-auto h-7 w-7 animate-spin" />}
                      <p className="mt-3 text-sm font-semibold">
                        {t(videoExecutionLabel(selectedItem))}
                      </p>
                      <p className="mt-1 text-xs">
                        {t("Long video jobs remain active while this page polls their exact Run.")}
                      </p>
                    </div>
                  </div>
                )}
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-[var(--ad-text-muted)]">{t("Workflow")}</dt>
                    <dd className="mt-1 break-all">{selectedItem.lineage.workflowKey ?? t("Pending")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--ad-text-muted)]">{t("Provider request")}</dt>
                    <dd className="mt-1 break-all">{selectedItem.lineage.providerRequestId ?? t("Pending")}</dd>
                  </div>
                </dl>
              </div>

              {selectedItem.asset ? (
                <aside className="rounded-lg border border-[var(--ad-border)] p-4">
                  <h5 className="font-semibold">{t("Video review")}</h5>
                  {selectedItem.review ? (
                    <div className="mt-3 text-sm">
                      <StatusBadge
                        tone={selectedItem.review.decision === "approved" ? "good" : "bad"}
                        value={selectedItem.review.decision}
                      />
                      <p className="mt-3 leading-6">{selectedItem.review.reason}</p>
                      <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
                        {t("Identity")} {t(selectedItem.review.identityConsistency)}
                        {selectedItem.review.score !== null
                          ? ` · ${selectedItem.review.score}/100`
                          : ""}
                      </p>
                      <p className="mt-3 rounded-md bg-black/[0.035] p-3 text-xs leading-5 text-[var(--ad-text-muted)]">
                        {t("Approval keeps the clip in the Character video library. Publishing remains a separate future action.")}
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                        {t("Record what is visible. Approval requires every quality check and an identity score of at least {minimum}.", {
                          minimum: CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
                        })}
                      </p>
                      <fieldset className="mt-3 space-y-2">
                        <legend className="sr-only">{t("Video quality checks")}</legend>
                        {reviewChecks.map(([key, label]) => (
                          <label className="flex min-h-10 items-center gap-3 rounded-md border border-[var(--ad-border)] px-3 text-xs" key={key}>
                            <input
                              checked={reviewQuality[key]}
                              onChange={(event) => setReviewQuality((current) => ({
                                ...current,
                                [key]: event.target.checked,
                              }))}
                              type="checkbox"
                            />
                            <span>{t(label)}</span>
                          </label>
                        ))}
                      </fieldset>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                          {t("Identity")}
                          <select
                            className={`${fieldClass} mt-1`}
                            onChange={(event) => setIdentityConsistency(
                              event.target.value as "passed" | "failed",
                            )}
                            value={identityConsistency}
                          >
                            <option value="passed">{t("Passed")}</option>
                            <option value="failed">{t("Failed")}</option>
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                          {t("Score")}
                          <input
                            className={`${fieldClass} mt-1`}
                            max={100}
                            min={0}
                            onChange={(event) => setScore(event.target.value)}
                            step={1}
                            type="number"
                            value={score}
                          />
                        </label>
                      </div>
                      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                        {t("Evidence and reason")}
                        <textarea
                          className={`${textAreaClass} mt-1`}
                          onChange={(event) => setReviewReason(event.target.value)}
                          placeholder={t("Describe motion, identity stability, artifacts, and intent match")}
                          value={reviewReason}
                        />
                      </label>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <WorkspaceButton
                          disabled={
                            busy !== null ||
                            !permissions.review ||
                            !rejectionReady
                          }
                          onClick={() => void reviewVideo("rejected")}
                          tone="danger"
                        >
                          <ThumbsDown className="h-4 w-4" />
                          {t("Reject")}
                        </WorkspaceButton>
                        <WorkspaceButton
                          disabled={
                            busy !== null ||
                            !permissions.review ||
                            !approvalReady
                          }
                          onClick={() => void reviewVideo("approved")}
                          tone="primary"
                        >
                          {busy === "review"
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Check className="h-4 w-4" />}
                          {t("Approve video")}
                        </WorkspaceButton>
                      </div>
                    </>
                  )}
                </aside>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 grid min-h-72 place-items-center rounded-lg border border-dashed border-[var(--ad-border)] bg-black/[0.02] text-center text-[var(--ad-text-muted)]">
              <div>
                <Video className="mx-auto h-7 w-7" />
                <p className="mt-3 text-sm">{t("Create the first Character video from an image.")}</p>
              </div>
            </div>
          )}

          {runs.length > 1 ? (
            <details className="mt-4 rounded-lg border border-[var(--ad-border)] p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                {t("Video Run history")}
              </summary>
              <div className="mt-3 space-y-2">
                {runs.map((run) => (
                  <button
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-xs",
                      selectedRun?.id === run.id
                        ? "border-[var(--ad-ink)] bg-black/[0.035]"
                        : "border-[var(--ad-border)]",
                    )}
                    key={run.id}
                    onClick={() => void loadRun(run.id)}
                    type="button"
                  >
                    <span>{new Date(run.updatedAt).toLocaleString()}</span>
                    <StatusBadge value={run.executionOutcome} />
                  </button>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
