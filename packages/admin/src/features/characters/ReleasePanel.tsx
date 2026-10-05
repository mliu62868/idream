"use client";

import { characterCommandMessage, renderCharacterCommandMessage, type CharacterCommandMessage } from "./character-command-copy";
import { useAdminI18n } from "@/components/admin/i18n";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import Link from "next/link";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { Rocket, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
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
import type {
  CharacterCommandJournal,
  CharacterCommandSubmission,
} from "./character-command-journal";
import {
  characterHasNoUnpublishedChanges,
  characterMonitorNeedsAttention,
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
    return characterCommandMessage("{action} is already active. This workspace attached to that command instead of accepting another one.", { action: outcome.command.action });
  }
  return outcome.cause instanceof Error
    ? outcome.cause.message
    : characterCommandMessage("{action} acceptance is unknown. The same command will be replayed safely.", { action: action });
}

type CharacterReleaseItem = CharacterWorkspaceDetail["releases"][number];

const releaseCheckLabels: Record<string, string> = {
  release_generation_authority_kind: "Generation authority",
  project_character_authority: "Character snapshot",
  revision_is_immutable_and_pinned: "Pinned immutable revision",
  soul_snapshot_valid: "Soul snapshot",
  soul_release_policy: "Soul release policy",
  companion_product_contract: "Companion product contract",
  opening_complete: "Opening message",
  visual_identity_exact_version: "Visual identity version",
  reference_set_published_snapshot: "Published reference set",
  generation_route_qualified: "Qualified generation route",
  release_avatar_manifest_available: "Avatar placement",
  release_asset_manifest_available: "Image pack placement",
  release_assets_customer_publishable: "Customer-publishable assets",
  release_asset_source_authority: "Image source and availability",
  release_asset_generation_authority: "Asset generation authority",
  snapshot_hash_matches: "Snapshot integrity",
};

export function characterReleaseCheckLabel(checkKey: string) {
  return releaseCheckLabels[checkKey] ?? checkKey.replaceAll("_", " ");
}

// INVARIANT: href null = nothing an operator can fix in the workspace. Never link
// back to the Release tab itself; that only sends the operator in a circle.
type ReleaseBlockerGuidance = {
  readonly blocker: string;
  readonly message: string;
  readonly action: string | null;
  readonly href: string | null;
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
  if (blocker === "release_asset_source_authority") {
    return {
      blocker,
      message: "Check the selected images and their sources before publishing.",
      action: "Open image library",
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
      "approved_avatar_missing",
    ].includes(blocker)
  ) {
    return {
      blocker,
      message: "Complete and repair the selected image pack before publishing.",
      action: "Open image assets",
      href: `${base}?tab=assets`,
    };
  }
  const soulMessages: Record<string, string> = {
    soul_snapshot_valid: "The Character Soul does not compile. Fix it before publishing.",
    soul_release_policy: "Clear every Character Soul diagnostic before publishing. Warnings block too.",
    opening_complete: "Add an opening message before publishing.",
    revision_missing: "Complete the Character Soul and opening message before publishing.",
  };
  if (soulMessages[blocker]) {
    return {
      blocker,
      message: soulMessages[blocker],
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
      "release_generation_authority_kind",
      "visual_identity_missing",
      "reference_set_not_active",
      "reference_assets_unavailable",
      "generation_route_unqualified",
      "generation_route_stale",
    ].includes(blocker)
  ) {
    return {
      blocker,
      message: "Repair the visual identity authority before publishing.",
      action: "Open visual identity",
      href: `${base}?tab=visual`,
    };
  }
  if (
    [
      "character_missing",
      "project_missing",
      "companion_product_contract",
      "snapshot_hash_matches",
    ].includes(blocker)
  ) {
    return {
      blocker,
      message: "Platform issue. Engineering must resolve it before this Character can be published.",
      action: null,
      href: null,
    };
  }
  return {
    blocker,
    message: "Unrecognized release check. Share this code with engineering.",
    action: null,
    href: null,
  };
}

// Visual readiness codes that also fail a release check (visual identity, reference
// set, qualified route). Anchor and trait completeness only gate image generation.
const releaseBlockingVisualCodes = [
  "visual_identity_missing",
  "reference_set_not_active",
  "reference_assets_unavailable",
  "generation_route_unqualified",
  "generation_route_stale",
];

// SPEC: every release check the workspace can predict, so publishing is blocked
// before a candidate is created instead of after a 409.
// INTENT: mirrors release-validation.ts. soul_release_policy fails on any
// diagnostic, warnings included. Its legacy exemption only applies to imported
// legacy Releases, never to one created here.
export function characterReleaseDraftBlockers(
  data: CharacterWorkspaceDetail,
): string[] {
  const blockers: string[] = [];
  if (!data.soul.valid) blockers.push("soul_snapshot_valid");
  else if (
    data.soul.current.schemaVersion !== 3 ||
    data.soul.current.diagnostics.length > 0
  ) {
    blockers.push("soul_release_policy");
  }
  const firstMessage = data.preview.draft.opening.firstMessage;
  if (typeof firstMessage !== "string" || firstMessage.trim() === "") {
    blockers.push("opening_complete");
  }
  if (
    !data.project.draftAssetRouteAuthority.releaseReady ||
    !data.preview.draft.assetPackReady
  ) {
    blockers.push("release_asset_manifest_available");
  }
  for (const { code } of data.visual.readiness.blockers) {
    if (releaseBlockingVisualCodes.includes(code)) blockers.push(code);
  }
  if (
    data.project.draftAssetRouteAuthority.releaseBlockers.includes(
      "qualified_generation_route_missing",
    )
  ) {
    blockers.push("qualified_generation_route_missing");
  }
  return blockers;
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
        {release.legacy ? <StatusBadge tone="neutral" value="Legacy release" /> : null}
      </div>
      {release.legacy ? (
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
          {t("Historical editorial release with no automatic release check record. Publishing again runs the full checks.")}
        </p>
      ) : null}
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
    input.servingState === "paused" ||
    input.servingState === "inactive" ||
    input.servingState === "retired"
  );
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
  const [reason, setReason] = useState("");
  const [selectedRollbackSourceId, setSelectedRollbackSourceId] = useState("");
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const [retireAcknowledged, setRetireAcknowledged] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<CharacterCommandMessage | null>(null);
  // INTENT: server blockers describe the workspace they were returned for. A
  // refreshed workspace is new evidence, so they drop instead of sticking around.
  const [authority, setAuthority] = useState<{
    readonly data: CharacterWorkspaceDetail;
    readonly blockers: string[];
  } | null>(null);
  const authorityBlockers = authority?.data === data ? authority.blockers : [];

  const submitCommand = async (
    kind: "publish" | "rollback" | "withdraw",
    release: { id: string; version: number } | (() => Promise<{ id: string; version: number }>),
  ) => {
    if (writesLocked) return;
    if (
      !journal.beginSubmission(
        characterCommandMessage("Submitting {action}. Character writes stay locked until command acceptance is known.", { action: `Release ${kind}` }),
      )
    ) {
      return;
    }
    const generation = journal.getGeneration();
    try {
      // Candidate creation and command acceptance are one operator action. Keep
      // the workspace locked while the candidate POST is still in flight.
      const prepared = typeof release === "function" ? await release() : release;
      if (!journal.isCurrentGeneration(generation)) return;
      const releaseId = prepared.id;
      const body = {
        entityVersion: prepared.version,
        reason: { code: `operator_${kind}`, summary: reason.trim() || t(kind === "withdraw" ? "Discard candidate" : kind === "rollback" ? "Roll back" : "Publish current Character") },
        confirmation: `${data.character.id}:${releaseId}:${kind}`,
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
      throw cause;
    }
  };

  const publishCharacter = async () => {
    setBusy("publish");
    setError(null);
    setAuthority(null);
    try {
      const releaseRef = candidate
        ? { id: candidate.release.id, version: candidate.release.version }
        : async () => {
            const publishReason = reason.trim() || t("Publish current Character");
            const mutation = characterReleaseCreateMutation(
              data.character.id,
              data.project.version,
              publishReason,
              `${data.character.id}:publish`,
            );
            const created = await adminV2Operation(
              mutation.operationId,
              mutation.options,
            );
            return { id: created.id, version: created.version };
          };
      await submitCommand("publish", releaseRef);
    } catch (cause) {
      const blockers = releaseBlockersFromError(cause);
      if (blockers.length > 0) setAuthority({ data, blockers });
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

  const withdrawCandidate = async () => {
    if (!candidate || writesLocked || busy) return;
    setBusy("withdraw");
    setError(null);
    try {
      await submitCommand("withdraw", { id: candidate.release.id, version: candidate.release.version });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not discard candidate"));
    } finally {
      setBusy(null);
    }
  };

  const servingCommand = async (action: "pause" | "resume" | "retire" | "restore") => {
    if (!data.serving || writesLocked || !releaseConfirmed) return;
    setBusy(action);
    setError(null);
    if (
      !journal.beginSubmission(
        characterCommandMessage("Submitting {action}. Character writes stay locked until command acceptance is known.", { action: `Serving ${action}` }),
      )
    ) {
      setBusy(null);
      return;
    }
    try {
      const body = {
        entityVersion: data.serving.version,
        reason: { code: `operator_${action}`, summary: reason.trim() || t(action === "restore" ? "Restore draft" : action === "retire" ? (data.serving.state === "inactive" ? "Archive draft" : "Retire Character") : action === "pause" ? "Pause serving" : "Resume serving") },
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
        setRetireAcknowledged(false);
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

  const changeCatalogVisibility = async () => {
    if (!data.serving || data.serving.state !== "live" || !permissions.manageCatalogVisibility || writesLocked || busy) return;
    const visibility = data.character.visibility === "unlisted" ? "public" : "unlisted";
    const action = visibility === "public" ? "Show in Explore" : "Hide from Explore";
    setBusy("visibility");
    setError(null);
    try {
      await runCommittedMutation({
        action,
        commit: () => adminV2Operation("POST /api/v2/admin/content/characters/:id/visibility", {
          path: { id: data.character.id },
          body: { visibility, entityVersion: data.serving!.version, reason: action, confirmation: `${data.character.id}:visibility:${visibility}` },
        }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not update Explore visibility"));
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
        { id: rollbackSource.release.id, version: data.serving?.version ?? 0 },
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
  // Identical content does not restore a route qualification lost after a profile change.
  const currentReleaseStale = current?.release.status === "published" && current.release.readiness === "stale";
  const draftBlockers = candidate || (noUnpublishedChanges && !currentReleaseStale)
    ? []
    : characterReleaseDraftBlockers(data);
  // Server blockers stay visible but never hide or disable Publish: the next
  // attempt is re-validated by the server anyway.
  const blockers = [...new Set([...draftBlockers, ...authorityBlockers])];
  const blockerGuidance = [
    ...new Map(
      blockers.map((blocker) => {
        const guidance = releaseBlockerGuidance(blocker, data.character.id);
        return [`${guidance.message}|${guidance.href}`, guidance] as const;
      }),
    ).values(),
  ];
  const canPublish =
    data.serving?.state !== "retired" &&
    (Boolean(candidate) || !noUnpublishedChanges || currentReleaseStale);
  // characterReleaseCreateRequestSchema requires 3+ characters; empty uses the default.
  const reasonTooShort = !candidate && reason.trim().length > 0 && reason.trim().length < 3;
  const retireIsPermanent =
    data.serving?.state === "live" || data.serving?.state === "paused";
  const confirmationVisible = characterReleaseConfirmationVisible({
    hasRollbackSource: rollbackSources.length > 0,
    servingState: data.serving?.state ?? null,
  });

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        {data.releases.length === 0 ? (
          <EmptyState
            hint={canPublish && draftBlockers.length === 0
              ? "Publish the current Character to create the first release."
              : "Complete the release requirements shown here before creating the first release."}
            title={t("No Character releases yet")}
          />
        ) : (
          <>
            {current ? (
              <section aria-labelledby="current-release-title">
                <h3
                  className="mb-3 text-sm font-semibold"
                  id="current-release-title"
                >
                  {data.serving?.state === "live" ? t("Current live release") : t("Current release")}
                </h3>
                <ReleaseSummary
                  item={current}
                  ordinal={releaseOrdinals.get(current.release.id)}
                  serving={data.serving?.state === "live"}
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
                <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
                  {t("Discard this candidate to edit the draft again. The live Character stays unchanged.")}
                </p>
                <WorkspaceButton
                  className="mt-2"
                  disabled={!permissions.publishRelease || Boolean(busy) || writesLocked}
                  onClick={() => void withdrawCandidate()}
                >
                  {t("Discard candidate")}
                </WorkspaceButton>
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
        {noUnpublishedChanges && !currentReleaseStale && !candidate ? (
          <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
            {t("Live and draft are identical. There is nothing to release.")}
          </p>
        ) : null}
        {blockerGuidance.length > 0 ? (
          <div className="mt-3 space-y-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" data-testid="release-blockers">
            {blockerGuidance.map((guidance) => (
              <div key={`${guidance.message}|${guidance.href}`}>
                <p>{t(guidance.message)}</p>
                {guidance.href && guidance.action ? (
                  <Link
                    className="mt-1 inline-flex font-semibold underline"
                    href={guidance.href}
                  >
                    {t(guidance.action)}
                  </Link>
                ) : (
                  <code className="mt-1 block break-all text-xs">{guidance.blocker}</code>
                )}
              </div>
            ))}
          </div>
        ) : currentReleaseStale && !candidate ? (
          <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
            {t("The live release qualification is stale. Publishing again checks the current images and generation route; the content can stay unchanged.")}
          </p>
        ) : null}

        {error ? (
          <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">
            {renderCharacterCommandMessage(error, t)}
          </p>
        ) : null}

        {canPublish ? (
          <WorkspaceButton
            className="mt-4 w-full"
            disabled={
              !permissions.publishRelease ||
              Boolean(busy) ||
              writesLocked ||
              draftBlockers.length > 0 ||
              reasonTooShort
            }
            onClick={() => void publishCharacter()}
            tone="primary"
          >
            <Rocket className="h-4 w-4" /> {t("Publish Character")}
          </WorkspaceButton>
        ) : null}

        <details className="mt-5 border-t border-[var(--ad-border)] pt-4" open={characterMonitorNeedsAttention(data)}>
          <summary className="cursor-pointer text-xs font-semibold">
            {t("Character availability and rollback")}
          </summary>
          {data.serving?.state === "live" && ["public", "unlisted"].includes(data.character.visibility) ? (
            <div className="mt-4 space-y-2">
              <p className="text-xs text-[var(--ad-text-muted)]">
                {t(data.character.visibility === "unlisted" ? "Hidden from Explore" : "Listed in Explore")}
              </p>
              <WorkspaceButton
                disabled={!permissions.manageCatalogVisibility || Boolean(busy) || writesLocked}
                onClick={() => void changeCatalogVisibility()}
              >
                {t(data.character.visibility === "unlisted" ? "Show in Explore" : "Hide from Explore")}
              </WorkspaceButton>
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
              {reasonTooShort ? (
                <p className="mt-1 text-xs text-[var(--ad-red-text)]" role="alert">
                  {t("Reason must be at least 3 characters, or leave it empty to use the default.")}
                </p>
              ) : null}
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
          {rollbackSources.length > 0 ? <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
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
          </label> : null}
          <div className="mt-3 grid gap-2">
            {rollbackSources.length > 0 ? <WorkspaceButton
              disabled={
                !permissions.publishRelease ||
                !releaseConfirmed ||
                !rollbackSource ||
                data.serving?.state === "retired" ||
                Boolean(busy) ||
                writesLocked
              }
              onClick={() => void rollbackCharacter()}
              tone="danger"
            >
              <RotateCcw className="h-4 w-4" /> {t("Roll back")}
            </WorkspaceButton> : null}
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

              </>
            ) : null}
            {data.serving && ["inactive", "live", "paused"].includes(data.serving.state) ? (
              <>
                {/* INTENT: retiring a published Character cannot be undone (no
                    restore, no rollback, no new release), unlike Pause. An
                    inactive draft is archived instead and can be restored. */}
                {retireIsPermanent ? (
                  <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-xs text-[var(--ad-red-text)]">
                    <p>{t("Retiring is permanent. The Character can never be published or rolled back again. Use Pause serving to take it offline temporarily.")}</p>
                    <label className="mt-2 flex items-start gap-2 font-semibold">
                      <input
                        checked={retireAcknowledged}
                        className="mt-0.5 h-4 w-4"
                        onChange={(event) => setRetireAcknowledged(event.target.checked)}
                        type="checkbox"
                      />
                      <span>{t("I understand retiring cannot be undone")}</span>
                    </label>
                  </div>
                ) : null}
                <WorkspaceButton
                  disabled={!permissions.publishRelease || !releaseConfirmed || (retireIsPermanent && !retireAcknowledged) || Boolean(busy) || writesLocked}
                  onClick={() => void servingCommand("retire")}
                  tone="danger"
                >
                  {t(data.serving.state === "inactive" ? "Archive draft" : "Retire Character")}
                </WorkspaceButton>
              </>
            ) : null}
            {data.serving?.state === "retired" && data.serving.currentReleaseId === null ? (
              <>
                <p className="text-xs text-[var(--ad-text-muted)]">{t("Restore this draft to continue editing. It will remain private.")}</p>
                <WorkspaceButton
                  disabled={!permissions.publishRelease || !releaseConfirmed || Boolean(busy) || writesLocked}
                  onClick={() => void servingCommand("restore")}
                >
                  {t("Restore draft")}
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
