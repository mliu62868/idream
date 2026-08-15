"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import {
  characterQaAuthorityMatches,
  type CharacterQaCheckInput,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { useRef, useState } from "react";
import { characterQaMutation } from "@/features/image-workflow-transport";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { cn } from "@/lib/utils";
import {
  currentWorkspaceQaAuthority,
  latestQaRunForCurrentWorkspaceAuthority,
} from "./character-qa-authority";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

const qaCheckKeys: readonly CharacterQaCheckInput["key"][] = [
  "explore_feed_card_desktop",
  "explore_feed_card_mobile",
  "character_detail_desktop",
  "character_detail_mobile",
  "opening_message",
  "five_turn_conversation",
  "chat_image",
];

type CharacterQaCheckDraft = Omit<CharacterQaCheckInput, "result"> & {
  result: "" | CharacterQaCheckInput["result"];
};

const previewChangeLabels: Record<string, string> = {
  new_release: "First release",
  name: "Character name",
  description: "Description",
  persona: "Persona",
  opening: "Opening message",
  appearance: "Appearance",
  imageUrl: "Cover image",
  assetPack: "Image pack",
};

export function releasePreviewChangeSummary(changedFields: readonly string[]) {
  return {
    firstRelease: changedFields.includes("new_release"),
    labels: changedFields.map((field) => previewChangeLabels[field] ?? field.replaceAll("_", " ")),
  };
}

function ReleaseChangeSummary({ changedFields }: { changedFields: readonly string[] }) {
  const { t } = useAdminI18n();
  const summary = releasePreviewChangeSummary(changedFields);
  const message = summary.firstRelease
    ? "First release — nothing is live yet."
    : summary.labels.length
      ? "{count} areas differ from Live."
      : "No draft changes detected.";
  return (
    <section
      aria-labelledby="release-change-summary-title"
      className="mb-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
      data-testid="release-change-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" id="release-change-summary-title">
          {t("Release change summary")}
        </h2>
        <span className="text-xs font-semibold tabular-nums text-[var(--ad-text-muted)]">
          {summary.labels.length}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
        {t(message, { count: summary.labels.length })}
      </p>
      {summary.labels.length ? (
        <div className="mt-3 flex flex-wrap gap-2" aria-label={t("Changed fields")}>
          {summary.labels.map((label) => (
            <StatusBadge key={label} tone="warn" value={label} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function PreviewDiff({
  data,
  permissions,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: CharacterWorkspacePermissions;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const snapshots = [data.preview.live, data.preview.draft].filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  // INTENT: 「哪个 Release 是候选」由服务端 journey 投影判定。前端曾用一张**包含**列表
  // （draft/validating/in_review/approved）重推，服务端用的是**排除**列表
  // （非 published/superseded/withdrawn）——同一个集合的两种编码，往状态机里加一个状态时
  // 两边不会同时更新，而且谁都不会报错。
  const activeReleaseCandidate = data.releases.find(
    ({ release }) => release.id === data.journey.release.candidateReleaseId,
  );
  const [checks, setChecks] = useState<CharacterQaCheckDraft[]>(() =>
    qaCheckKeys.map((key) => ({
      key,
      result: "",
      evidenceRef: "",
      comment: "",
      fixDeepLink: `/admin/characters/${data.character.id}?tab=preview`,
    })),
  );
  const [reason, setReason] = useState(() =>
    t("Record renderer and conversation QA evidence"),
  );
  const [busy, setBusy] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const qaIdempotencyKeys = useRef<Record<string, string>>({});
  const draftAssetRouteAllowsQa = data.project.draftAssetRouteAuthority.qaReady;
  const exactDraftAssetPackAllowsQa =
    draftAssetRouteAllowsQa && data.preview.draft.assetPackReady;
  const draftAssetPackIsStale =
    data.project.draftAssetRouteAuthority.qaBlockers.includes(
      "draft_asset_generation_route_stale",
    );
  const updateCheck = (
    key: CharacterQaCheckInput["key"],
    patch: Partial<CharacterQaCheckDraft>,
  ) => {
    setChecks((current) =>
      current.map((check) =>
        check.key === key ? { ...check, ...patch } : check,
      ),
    );
  };
  const recordQa = async () => {
    setBusy(true);
    setQaError(null);
    if (checks.some((check) => !check.result)) {
      setQaError(
        "Choose Passed or Failed for every QA check before recording immutable evidence.",
      );
      setBusy(false);
      return;
    }
    const submittedChecks = checks.map((check) => ({
      ...check,
      result: check.result as CharacterQaCheckInput["result"],
    }));
    const requestSignature = JSON.stringify({
      characterId: data.character.id,
      entityVersion: data.project.version,
      checks: submittedChecks,
      reason,
    });
    const idempotencyKey =
      qaIdempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    qaIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      const mutation = characterQaMutation(
        data.character.id,
        data.project.version,
        submittedChecks,
        reason,
        idempotencyKey,
      );
      await runCommittedMutation({
        action: "Character QA Run",
        commit: () => adminV2Operation(mutation.operationId, mutation.options),
        afterRefresh: () => {
          delete qaIdempotencyKeys.current[requestSignature];
        },
      });
    } catch (cause) {
      setQaError(
        cause instanceof Error ? cause.message : "Could not record QA evidence",
      );
    } finally {
      setBusy(false);
    }
  };
  const latestAuthorityQaRun = exactDraftAssetPackAllowsQa
    ? latestQaRunForCurrentWorkspaceAuthority(data.qaRuns, data)
    : null;
  if (!exactDraftAssetPackAllowsQa) {
    return (
      <div className="space-y-5">
        <section
          aria-labelledby="launch-preview-next-action"
          className="flex flex-col gap-4 rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] p-4 text-[var(--ad-yellow-text)] sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <h2 className="font-semibold" id="launch-preview-next-action">
              {t("Launch preview is waiting for the image pack")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6">
              {t(
                draftAssetPackIsStale
                  ? "Regenerate the stale image selections under the current route, then return here to compare live and draft."
                  : "Complete the cover, hero, and chat images under the current route, then return here to compare live and draft.",
              )}
            </p>
          </div>
          <Link
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-current px-3 text-sm font-semibold"
            href={`/admin/characters/${data.character.id}?tab=assets`}
          >
            {t(
              draftAssetPackIsStale
                ? "Regenerate current image pack"
                : "Complete image assets",
            )}
          </Link>
        </section>

        <section aria-labelledby="blocked-preview-comparison">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold" id="blocked-preview-comparison">
              {t("Current and draft assets")}
            </h2>
          </div>
          <ReleaseChangeSummary changedFields={data.preview.changedFields} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {snapshots.map((snapshot) => {
              const cover = snapshot.assetPack.character_cover;
              // SPEC: 完成度只读服务端 journey 投影，不数 preview 快照的槽位。
              // INTENT: preview.draft.assetPack 没做路线过滤，数出来的「齐了」和上面那条
              // 「图池 0/3」告警来自两套口径，同一屏能并存两个互相打脸的结论。
              const missing = (
                snapshot.label === "Live"
                  ? data.journey.assetPack.live
                  : data.journey.assetPack.draft
              ).missingPurposes.length;
              return (
                <article
                  className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3"
                  key={snapshot.label}
                >
                  <figure className="aspect-[4/5] overflow-hidden rounded-md bg-black/[0.04]">
                    {cover.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
                      <img
                        alt={t("{name} {snapshot}", {
                          name: snapshot.name,
                          snapshot: t(snapshot.label),
                        })}
                        className="h-full w-full object-cover"
                        src={cover.imageUrl}
                      />
                    ) : null}
                  </figure>
                  <div className="min-w-0">
                    <strong className="text-sm">{t(snapshot.label)}</strong>
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                      {missing === 0
                        ? t("Image pack complete")
                        : t("{count} image slots missing", { count: missing })}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    );
  }
  return (
    <div>
      <ReleaseChangeSummary changedFields={data.preview.changedFields} />
      {exactDraftAssetPackAllowsQa ? (
        <section aria-labelledby="real-renderer-preview-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="font-semibold" id="real-renderer-preview-title">
                {t("Real user-surface renderer")}
              </h2>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {t(
                  "Short-lived signed snapshots render in main without mutating Serving, chats, or assets.",
                )}
              </p>
            </div>
            <StatusBadge value="read only" />
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {snapshots.map((snapshot) => (
              <article
                className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
                key={`renderer-${snapshot.label}`}
              >
                <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-4 py-3">
                  <strong className="text-xs uppercase tracking-wide">
                    {t(snapshot.label)}
                  </strong>
                  <span className="text-xs text-[var(--ad-text-muted)]">
                    {t("Desktop + responsive mobile layout")}
                  </span>
                </div>
                {snapshot.renderUrl ? (
                  <iframe
                    className="h-[760px] w-full bg-[rgb(13,13,13)]"
                    loading="lazy"
                    sandbox="allow-scripts allow-same-origin"
                    src={snapshot.renderUrl}
                    title={t("{label} real frontend renderer", {
                      label: t(snapshot.label),
                    })}
                  />
                ) : (
                  <div className="p-6 text-sm text-[var(--ad-text-muted)]">
                    {snapshot.contentVersionId
                      ? t(
                          "Renderer unavailable: avatar, hero, and chat must each resolve to their exact operational asset.",
                        )
                      : t(
                          "Renderer unavailable until an immutable ContentVersion exists.",
                        )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <details className="mt-5 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer p-4 font-semibold">
          {t("Current and draft assets")}
        </summary>
        <div className="grid gap-4 border-t border-[var(--ad-border)] p-4 lg:grid-cols-2">
        {snapshots.map((snapshot) => (
          <article
            className={cn(
              "overflow-hidden rounded-xl border bg-[var(--ad-surface)]",
              snapshot.label === "Draft Preview"
                ? "border-[var(--ad-yellow-text)]"
                : "border-[var(--ad-border)]",
            )}
            key={snapshot.label}
          >
            <div className="border-b border-[var(--ad-border)] px-4 py-3 text-xs font-semibold uppercase tracking-wide">
              {t(snapshot.label)}
            </div>
            <div className="p-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["character_cover", "Avatar / discovery", "aspect-[4/5]"],
                    ["character_hero", "Character hero", "aspect-video"],
                    ["character_chat", "Chat image", "aspect-[4/5]"],
                  ] as const
                ).map(([purpose, label, aspect]) => {
                  const slot = snapshot.assetPack[purpose];
                  return (
                    <figure
                      className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.04]"
                      key={purpose}
                    >
                      <div
                        className={cn(
                          "grid place-items-center overflow-hidden",
                          aspect,
                        )}
                      >
                        {slot.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
                          <img
                            alt={t("{name} {slot} {snapshot}", {
                              name: snapshot.name,
                              slot: t(label),
                              snapshot: t(snapshot.label),
                            })}
                            className="h-full w-full object-cover"
                            src={slot.imageUrl}
                          />
                        ) : (
                          <span className="px-3 text-center text-xs font-semibold text-[var(--ad-text-muted)]">
                            {slot.status === "missing"
                              ? t("{label} not selected", { label: t(label) })
                              : t("{label} unavailable", { label: t(label) })}
                          </span>
                        )}
                      </div>
                      <figcaption className="border-t border-[var(--ad-border)] px-3 py-2 text-[11px]">
                        <strong>{t(label)}</strong>
                        <span className="mt-0.5 block break-all text-[var(--ad-text-muted)]">
                          {slot.assetId ?? t("No asset ID")}
                        </span>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              <div className="mt-4">
                <h3 className="text-lg font-semibold">{snapshot.name}</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">
                  {snapshot.description}
                </p>
                <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide">
                  {t("Opening")}
                </h4>
                <p className="mt-2 text-sm">
                  {String(snapshot.opening.firstMessage ?? t("Unavailable"))}
                </p>
                <details className="mt-5 text-xs">
                  <summary className="cursor-pointer font-semibold">
                    {t("Immutable evidence")}
                  </summary>
                  <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-black/[0.04] p-3">
                    {JSON.stringify(
                      {
                        releaseId: snapshot.releaseId,
                        contentVersionId: snapshot.contentVersionId,
                        assetPack: snapshot.assetPack,
                        persona: snapshot.persona,
                        appearance: snapshot.appearance,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            </div>
          </article>
        ))}
        </div>
      </details>
      <details
        className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
      >
        <summary className="flex cursor-pointer items-center justify-between gap-3 p-4">
          <span className="font-semibold" id="character-qa-title">
            {t("Launch QA")}
          </span>
          <StatusBadge value={`${data.qaRuns.length} runs`} />
        </summary>
        <div className="border-t border-[var(--ad-border)] p-4">
          {activeReleaseCandidate ? (
            <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
              {t("Release")} {activeReleaseCandidate.release.id} {t("is")}{" "}
              {activeReleaseCandidate.release.status}
              {t(
                ". Request changes to withdraw it before recording another QA Run.",
              )}
            </p>
          ) : null}
          {!exactDraftAssetPackAllowsQa ? (
            <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
              {!data.preview.draft.assetPackReady && draftAssetRouteAllowsQa
                ? t(
                    "The selected image pack contains a missing or unavailable exact asset.",
                  )
                : draftAssetPackIsStale
                  ? t(
                      "The selected image pack was generated under an older route.",
                    )
                  : t(
                      "QA requires a complete cover, hero, and chat image pack under the current effective route.",
                    )}{" "}
              <Link
                className="font-semibold underline"
                href={`/admin/characters/${data.character.id}?tab=assets`}
              >
                {draftAssetPackIsStale
                  ? t("Regenerate under current route")
                  : t("Complete Character Assets")}
              </Link>{" "}
              {t("before recording QA.")}
            </p>
          ) : null}
          <div className="mt-4 grid gap-3">
            {checks.map((check) => (
              <fieldset
                className="grid gap-2 rounded-lg border border-[var(--ad-border)] p-3 sm:grid-cols-[190px_120px_1fr]"
                disabled={
                  !permissions.reviewRelease ||
                  busy ||
                  Boolean(activeReleaseCandidate) ||
                  !exactDraftAssetPackAllowsQa
                }
                key={check.key}
              >
                <legend className="sr-only">{check.key}</legend>
                <div className="text-xs font-semibold">
                  {t(check.key.replaceAll("_", " "))}
                </div>
                <select
                  aria-label={t("{check} result", {
                    check: t(check.key.replaceAll("_", " ")),
                  })}
                  className={fieldClass}
                  onChange={(event) =>
                    updateCheck(check.key, {
                      result: event.target
                        .value as CharacterQaCheckDraft["result"],
                    })
                  }
                  value={check.result}
                >
                  <option value="">{t("Not run")}</option>
                  <option value="failed">{t("Failed")}</option>
                  <option value="passed">{t("Passed")}</option>
                </select>
                <input
                  aria-label={t("{check} evidence reference", {
                    check: t(check.key.replaceAll("_", " ")),
                  })}
                  className={fieldClass}
                  onChange={(event) =>
                    updateCheck(check.key, { evidenceRef: event.target.value })
                  }
                  placeholder={t("Evidence URL or durable reference")}
                  value={check.evidenceRef}
                />
                <textarea
                  aria-label={t("{check} comment", {
                    check: t(check.key.replaceAll("_", " ")),
                  })}
                  className={`${textAreaClass} sm:col-span-3`}
                  onChange={(event) =>
                    updateCheck(check.key, { comment: event.target.value })
                  }
                  value={check.comment}
                />
              </fieldset>
            ))}
          </div>
          <div className="mt-6 rounded-lg border border-[var(--ad-border)] p-4">
            <h4 className="font-semibold">{t("Character Soul Behavior Evaluation")}</h4>
            <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
              {t("Submitting QA runs the versioned behavior evaluator and every distinct production Chat profile on the server. Transcripts, timings, adapter identity, and hashes are recorded automatically.")}
            </p>
          </div>
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("QA reason")}
            <input
              className={`${fieldClass} mt-1`}
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
          </label>
          {qaError ? (
            <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">
              {qaError}
            </p>
          ) : null}
          <div className="mt-4">
            <WorkspaceButton
              disabled={
                !permissions.reviewRelease ||
                busy ||
                Boolean(activeReleaseCandidate) ||
                !exactDraftAssetPackAllowsQa ||
                checks.some(
                  (check) => !check.result || !check.evidenceRef.trim(),
                )
              }
              onClick={() => void recordQa()}
              tone="primary"
            >
              {t("Record immutable QA Run")}
            </WorkspaceButton>
          </div>
          <div className="mt-5 grid gap-2">
            {data.qaRuns.map((run) => {
              const authorityMatches =
                exactDraftAssetPackAllowsQa &&
                characterQaAuthorityMatches(
                  run,
                  currentWorkspaceQaAuthority(data),
                );
              const authorityLabel =
                latestAuthorityQaRun?.id === run.id
                  ? "current authority"
                  : authorityMatches
                    ? "superseded"
                    : "stale";
              return (
                <article
                  className="rounded-lg bg-black/[0.04] p-3 text-xs"
                  key={run.id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge value={run.status} />
                    <StatusBadge
                      tone={
                        authorityLabel === "current authority" &&
                        run.status === "passed"
                          ? "good"
                          : "warn"
                      }
                      value={authorityLabel}
                    />
                    <strong>{run.id}</strong>
                    <span className="text-[var(--ad-text-muted)]">
                      {t("owner")} {run.ownerId} {t("· ContentVersion")}{" "}
                      {run.characterContentVersionId}
                    </span>
                  </div>
                  <p className="mt-2 text-[var(--ad-text-muted)]">
                    {t("Identity v")}
                    {run.visualProfileVersion ?? t("legacy")}{" "}
                    {t("· Reference r")}
                    {run.referenceSetRevision ?? t("legacy")}{" "}
                    {t("· Asset pack")}{" "}
                    {run.draftAssetPackHash?.slice(0, 12) ?? t("legacy")}
                  </p>
                  <p className="mt-2 break-all text-[var(--ad-text-muted)]">
                    {t("Evidence hash")} {run.evidenceHash}
                  </p>
                  <details className="mt-3 border-t border-black/10 pt-3">
                    <summary className="cursor-pointer font-semibold">
                      {t("Checks, evidence, and repair paths")}
                    </summary>
                    <div className="mt-2 grid gap-2">
                      {run.checks.map((check) => (
                        <div
                          className="rounded-md bg-white/60 p-2"
                          key={check.key}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <strong>{t(check.key.replaceAll("_", " "))}</strong>
                            <StatusBadge value={check.result} />
                          </div>
                          <p className="mt-1 text-[var(--ad-text-muted)]">
                            {check.comment}
                          </p>
                          <p className="mt-1 break-all">
                            {t("Evidence:")} {check.evidenceRef}
                          </p>
                          <Link
                            className="mt-1 inline-block font-semibold underline"
                            href={check.fixDeepLink}
                          >
                            {t("Open fix path")}
                          </Link>
                        </div>
                      ))}
                    </div>
                    {run.behaviorEvaluation ? (
                      <div className="mt-4 border-t border-black/10 pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{t("Character Soul Behavior Evaluation")}</strong>
                          <span className="text-[var(--ad-text-muted)]">
                            {run.behaviorEvaluation.suiteVersion} · {run.behaviorEvaluation.evaluatorVersion}
                          </span>
                        </div>
                        <div className="mt-2 grid gap-2">
                          {run.behaviorEvaluation.cases.map((behaviorCase) => (
                            <details
                              className="rounded-md bg-white/60 p-2"
                              key={behaviorCase.key}
                            >
                              <summary className="cursor-pointer">
                                <span className="flex flex-wrap items-center justify-between gap-2">
                                  <strong>{t(behaviorCase.key.replaceAll("_", " "))}</strong>
                                  <span className="flex items-center gap-2">
                                    <StatusBadge value={behaviorCase.gate} />
                                    <StatusBadge value={behaviorCase.result} />
                                  </span>
                                </span>
                              </summary>
                              {behaviorCase.prompt ? (
                                <p className="mt-2 whitespace-pre-wrap">
                                  <strong>{t("Prompt:")}</strong> {behaviorCase.prompt}
                                </p>
                              ) : null}
                              {behaviorCase.response ? (
                                <p className="mt-2 whitespace-pre-wrap text-[var(--ad-text-muted)]">
                                  <strong>{t("Response:")}</strong> {behaviorCase.response}
                                </p>
                              ) : null}
                              {behaviorCase.rationale ? (
                                <p className="mt-2 text-[var(--ad-text-muted)]">
                                  <strong>{t("Rationale:")}</strong> {behaviorCase.rationale}
                                </p>
                              ) : null}
                              <p className="mt-2 break-all">
                                {t("Evidence:")} {behaviorCase.evidenceRef}
                              </p>
                            </details>
                          ))}
                        </div>
                        {run.behaviorEvaluation.distinctiveness ? (
                          <div className="mt-3 rounded-md bg-white/60 p-2">
                            <strong>{t("Official character pairwise distinctiveness")}</strong>
                            <p className="mt-1 text-[var(--ad-text-muted)]">
                              {run.behaviorEvaluation.distinctiveness.suiteVersion} · {run.behaviorEvaluation.distinctiveness.profile.provider} / {run.behaviorEvaluation.distinctiveness.profile.model}
                            </p>
                            <div className="mt-2 grid gap-2">
                              {run.behaviorEvaluation.distinctiveness.comparisons.map((comparison) => (
                                <div
                                  className="rounded border border-black/10 p-2"
                                  key={comparison.peerCharacterContentVersionId}
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="break-all">
                                      {comparison.peerCharacterId} · {comparison.peerCharacterContentVersionId}
                                    </span>
                                    <StatusBadge value={comparison.result} />
                                  </div>
                                  <p className="mt-1 text-[var(--ad-text-muted)]">
                                    {comparison.rationale}
                                  </p>
                                  <p className="mt-1 break-all text-[var(--ad-text-muted)]">
                                    {Object.entries(comparison.dimensions)
                                      .map(([key, passed]) => `${key}=${passed ? "pass" : "fail"}`)
                                      .join(" · ")}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="mt-3 text-[var(--ad-amber-text)]">
                            {t("Historical QA Run predates pairwise distinctiveness evidence.")}
                          </p>
                        )}
                      </div>
                    ) : null}
                    {run.liveCanaries ? (
                      <div className="mt-4 border-t border-black/10 pt-3">
                        <strong>{t("Exact production model canaries")}</strong>
                        <div className="mt-2 grid gap-2">
                          {run.liveCanaries.map((canary) => (
                            <div
                              className="rounded-md bg-white/60 p-2"
                              key={`${canary.tier}:${canary.provider}:${canary.model}`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span>
                                  {canary.tier} · {canary.adapter} · {canary.provider} / {canary.model}
                                </span>
                                <StatusBadge value={canary.result} />
                              </div>
                              <p className="mt-1 text-[var(--ad-text-muted)]">
                                {t("First token {first}ms · total {total}ms · {temperature}", {
                                  first: Math.round(canary.firstTokenMs),
                                  total: Math.round(canary.totalMs),
                                  temperature: t(canary.coldStart ? "cold" : "warm"),
                                })}
                              </p>
                              <p className="mt-1 break-all text-[var(--ad-text-muted)]">
                                {t("Evidence:")} {canary.evidenceRef}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </details>
                </article>
              );
            })}
          </div>
        </div>
      </details>
    </div>
  );
}
