"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import Link from "next/link";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { Rocket, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { characterReleaseCreateMutation } from "@/features/image-workflow-transport";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import {
  adminV2Operation,
  adminV2OperationEndpoint,
} from "@/lib/admin-v2-operation";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { characterAssetPurposes } from "./character-asset-studio-authority";
import type {
  CharacterCommandJournal,
  CharacterCommandSubmission,
} from "./character-command-journal";
import {
  characterHasNoUnpublishedChanges,
  characterReleaseOrdinals,
} from "./character-workspace-format";
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

const releaseCheckLabels: Record<string, string> = {
  release_generation_authority_kind: "Generation authority",
  project_character_authority: "Character snapshot",
  revision_is_immutable_and_pinned: "Pinned immutable revision",
  soul_snapshot_valid: "Soul snapshot",
  soul_release_policy: "Soul release policy",
  opening_complete: "Opening message",
  visual_identity_exact_version: "Visual identity version",
  reference_set_published_snapshot: "Published reference set",
  generation_route_qualified: "Qualified generation route",
  release_avatar_manifest_available: "Avatar placement",
  release_asset_manifest_available: "Image pack placement",
  release_assets_customer_publishable: "Customer-publishable assets",
  release_asset_review_authority: "Asset review authority",
  release_asset_generation_authority: "Asset generation authority",
  snapshot_hash_matches: "Snapshot integrity",
};

export function characterReleaseCheckLabel(checkKey: string) {
  return releaseCheckLabels[checkKey] ?? checkKey.replaceAll("_", " ");
}

type ReleaseBlockerGuidance = {
  readonly blocker: string;
  readonly message: string;
  readonly action: string;
  readonly href: string;
};

export function releaseBlockersFromError(cause: unknown): string[] {
  if (
    !(cause instanceof AdminV2RequestError) ||
    !cause.details ||
    typeof cause.details !== "object" ||
    Array.isArray(cause.details)
  ) {
    return [];
  }
  const blockers = (cause.details as { blockers?: unknown }).blockers;
  return Array.isArray(blockers)
    ? [...new Set(blockers.filter((item): item is string => typeof item === "string" && item.length > 0))]
    : [];
}

export function releaseBlockerGuidance(
  blocker: string,
  characterId: string,
): ReleaseBlockerGuidance {
  const base = `/admin/characters/${encodeURIComponent(characterId)}`;
  if (blocker === "release_asset_review_authority") {
    return {
      blocker,
      message: "Review every selected image before publishing.",
      action: "Review selected images",
      href: `${base}?tab=assets`,
    };
  }
  if (
    [
      "approved_asset_pack_incomplete",
      "approved_asset_pack_invalid",
      "approved_asset_pack_lineage_invalid",
      "release_asset_manifest_available",
      "release_assets_customer_publishable",
      "release_asset_generation_authority",
      "release_avatar_manifest_available",
    ].includes(blocker)
  ) {
    return {
      blocker,
      message: "Complete and repair the selected image pack before publishing.",
      action: "Open image assets",
      href: `${base}?tab=assets`,
    };
  }
  if (["opening_complete", "soul_snapshot_valid", "soul_release_policy"].includes(blocker)) {
    return {
      blocker,
      message: "Complete the Character Soul and opening message before publishing.",
      action: "Open Character Soul",
      href: `${base}?tab=soul`,
    };
  }
  if (
    [
      "visual_identity_exact_version",
      "reference_set_published_snapshot",
      "generation_route_qualified",
      "active_visual_profile_missing_or_unsealed",
      "active_visual_profile_hash_invalid",
      "active_reference_set_media_unavailable",
      "active_reference_set_missing_or_empty",
      "active_reference_set_hash_invalid",
      "qualified_generation_route_missing",
    ].includes(blocker)
  ) {
    return {
      blocker,
      message: "Repair the visual identity authority before publishing.",
      action: "Open visual identity",
      href: `${base}?tab=visual`,
    };
  }
  return {
    blocker,
    message: "Refresh the Character and resolve this release check before publishing.",
    action: "Review release checks",
    href: `${base}?tab=release`,
  };
}

export function characterReleaseDraftBlockers(
  data: CharacterWorkspaceDetail,
): string[] {
  if (
    !data.project.draftAssetRouteAuthority.releaseReady ||
    !data.preview.draft.assetPackReady
  ) {
    return ["release_asset_manifest_available"];
  }
  const selections = data.project.draftAssetSelections;
  return characterAssetPurposes.some(
    (purpose) => !selections?.[purpose]?.reviewDecisionId,
  )
    ? ["release_asset_review_authority"]
    : [];
}

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
        <details className="mt-3 border-t border-[var(--ad-border)] pt-3">
          <summary className="cursor-pointer text-xs font-semibold">
            {t("Technical checks")}
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {checks.map((check) => (
              <div
                className="flex items-center justify-between rounded bg-black/[0.03] px-3 py-2 text-xs"
                key={check.checkKey}
              >
                <span>{t(characterReleaseCheckLabel(check.checkKey))}</span>
                <StatusBadge value={check.result} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <details className="mt-3 border-t border-[var(--ad-border)] pt-3">
        <summary className="cursor-pointer text-xs font-semibold">
          {t("Technical evidence")}
        </summary>
        <p className="mt-2 break-all text-xs text-[var(--ad-text-muted)]">
          {release.id} · {t("Snapshot")} {release.snapshotHash.slice(0, 16)} ·{" "}
          {t("content")} {release.characterContentVersionId}
        </p>
      </details>
    </article>
  );
}

export function characterReleaseConfirmationVisible(input: {
  readonly hasRollbackSource: boolean;
  readonly servingState: string | null;
}) {
  return (
    input.hasRollbackSource ||
    input.servingState === "live" ||
    input.servingState === "paused"
  );
}

export function ReleasePanel({
  data,
  permissions,
  journal,
  writesLocked,
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
  const candidate = data.releases.find(
    ({ release }) => release.status === "approved",
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
  const [reason, setReason] = useState(() => t("Publish current Character"));
  const [selectedRollbackSourceId, setSelectedRollbackSourceId] = useState("");
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorityBlockers, setAuthorityBlockers] = useState<string[]>([]);
  const createIdempotencyKeys = useRef<Record<string, string>>({});

  const submitCommand = async (
    kind: "publish" | "rollback",
    releaseId: string,
    version: number,
  ) => {
    if (writesLocked) return;
    if (
      !journal.beginSubmission(
        `Submitting Release ${kind}. Character writes stay locked until command acceptance is known.`,
      )
    ) {
      return;
    }
    const body = {
      entityVersion: version,
      reason: { code: `operator_${kind}`, summary: reason },
      confirmation: `${data.character.id}:${releaseId}:${kind}`,
    };
    try {
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
      throw cause;
    }
  };

  const publishCharacter = async () => {
    setBusy("publish");
    setError(null);
    setAuthorityBlockers([]);
    try {
      let releaseRef = candidate
        ? { id: candidate.release.id, version: candidate.release.version }
        : undefined;
      if (!releaseRef) {
        const signature = JSON.stringify({
          characterId: data.character.id,
          entityVersion: data.project.version,
          reason,
        });
        const idempotencyKey =
          createIdempotencyKeys.current[signature] ?? crypto.randomUUID();
        createIdempotencyKeys.current[signature] = idempotencyKey;
        const mutation = characterReleaseCreateMutation(
          data.character.id,
          data.project.version,
          reason,
          `${data.character.id}:publish`,
          idempotencyKey,
        );
        const created = await adminV2Operation(
          mutation.operationId,
          mutation.options,
        );
        releaseRef = { id: created.id, version: created.version };
        delete createIdempotencyKeys.current[signature];
      }
      await submitCommand("publish", releaseRef.id, releaseRef.version);
    } catch (cause) {
      const blockers = releaseBlockersFromError(cause);
      if (blockers.length > 0) setAuthorityBlockers(blockers);
      else {
        setError(
          cause instanceof Error
            ? cause.message
            : t("Could not publish Character"),
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const servingCommand = async (action: "pause" | "resume" | "retire") => {
    if (!data.serving || writesLocked || !releaseConfirmed) return;
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
        cause instanceof Error ? cause.message : t("Serving action failed"),
      );
    } finally {
      setBusy(null);
    }
  };

  const rollbackCharacter = async () => {
    if (!rollbackSource || !releaseConfirmed || writesLocked) return;
    setBusy("rollback");
    setError(null);
    try {
      await submitCommand(
        "rollback",
        rollbackSource.release.id,
        data.serving?.version ?? 0,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Rollback failed"));
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
  const noUnpublishedChanges = characterHasNoUnpublishedChanges(data);
  const draftBlockers = characterReleaseDraftBlockers(data);
  const blockers = [...new Set([...draftBlockers, ...authorityBlockers])];
  const canPublish =
    Boolean(candidate) || (!noUnpublishedChanges && blockers.length === 0);
  const confirmationVisible = characterReleaseConfirmationVisible({
    hasRollbackSource: rollbackSources.length > 0,
    servingState: data.serving?.state ?? null,
  });

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        {data.releases.length === 0 ? (
          <EmptyState
            hint={canPublish
              ? "Publish the current Character to create the first release."
              : "Complete the release requirements shown here before creating the first release."}
            title="No Character releases yet"
          />
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
                <ReleaseSummary
                  item={current}
                  ordinal={releaseOrdinals.get(current.release.id)}
                  serving
                />
              </section>
            ) : null}
            {candidate ? (
              <section aria-labelledby="candidate-release-title">
                <h3
                  className="mb-3 text-sm font-semibold"
                  id="candidate-release-title"
                >
                  {t("Ready to publish")}
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
        <h3 className="font-semibold">{t("Publish Character")}</h3>
        {noUnpublishedChanges && !candidate ? (
          <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
            {t("Live and draft are identical. There is nothing to release.")}
          </p>
        ) : blockers.length > 0 && !candidate ? (
          <div className="mt-3 space-y-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
            {blockers.map((blocker) => {
              const guidance = releaseBlockerGuidance(
                blocker,
                data.character.id,
              );
              return (
                <div key={blocker}>
                  <p>{t(guidance.message)}</p>
                  <Link
                    className="mt-1 inline-flex font-semibold underline"
                    href={guidance.href}
                  >
                    {t(guidance.action)}
                  </Link>
                </div>
              );
            })}
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">
            {t(error)}
          </p>
        ) : null}

        {canPublish ? (
          <WorkspaceButton
            className="mt-4 w-full"
            disabled={
              !permissions.publishRelease ||
              Boolean(busy) ||
              writesLocked
            }
            onClick={() => void publishCharacter()}
            tone="primary"
          >
            <Rocket className="h-4 w-4" /> {t("Publish Character")}
          </WorkspaceButton>
        ) : null}

        <details className="mt-5 border-t border-[var(--ad-border)] pt-4">
          <summary className="cursor-pointer text-xs font-semibold">
            {t("Rollback and live operations")}
          </summary>
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
              <label className="mt-4 flex items-start gap-2 text-xs font-semibold">
                <input
                  checked={releaseConfirmed}
                  className="mt-0.5 h-4 w-4"
                  onChange={(event) => setReleaseConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("I confirm this release action")}</span>
              </label>
            </>
          ) : null}
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
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3 grid gap-2">
            <WorkspaceButton
              disabled={
                !permissions.publishRelease ||
                !releaseConfirmed ||
                !rollbackSource ||
                Boolean(busy) ||
                writesLocked
              }
              onClick={() => void rollbackCharacter()}
              tone="danger"
            >
              <RotateCcw className="h-4 w-4" /> {t("Roll back")}
            </WorkspaceButton>
            {data.serving?.state === "live" ? (
              <>
                <WorkspaceButton
                  disabled={
                    !permissions.publishRelease ||
                    !releaseConfirmed ||
                    Boolean(busy) ||
                    writesLocked
                  }
                  onClick={() => void servingCommand("pause")}
                >
                  {t("Pause serving")}
                </WorkspaceButton>
                <WorkspaceButton
                  disabled={
                    !permissions.publishRelease ||
                    !releaseConfirmed ||
                    Boolean(busy) ||
                    writesLocked
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
                  !releaseConfirmed ||
                  Boolean(busy) ||
                  writesLocked
                }
                onClick={() => void servingCommand("resume")}
              >
                {t("Resume serving")}
              </WorkspaceButton>
            ) : null}
          </div>
        </details>
      </aside>
    </div>
  );
}
