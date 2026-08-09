"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { Clock3, Rocket, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  characterReleaseProposalMutation,
  characterReleaseReviewMutation,
} from "@/features/image-workflow-transport";
import {
  EmptyWorkspace,
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import {
  adminV2Operation,
  adminV2OperationEndpoint,
} from "@/lib/admin-v2-operation";
import type {
  CharacterCommandJournal,
  CharacterCommandSubmission,
} from "./character-command-journal";
import {
  latestQaRunForCurrentWorkspaceAuthority,
  releasableQaRunForCurrentWorkspaceAuthority,
} from "./character-qa-authority";
import { characterReleaseOrdinals } from "./character-workspace-format";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

function commandSubmissionMessage(
  outcome: Exclude<CharacterCommandSubmission, { readonly kind: "accepted" }>,
  action: string,
) {
  if (outcome.kind === "attached") {
    return `${outcome.command.action} is already active. This workspace attached to that command instead of accepting another one.`;
  }
  return outcome.cause instanceof Error
    ? outcome.cause.message
    : `${action} acceptance is unknown. The same command will be replayed safely.`;
}

type CharacterReleaseItem = CharacterWorkspaceDetail["releases"][number];

function ReleaseSummary({
  item,
  ordinal,
  serving,
}: {
  item: CharacterReleaseItem;
  ordinal: number | undefined;
  serving: boolean;
}) {
  const { t } = useAdminI18n();
  const { release, checks } = item;
  const historical = ["superseded", "withdrawn"].includes(release.status);
  return (
    <article className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <strong>
          {t("Release")} #{ordinal ?? "?"}
        </strong>
        {release.publishedAt ? (
          <span className="text-xs text-[var(--ad-text-muted)]">
            {release.publishedAt.slice(0, 10)}
          </span>
        ) : null}
        <StatusBadge value={release.status} />
        {!historical ? <StatusBadge value={release.readiness} /> : null}
        {serving ? <StatusBadge tone="good" value="serving now" /> : null}
      </div>
      {checks.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {checks.map((check) => (
            <div
              className="flex items-center justify-between rounded bg-black/[0.03] px-3 py-2 text-xs"
              key={check.checkKey}
            >
              <span>{check.checkKey}</span>
              <StatusBadge value={check.result} />
            </div>
          ))}
        </div>
      ) : null}
      <details className="mt-3 border-t border-[var(--ad-border)] pt-3">
        <summary className="cursor-pointer text-xs font-semibold">
          {t("Technical evidence")}
        </summary>
        <p className="mt-2 break-all text-xs text-[var(--ad-text-muted)]">
          {release.id} · {t("Snapshot")} {release.snapshotHash.slice(0, 16)} ·{" "}
          {t("content")} {release.characterContentVersionId} · {t("row version")}{" "}
          {release.version}
        </p>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.035] p-3 text-[11px] leading-5">
          {JSON.stringify(
            {
              releasePlacementManifest: release.releasePlacementManifest,
              generationProvenance: release.generationProvenance,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}

export function characterReleaseConfirmationVisible(input: {
  readonly hasCandidate: boolean;
  readonly hasReleasableQaRun: boolean;
  readonly servingState: string | null;
}) {
  return input.hasCandidate ||
    input.hasReleasableQaRun ||
    input.servingState === "live" ||
    input.servingState === "paused";
}

export function ReleasePanel({
  data,
  permissions,
  journal,
  writesLocked,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: CharacterWorkspacePermissions;
  journal: CharacterCommandJournal;
  writesLocked: boolean;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const releaseOrdinals = useMemo(
    () => characterReleaseOrdinals(data.releases),
    [data.releases],
  );
  const liveAssetPackGap =
    data.journey.assetPack.live.total - data.journey.assetPack.live.completed;
  const candidate = data.releases.find(
    ({ release }) =>
      !["published", "superseded", "withdrawn"].includes(release.status),
  );
  const current = data.releases.find(
    ({ release }) => release.id === data.serving?.currentReleaseId,
  );
  const history = data.releases.filter(
    ({ release }) =>
      release.id !== current?.release.id &&
      release.id !== candidate?.release.id,
  );
  const rollbackSources = data.releases.filter(
    ({ release }) =>
      release.id !== current?.release.id && release.status === "superseded",
  );
  const [reason, setReason] = useState(() =>
    t("Operator verified release evidence"),
  );
  const [selectedQaRunId, setSelectedQaRunId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [selectedRollbackSourceId, setSelectedRollbackSourceId] = useState("");
  // SPEC: 发布类操作仍需明确确认（不可逆、对外可见），但确认方式是勾选，不是默写内部 ID。
  // INTENT: 原先 8 个按钮共用一个输入框、各自要求不同的精确 token（{id}:{releaseId}:approved …），
  // 敲对了按钮才启用——这是全工作台最重的一道人工负担，且同文件的视觉区早已是「勾选 → 程序化填」。
  // 统一到那个惯例：运营勾一次，token 由代码按动作生成。
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposalIdempotencyKeys = useRef<Record<string, string>>({});
  const validationIdempotencyKeys = useRef<Record<string, string>>({});
  const releaseReviewIdempotencyKeys = useRef<Record<string, string>>({});

  const command = async (
    kind: "publish" | "schedule" | "rollback",
    releaseId: string,
    version: number,
  ) => {
    if (writesLocked) return;
    const expectedConfirmation = `${data.character.id}:${releaseId}:${kind}`;
    if (!releaseConfirmed) {
      setError("Tick the release confirmation before running this action.");
      return;
    }
    const scheduledDate = kind === "schedule" ? new Date(scheduledAt) : null;
    if (scheduledDate && Number.isNaN(scheduledDate.getTime())) {
      setError("Choose a valid schedule date and time.");
      return;
    }
    setBusy(kind);
    setError(null);
    if (
      !journal.beginSubmission(
        `Submitting Release ${kind}. Character writes stay locked until command acceptance is known.`,
      )
    ) {
      setBusy(null);
      return;
    }
    try {
      const body = {
        entityVersion: version,
        reason: { code: `operator_${kind}`, summary: reason },
        confirmation: expectedConfirmation,
        ...(scheduledDate ? { scheduledAt: scheduledDate.toISOString() } : {}),
      };
      const outcome = await journal.submit({
        action: `Release ${kind}`,
        signature: `${kind}:${releaseId}:${JSON.stringify(body)}`,
        endpoint: adminV2OperationEndpoint(
          `POST /api/v2/admin/characters/:id/releases/:releaseId/commands/${kind}`,
          { id: data.character.id, releaseId },
        ),
        body,
      });
      if (outcome.kind === "accepted") {
        setReleaseConfirmed(false);
        return;
      }
      setError(commandSubmissionMessage(outcome, `Release ${kind}`));
    } catch (cause) {
      journal.abortSubmission();
      setError(
        cause instanceof Error ? cause.message : `Could not ${kind} release`,
      );
    } finally {
      setBusy(null);
    }
  };
  const rollbackSourceId = rollbackSources.some(
    ({ release }) => release.id === selectedRollbackSourceId,
  )
    ? selectedRollbackSourceId
    : (rollbackSources[0]?.release.id ?? "");
  const rollbackSource = rollbackSources.find(
    ({ release }) => release.id === rollbackSourceId,
  );
  const latestAuthorityQaRun = latestQaRunForCurrentWorkspaceAuthority(
    data.qaRuns,
    data,
  );
  const releasableQaRun = releasableQaRunForCurrentWorkspaceAuthority(
    data.qaRuns,
    data,
  );
  const eligibleQaRuns = releasableQaRun ? [releasableQaRun] : [];
  const qaRunId = eligibleQaRuns.some((run) => run.id === selectedQaRunId)
    ? selectedQaRunId
    : (eligibleQaRuns[0]?.id ?? "");
  const releasePreparationNeedsAssets =
    !data.project.draftAssetRouteAuthority.qaReady ||
    !data.preview.draft.assetPackReady;
  const confirmationVisible = characterReleaseConfirmationVisible({
    hasCandidate: Boolean(candidate),
    hasReleasableQaRun: Boolean(releasableQaRun),
    servingState: data.serving?.state ?? null,
  });
  const propose = async () => {
    setBusy("propose");
    setError(null);
    const requestSignature = JSON.stringify({
      characterId: data.character.id,
      entityVersion: data.project.version,
      qaRunId,
      reason,
      confirmation: `${data.character.id}:propose-release`,
    });
    const idempotencyKey =
      proposalIdempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    proposalIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      const mutation = characterReleaseProposalMutation(
        data.character.id,
        data.project.version,
        qaRunId,
        reason,
        `${data.character.id}:propose-release`,
        idempotencyKey,
      );
      await runCommittedMutation({
        action: "Release proposal",
        commit: () => adminV2Operation(mutation.operationId, mutation.options),
        afterRefresh: () => {
          delete proposalIdempotencyKeys.current[requestSignature];
          setReleaseConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not propose Release",
      );
    } finally {
      setBusy(null);
    }
  };
  const review = async (decision: "approved" | "changes_requested") => {
    if (!candidate) return;
    setBusy(decision);
    setError(null);
    const requestSignature = JSON.stringify({
      characterId: data.character.id,
      releaseId: candidate.release.id,
      entityVersion: candidate.release.version,
      decision,
      reason,
      confirmation: `${data.character.id}:${candidate.release.id}:${decision}`,
    });
    const idempotencyKey =
      releaseReviewIdempotencyKeys.current[requestSignature] ??
      crypto.randomUUID();
    releaseReviewIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      const mutation = characterReleaseReviewMutation(
        data.character.id,
        candidate.release.id,
        candidate.release.version,
        decision,
        reason,
        `${data.character.id}:${candidate.release.id}:${decision}`,
        idempotencyKey,
      );
      await runCommittedMutation({
        action: "Release review",
        commit: () => adminV2Operation(mutation.operationId, mutation.options),
        afterRefresh: () => {
          delete releaseReviewIdempotencyKeys.current[requestSignature];
          setReleaseConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not review Release",
      );
    } finally {
      setBusy(null);
    }
  };
  const validate = async () => {
    if (!candidate) return;
    setBusy("validate");
    setError(null);
    const requestSignature = JSON.stringify({
      characterId: data.character.id,
      releaseId: candidate.release.id,
      entityVersion: candidate.release.version,
      confirmation: `${data.character.id}:${candidate.release.id}:validate`,
    });
    const idempotencyKey =
      validationIdempotencyKeys.current[requestSignature] ??
      crypto.randomUUID();
    validationIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: "Release validation",
        commit: () =>
          adminV2Operation(
            "POST /api/v2/admin/characters/:id/releases/:releaseId/validation",
            {
              path: { id: data.character.id, releaseId: candidate.release.id },
              idempotencyKey,
              body: {
                entityVersion: candidate.release.version,
                confirmation: `${data.character.id}:${candidate.release.id}:validate`,
              },
            },
          ),
        afterRefresh: () => {
          delete validationIdempotencyKeys.current[requestSignature];
          setReleaseConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not validate Release",
      );
    } finally {
      setBusy(null);
    }
  };
  const servingCommand = async (action: "pause" | "resume" | "retire") => {
    if (!data.serving || writesLocked) return;
    setBusy(action);
    setError(null);
    if (
      !journal.beginSubmission(
        `Submitting Serving ${action}. Character writes stay locked until command acceptance is known.`,
      )
    ) {
      setBusy(null);
      return;
    }
    try {
      const body = {
        entityVersion: data.serving.version,
        reason: { code: `operator_${action}`, summary: reason },
        confirmation: `${data.character.id}:${action}`,
      };
      const outcome = await journal.submit({
        action: `Serving ${action}`,
        signature: `${action}:${data.character.id}:${JSON.stringify(body)}`,
        endpoint: adminV2OperationEndpoint(
          `POST /api/v2/admin/characters/:id/commands/${action}`,
          { id: data.character.id },
        ),
        body,
      });
      if (outcome.kind === "accepted") {
        setReleaseConfirmed(false);
        return;
      }
      setError(commandSubmissionMessage(outcome, `Serving ${action}`));
    } catch (cause) {
      journal.abortSubmission();
      setError(
        cause instanceof Error ? cause.message : `Could not ${action} Character`,
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        {data.releases.length === 0 ? (
          <EmptyWorkspace filtered={false} onClear={() => undefined} />
        ) : (
          <>
            {current ? (
              <section aria-labelledby="current-release-title">
                <h3
                  className="mb-3 text-sm font-semibold"
                  id="current-release-title"
                >
                  {t("Current live release")}
                </h3>
                {/* SPEC: "已就绪"只代表发布校验通过，不代表线上图片资产齐了。
                    INTENT: 发布校验校的是 placement manifest，不校 cover/hero/chat 三件套；
                    卡片标"已就绪"而上线预览标"缺少 2 个图片位"，并列出现会被读成自相矛盾。
                    把线上资产包缺口直接标在这里，两个口径各自说清自己在讲什么。 */}
                {liveAssetPackGap > 0 ? (
                  <p className="mb-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
                    {t(
                      "Release validation passed, but the live image pack is still {completed}/{total}. Missing: {missing}",
                      {
                        completed: data.journey.assetPack.live.completed,
                        total: data.journey.assetPack.live.total,
                        missing: data.journey.assetPack.live.missingPurposes.join(", "),
                      },
                    )}
                  </p>
                ) : null}
                <ReleaseSummary item={current} ordinal={releaseOrdinals.get(current.release.id)} serving />
              </section>
            ) : null}
            {candidate ? (
              <section aria-labelledby="candidate-release-title">
                <h3
                  className="mb-3 text-sm font-semibold"
                  id="candidate-release-title"
                >
                  {t("Release candidate")}
                </h3>
                <ReleaseSummary
                  item={candidate}
                  ordinal={releaseOrdinals.get(candidate.release.id)}
                  serving={false}
                />
              </section>
            ) : null}
            {history.length > 0 ? (
              <details className="border-b border-[var(--ad-border)] pb-4">
                <summary className="cursor-pointer py-2 text-sm font-semibold">
                  {t("Release history")} · {history.length}
                </summary>
                <div className="mt-2 space-y-3">
                  {history.map((item) => (
                    <ReleaseSummary
                      item={item}
                      key={item.release.id}
                      ordinal={releaseOrdinals.get(item.release.id)}
                      serving={false}
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </>
        )}
      </div>
      <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h3 className="font-semibold">{t("Release action")}</h3>
        {!candidate && !releasableQaRun ? (
          <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
            <strong>{t("Release preparation is incomplete")}</strong>
            <p className="mt-1 leading-5">
              {t(
                releasePreparationNeedsAssets
                  ? "Complete the current image pack before recording launch QA and proposing a release."
                  : "Record launch QA for the current draft before proposing a release.",
              )}
            </p>
            <Link
              className="mt-3 inline-flex min-h-11 items-center font-semibold underline"
              href={`/admin/characters/${data.character.id}?tab=${releasePreparationNeedsAssets ? "assets" : "preview"}`}
            >
              {t(
                releasePreparationNeedsAssets
                  ? "Complete image assets"
                  : "Open launch QA",
              )}
            </Link>
          </div>
        ) : null}
        {confirmationVisible ? (
          <>
            <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Reason")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </label>
            {!candidate && releasableQaRun ? (
              <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Passed QA Run for this draft")}
                <select
                  className={`${fieldClass} mt-1`}
                  onChange={(event) => setSelectedQaRunId(event.target.value)}
                  value={qaRunId}
                >
                  <option value="">
                    {t("Record QA for the current project version")}
                  </option>
                  {eligibleQaRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.id} · {run.characterContentVersionId}
                    </option>
                  ))}
                </select>
                {latestAuthorityQaRun?.status === "failed" ? (
                  <span className="mt-2 block font-normal text-[var(--ad-amber-text)]">
                    {t(
                      "The latest QA Run for this snapshot failed. Earlier passed runs cannot authorize release.",
                    )}
                  </span>
                ) : data.qaRuns.some((run) => run.status === "passed") &&
                  eligibleQaRuns.length === 0 ? (
                  <span className="mt-2 block font-normal text-[var(--ad-amber-text)]">
                    {t(
                      "Earlier QA evidence is stale after the latest draft or release review change.",
                    )}
                  </span>
                ) : null}
              </label>
            ) : null}
            <label className="mt-4 flex items-start gap-2 text-xs font-semibold">
              <input
                checked={releaseConfirmed}
                className="mt-0.5 h-4 w-4"
                onChange={(event) => setReleaseConfirmed(event.target.checked)}
                type="checkbox"
              />
              <span>
                {t("I confirm this release action")}
                <span className="mt-1 block font-normal text-[var(--ad-text-muted)]">
                  {t(
                    "Release actions are irreversible and visible to customers.",
                  )}
                </span>
              </span>
            </label>
            {error ? (
              <p
                className="mt-3 text-xs text-[var(--ad-red-text)]"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            {data.serving?.state === "live" &&
            data.serving.scheduledReleaseId ? (
              <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
                {t("Retiring this Character also cancels scheduled Release")}{" "}
                {data.serving.scheduledReleaseId}
                {t(
                  ". The cancellation is recorded with the retirement command.",
                )}
              </p>
            ) : null}
            <div className="mt-4 grid gap-2">
              {!candidate && releasableQaRun ? (
                <WorkspaceButton
                  disabled={
                    !permissions.proposeRelease ||
                    !qaRunId ||
                    releaseConfirmed === false ||
                    Boolean(busy)
                  }
                  onClick={() => void propose()}
                >
                  <Rocket className="h-4 w-4" />{" "}
                  {t("Propose immutable Release")}
                </WorkspaceButton>
              ) : null}
              {candidate?.release.status === "in_review" ? (
                <>
                  <WorkspaceButton
                    disabled={
                      !permissions.reviewRelease ||
                      releaseConfirmed === false ||
                      Boolean(busy)
                    }
                    onClick={() => void review("approved")}
                    tone="primary"
                  >
                    {t("Approve candidate")}
                  </WorkspaceButton>
                  <WorkspaceButton
                    disabled={
                      !permissions.reviewRelease ||
                      releaseConfirmed === false ||
                      Boolean(busy)
                    }
                    onClick={() => void review("changes_requested")}
                  >
                    {t("Request changes")}
                  </WorkspaceButton>
                </>
              ) : null}
              {candidate?.release.status === "approved" &&
              candidate.release.readiness !== "ready" ? (
                <WorkspaceButton
                  disabled={
                    !permissions.publishRelease ||
                    releaseConfirmed === false ||
                    Boolean(busy)
                  }
                  onClick={() => void validate()}
                >
                  {t("Validate pinned snapshot")}
                </WorkspaceButton>
              ) : null}
              {candidate?.release.status === "approved" &&
              candidate.release.readiness === "ready" ? (
                <WorkspaceButton
                  disabled={!permissions.publishRelease || Boolean(busy)}
                  onClick={() =>
                    void command(
                      "publish",
                      candidate.release.id,
                      candidate.release.version,
                    )
                  }
                  tone="primary"
                >
                  <Rocket className="h-4 w-4" /> {t("Publish candidate")}
                </WorkspaceButton>
              ) : null}
            </div>
          </>
        ) : null}
        <details className="mt-5 border-t border-[var(--ad-border)] pt-4">
          <summary className="cursor-pointer text-xs font-semibold">
            {t("Schedule and live operations")}
          </summary>
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Schedule at")}
            <input
              className={`${fieldClass} mt-1`}
              onChange={(event) => setScheduledAt(event.target.value)}
              type="datetime-local"
              value={scheduledAt}
            />
          </label>
          <div className="mt-3">
            <WorkspaceButton
              disabled={
                !permissions.publishRelease ||
                !candidate ||
                candidate.release.status !== "approved" ||
                candidate.release.readiness !== "ready" ||
                !scheduledAt ||
                Boolean(busy)
              }
              onClick={() =>
                candidate &&
                void command(
                  "schedule",
                  candidate.release.id,
                  candidate.release.version,
                )
              }
            >
              <Clock3 className="h-4 w-4" /> {t("Schedule")}
            </WorkspaceButton>
          </div>
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Historical rollback source")}
            <select
              className={`${fieldClass} mt-1`}
              onChange={(event) =>
                setSelectedRollbackSourceId(event.target.value)
              }
              value={rollbackSourceId}
            >
              <option value="">{t("No superseded release available")}</option>
              {rollbackSources.map(({ release }) => (
                <option key={release.id} value={release.id}>
                  {t("Release")} #{releaseOrdinals.get(release.id) ?? "?"}
                  {release.publishedAt ? ` · ${release.publishedAt.slice(0, 10)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3 grid gap-2">
            <WorkspaceButton
              disabled={
                !permissions.publishRelease || !rollbackSource || Boolean(busy)
              }
              onClick={() =>
                rollbackSource &&
                void command(
                  "rollback",
                  rollbackSource.release.id,
                  data.serving?.version ?? 0,
                )
              }
              tone="danger"
            >
              <RotateCcw className="h-4 w-4" />{" "}
              {t("Roll back to selected snapshot")}
            </WorkspaceButton>
            {data.serving?.state === "live" ? (
              <>
                <WorkspaceButton
                  disabled={
                    !permissions.publishRelease ||
                    releaseConfirmed === false ||
                    Boolean(busy)
                  }
                  onClick={() => void servingCommand("pause")}
                >
                  {t("Pause serving")}
                </WorkspaceButton>
                <WorkspaceButton
                  disabled={
                    !permissions.publishRelease ||
                    releaseConfirmed === false ||
                    Boolean(busy)
                  }
                  onClick={() => void servingCommand("retire")}
                  tone="danger"
                >
                  {t("Retire Character")}
                </WorkspaceButton>
              </>
            ) : null}
            {data.serving?.state === "paused" ? (
              <WorkspaceButton
                disabled={
                  !permissions.publishRelease ||
                  releaseConfirmed === false ||
                  Boolean(busy)
                }
                onClick={() => void servingCommand("resume")}
              >
                {t("Resume serving")}
              </WorkspaceButton>
            ) : null}
          </div>
        </details>
        {!permissions.publishRelease ? (
          <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
            {t("Read-only: character.release.publish is not granted.")}
          </p>
        ) : null}
      </aside>
    </div>
  );
}
