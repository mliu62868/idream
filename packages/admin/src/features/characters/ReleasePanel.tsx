"use client";

import { characterCommandMessage, renderCharacterCommandMessage, type CharacterCommandMessage } from "./character-command-copy";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import Link from "next/link";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { Rocket, RotateCcw } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import type { CharacterCommandJournal } from "./character-command-journal";
import {
  characterHasNoUnpublishedChanges,
  characterMonitorNeedsAttention,
  characterReleaseOrdinals,
} from "./character-workspace-format";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";
import { CharacterHandoffNotice } from "./CharacterHandoff";
import { ImmediateChangesNotice } from "./ImmediateChangesNotice";
import { characterAssetPurposeLabel, nextIncompleteCharacterAssetPurpose } from "./character-asset-studio-authority";
import { ReleaseChangeSummary } from "./PreviewDiff";
import {
  characterCommandFailure,
  characterCommandFailureMessage,
  characterReleaseCheckLabel,
  characterServingCommandSummary,
  commandSubmissionMessage,
  prepareCharacterPublishTarget,
  submitCharacterReleaseCommand,
  submitWorkspaceServingCommand,
  type CharacterServingAction,
} from "./release-command";

type CharacterReleaseItem = CharacterWorkspaceDetail["releases"][number];

export { characterReleaseCheckLabel };

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
  // INTENT: with no identity yet, the fix is the first portrait in Images (identity
  // bootstrap), the same place the production journey sends operators. Visual
  // identity only repairs an identity that already exists.
  if (blocker === "visual_identity_missing") {
    return {
      blocker,
      message: "Create the first identity portrait before publishing.",
      action: "Create first identity portrait",
      href: `${base}?tab=assets`,
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
  rollbackSourceOrdinal,
}: {
  item: CharacterReleaseItem;
  ordinal: number | undefined;
  serving: boolean;
  rollbackSourceOrdinal?: number;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
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
            <time dateTime={release.publishedAt}>{format.dateTime(release.publishedAt)}</time>
          </span>
        ) : null}
        {/* INTENT: 持久化枚举 approved 只表示「已准备好待发布」，从来没有人批准过它。 */}
        <StatusBadge value={release.status === "approved" ? "Pending publish" : release.status} />
        {!historical ? <StatusBadge value={release.readiness} /> : null}
        {serving ? <StatusBadge tone="good" value="serving now" /> : null}
        {release.legacy ? <StatusBadge tone="neutral" value="Legacy release" /> : null}
      </div>
      {rollbackSourceOrdinal !== undefined ? (
        <p className="mt-2 text-sm">{t("Restored content from release #{ordinal}", { ordinal: rollbackSourceOrdinal })}</p>
      ) : null}
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

// SPEC: a legacy Release has no automatic check record; the only way off it is to
// publish a checked Release. Say what is still missing, each with the place to fix it.
// INTENT: 15 live characters sat on legacy Releases with only a badge and no path.
function LegacyUpgradeGuide({
  characterId,
  draftBlockers,
}: {
  characterId: string;
  draftBlockers: readonly string[];
}) {
  const { t } = useAdminI18n();
  const steps = [
    ...new Map(
      draftBlockers
        .map((blocker) => releaseBlockerGuidance(blocker, characterId))
        .map((guidance) => [guidance.message, guidance] as const),
    ).values(),
  ];
  return (
    <div className="mt-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 text-sm" data-testid="legacy-upgrade-guide">
      <h4 className="font-semibold">{t("Move to a checked release")}</h4>
      <p className="mt-1 text-[var(--ad-text-muted)]">
        {t("Publishing again replaces this historical release with one that passes the current checks. Customers keep seeing the current version until then.")}
      </p>
      {steps.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {steps.map((step) => (
            <li className="flex flex-wrap items-center justify-between gap-2" key={step.message}>
              <span>{t(step.message)}</span>
              {step.href && step.action ? (
                <Link className="min-h-9 content-center font-semibold underline" href={step.href}>{t(step.action)}</Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 font-medium">{t("Nothing is missing. Publish from this page.")}</p>
      )}
    </div>
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
  const format = useAdminFormat();
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
  const [selectedRollbackSourceId, setSelectedRollbackSourceId] = useState("");
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<CharacterCommandMessage | null>(null);
  // INTENT: server blockers describe the workspace they were returned for. A
  // refreshed workspace is new evidence, so they drop instead of sticking around.
  const [authority, setAuthority] = useState<{
    readonly data: CharacterWorkspaceDetail;
    readonly blockers: string[];
  } | null>(null);
  const syncAuthorityBlockers = authority?.data === data ? authority.blockers : [];
  // SPEC: 异步 publish 命令以失败终局时，服务端已在同一事务里撤回候选、解冻草稿；失败证据带
  //       blockers。直接在这里列出 blockers 与修复入口，不再引导运营去「放弃候选」。
  // INTENT: 证据描述的是失败那一刻的草稿。运营改过草稿（Project 版本或 Soul 版本变化）后它就
  //         过时了，退回由客户端预测的 draftBlockers；下一次提交开始时 journal 也会清零。
  const { lastFailure } = useSyncExternalStore(journal.subscribe, journal.getSnapshot, journal.getSnapshot);
  const publishFailure = lastFailure?.action === "Release publish"
    ? characterCommandFailure(lastFailure.status, lastFailure.error)
    : null;
  const draftFingerprint = `${data.project.version}:${data.soul.current.contentVersionId}`;
  const failureKey = lastFailure ? `${lastFailure.commandId ?? ""}:${lastFailure.status}` : null;
  const [failureBaseline, setFailureBaseline] = useState<{ readonly key: string; readonly draft: string } | null>(null);
  if (publishFailure && failureKey && failureBaseline?.key !== failureKey) {
    setFailureBaseline({ key: failureKey, draft: draftFingerprint });
  }
  const failureCurrent = publishFailure !== null && failureBaseline?.key === failureKey && failureBaseline.draft === draftFingerprint;
  // 刷新后的兜底：服务端从被自动撤回候选的校验结果推导，草稿一改即为 null。
  const persistedFailureBlockers = data.lastFailedPublish?.blockers ?? [];
  const failureBlockers = failureCurrent ? publishFailure.blockers : persistedFailureBlockers;
  const showPersistedFailure = !failureCurrent && data.lastFailedPublish !== null && data.lastFailedPublish !== undefined;
  const authorityBlockers = [...new Set([...syncAuthorityBlockers, ...failureBlockers])];

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
      const outcome = await submitCharacterReleaseCommand(journal, {
        characterId: data.character.id,
        kind,
        release: prepared,
        summary: t(kind === "withdraw" ? "Discard candidate" : kind === "rollback" ? "Roll back" : "Publish current Character"),
      });
      if (outcome.kind === "accepted") return;
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
      await submitCommand("publish", () => prepareCharacterPublishTarget({
        characterId: data.character.id,
        projectVersion: data.project.version,
        candidate: candidate?.release,
        summary: t("Publish current Character"),
      }));
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

  const servingCommand = async (action: CharacterServingAction) => {
    if (!data.serving || writesLocked) return;
    setBusy(action);
    setError(null);
    try {
      setError(await submitWorkspaceServingCommand(journal, {
        characterId: data.character.id,
        action,
        entityVersion: data.serving.version,
        summary: t(characterServingCommandSummary(action, data.serving.state)),
      }));
    } catch (cause) {
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
    if (!rollbackSource || writesLocked) return;
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

  // SPEC: 回滚和不可逆退役各只有一个普通确认框：说清影响，不键入、不勾选、不要原因。
  const confirmRollback = () => {
    if (!rollbackSource) return;
    setConfirmSpec({
      title: t("Roll back to Release #{ordinal}?", { ordinal: releaseOrdinals.get(rollbackSource.release.id) ?? "?" }),
      consequence: {
        effect: t("New conversations use this Release right away. Conversations already in progress stay on their pinned version. Publish again to move forward."),
        reversible: true,
      },
      requireReason: false,
      submitLabel: "Roll back",
      onSubmit: () => rollbackCharacter(),
    });
  };

  const confirmRetire = () => {
    setConfirmSpec({
      title: t("Retire {name}?", { name: data.character.name }),
      consequence: {
        effect: t("Retiring is permanent. The Character can never be published or rolled back again. Use Pause serving to take it offline temporarily."),
        reversible: false,
      },
      requireReason: false,
      submitLabel: "Retire Character",
      onSubmit: () => servingCommand("retire"),
    });
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
  // A legacy Release is left by publishing the same content as a checked Release,
  // so "no unpublished changes" must not hide Publish or its blockers.
  const legacyCurrent = current?.release.legacy === true && !candidate;
  const draftBlockers = candidate || (noUnpublishedChanges && !currentReleaseStale && !legacyCurrent)
    ? []
    : characterReleaseDraftBlockers(data);
  // Server blockers stay visible but never hide or disable Publish: the next
  // attempt is re-validated by the server anyway.
  const blockers = [...new Set([...draftBlockers, ...authorityBlockers])];
  const needsFirstPortrait = !data.visual.activeIdentity && blockers.some((code) =>
    code === "visual_identity_missing" || code === "active_visual_profile_missing_or_unsealed"
  );
  const nextPlacement = !needsFirstPortrait && blockers.includes("release_asset_manifest_available")
    ? nextIncompleteCharacterAssetPurpose(data.journey)
    : null;
  const primaryAction = data.journey.primaryAction;
  const canReadImageStep = permissions.readImages && (
    !primaryAction.readOperations.includes("GET /api/v2/admin/characters/:id/image-sources") || primaryAction.canReadTarget
  );
  const blockerGuidance = [
    ...new Map(
      blockers.flatMap((blocker) => {
        if (blocker === "release_asset_manifest_available" && (needsFirstPortrait || nextPlacement)) return [];
        const activeIdentityMissing = blocker === "active_visual_profile_missing_or_unsealed";
        const guidance = releaseBlockerGuidance(
          needsFirstPortrait && activeIdentityMissing ? "visual_identity_missing"
            : !needsFirstPortrait && blocker === "visual_identity_missing" ? "active_visual_profile_missing_or_unsealed"
            : blocker,
          data.character.id,
        );
        // Identity creation supplies the reference set and route. Those checks
        // are actionable only once the first portrait has been adopted.
        if (needsFirstPortrait && guidance.action === "Open visual identity") return [];
        return [[`${guidance.message}|${guidance.href}`, guidance] as const];
      }),
    ).values(),
  ];
  const canPublish =
    data.serving?.state !== "retired" &&
    (Boolean(candidate) || !noUnpublishedChanges || currentReleaseStale || legacyCurrent);
  // INTENT: 退役已发布角色不可撤销；未发布草稿只是归档，能恢复，所以一键。
  const retireIsPermanent =
    data.serving?.state === "live" || data.serving?.state === "paused";
  const servingActionDisabled = !permissions.publishRelease || Boolean(busy) || writesLocked;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        <ReleaseChangeSummary data={data} />
        <CharacterHandoffNotice data={data} />
        <ImmediateChangesNotice data={data} />
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
                  rollbackSourceOrdinal={releaseOrdinals.get(current.release.rollbackOfReleaseId ?? "")}
                  serving={data.serving?.state === "live"}
                />
                {legacyCurrent ? (
                  <LegacyUpgradeGuide characterId={data.character.id} draftBlockers={draftBlockers} />
                ) : null}
              </section>
            ) : null}
            {candidate ? (
              <section aria-labelledby="candidate-release-title">
                <h3
                  className="mb-3 text-sm font-semibold"
                  id="candidate-release-title"
                >
                  {t("Pending publish")}
                </h3>
                <ReleaseSummary
                  item={candidate}
                  ordinal={releaseOrdinals.get(candidate.release.id)}
                  serving={false}
                />
                <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
                  {candidate.release.readiness === "blocked"
                    ? t("This candidate failed release checks and can never go live. Discard it to edit the draft again. The live Character stays unchanged.")
                    : t("Discard this candidate to edit the draft again. The live Character stays unchanged.")}
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
        {failureCurrent && publishFailure ? (
          <p className="mt-3 text-sm font-medium text-[var(--ad-red-text)]" data-testid="release-publish-failure" role="alert">
            {t(characterCommandFailureMessage(publishFailure))}
          </p>
        ) : showPersistedFailure ? (
          <p className="mt-3 text-sm font-medium text-[var(--ad-red-text)]" data-testid="release-publish-failure" role="status">
            {t(persistedFailureBlockers.length > 0
              ? "The last publish attempt failed its release checks. The candidate was withdrawn and the draft can be edited; fix the items below and publish again."
              : "The last publish attempt could not go live and the candidate was withdrawn. The draft can be edited; publish again, and contact engineering with the code below if it repeats.")}
            {persistedFailureBlockers.length === 0 && data.lastFailedPublish ? (
              <span className="mt-1 block font-mono text-xs text-[var(--ad-text-muted)]">{data.lastFailedPublish.failureCode}</span>
            ) : null}
          </p>
        ) : null}
        {nextPlacement || blockerGuidance.length > 0 ? (
          <div className="mt-3 space-y-3 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" data-testid="release-blockers">
            {nextPlacement ? (
              <p>
                {canReadImageStep ? <Link
                  className="font-semibold underline"
                  href={`/admin/characters/${encodeURIComponent(data.character.id)}?tab=assets#character-image-placement-${nextPlacement}`}
                >
                  {t(data.preview.draft.assetPack[nextPlacement].status === "missing" ? "Select an image for {slot}" : "Fix the image for {slot}", { slot: t(characterAssetPurposeLabel(nextPlacement)) })}
                </Link> : t("Complete and repair the selected image pack before publishing.")}
              </p>
            ) : null}
            {blockerGuidance.map((guidance) => (
              <div key={`${guidance.message}|${guidance.href}`}>
                <p>{t(guidance.message)}</p>
                {guidance.href && guidance.action ? (!guidance.href.includes("?tab=assets") || canReadImageStep ? (
                  <Link
                    className="mt-1 inline-flex font-semibold underline"
                    href={guidance.href}
                  >
                    {t(guidance.action)}
                  </Link>
                ) : null) : (
                  <code className="mt-1 block break-all text-xs">{guidance.blocker}</code>
                )}
              </div>
            ))}
            {!canReadImageStep && (nextPlacement || blockerGuidance.some(({ href }) => href?.includes("?tab=assets"))) ? (
              <p>{t("Ask someone with access to this character’s image workspace to complete this step.")}</p>
            ) : null}
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
              draftBlockers.length > 0
            }
            onClick={() => void publishCharacter()}
            tone="primary"
          >
            <Rocket className="h-4 w-4" /> {t("Publish Character")}
          </WorkspaceButton>
        ) : null}

        {/* SPEC: 暂停、恢复、恢复草稿一键执行，不放进折叠区。 */}
        {data.serving?.state === "live" ? (
          <WorkspaceButton className="mt-3 w-full" disabled={servingActionDisabled} onClick={() => void servingCommand("pause")}>
            {t("Pause serving")}
          </WorkspaceButton>
        ) : null}
        {data.serving?.state === "paused" ? (
          <WorkspaceButton className="mt-3 w-full" disabled={servingActionDisabled} onClick={() => void servingCommand("resume")} tone={canPublish ? undefined : "primary"}>
            {t("Resume serving")}
          </WorkspaceButton>
        ) : null}
        {data.serving?.state === "retired" && data.serving.currentReleaseId === null ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-[var(--ad-text-muted)]">{t("Restore this draft to continue editing. It will remain private.")}</p>
            <WorkspaceButton className="w-full" disabled={servingActionDisabled} onClick={() => void servingCommand("restore")}>
              {t("Restore draft")}
            </WorkspaceButton>
          </div>
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
          {rollbackSources.length > 0 ? <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Historical rollback source")}
            <select
              className={`${fieldClass} mt-1`}
              onChange={(event) =>
                setSelectedRollbackSourceId(event.target.value)
              }
              value={rollbackSourceId}
            >
              {rollbackSources.map(({ release }) => (
                <option key={release.id} value={release.id}>
                  {t("Release")} #{releaseOrdinals.get(release.id) ?? "?"}{release.publishedAt ? ` · ${format.dateTime(release.publishedAt)}` : ""}
                </option>
              ))}
            </select>
          </label> : null}
          <div className="mt-3 grid gap-2">
            {rollbackSources.length > 0 ? <WorkspaceButton
              disabled={
                !rollbackSource ||
                data.serving?.state === "retired" ||
                servingActionDisabled
              }
              onClick={confirmRollback}
              tone="danger"
            >
              <RotateCcw className="h-4 w-4" /> {t("Roll back")}
            </WorkspaceButton> : null}
            {data.serving && ["inactive", "live", "paused"].includes(data.serving.state) ? (
              <WorkspaceButton
                disabled={servingActionDisabled}
                onClick={retireIsPermanent ? confirmRetire : () => void servingCommand("retire")}
                tone="danger"
              >
                {t(data.serving.state === "inactive" ? "Archive draft" : "Retire Character")}
              </WorkspaceButton>
            ) : null}
          </div>
        </details>
      </aside>
      {confirmSpec ? <ConfirmDialog onClose={() => setConfirmSpec(null)} spec={confirmSpec} /> : null}
    </div>
  );
}
