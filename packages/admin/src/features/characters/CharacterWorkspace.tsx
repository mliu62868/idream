"use client";

import { AdminText, adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import Link from "next/link";
import Image from "next/image";
import {
  adminCommandAcceptedSchema,
  adminCommandStatusSchema,
  characterQaAuthorityMatches,
  latestCharacterQaAuthorityRun,
  characterLookArchiveResponseSchema,
  characterReferenceSetPublishResponseSchema,
  characterVoiceClipReclaimResponseSchema,
  characterPortfolioResponseSchema,
  characterWorkspaceDetailSchema,
  type AdminCommandStatus,
  type CharacterPortfolioItem,
  type CharacterMediaOperationsProjection,
  type CharacterQaCheckInput,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import {
  ArrowRight,
  Clock3,
  ImageIcon,
  Plus,
  RefreshCcw,
  Rocket,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import {
  CharacterAssetStudio,
  characterAssetReadinessAction,
} from "@/features/characters/CharacterAssetStudio";
import { CharacterVideoStudio } from "@/features/characters/CharacterVideoStudio";
import { CharacterCreateWizard } from "@/features/characters/CharacterCreateWizard";
import { CharacterVoicePanel } from "@/features/characters/CharacterVoicePanel";
import {
  VisualIdentityExperimentWorkbench,
  type ActivateIdentityCandidateInput,
} from "@/features/characters/VisualIdentityExperimentWorkbench";
import { apiWrite } from "@/components/admin/api";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import {
  characterQaMutation,
  characterReleaseProposalMutation,
  characterReleaseReviewMutation,
  characterWorkspaceTabFromSearch,
  characterWorkspaceTabs,
  type CharacterWorkspaceTab,
} from "@/features/image-workflow-transport";
import {
  EmptyWorkspace,
  LoadingWorkspace,
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import {
  AdminV2RequestError,
  adminV2Request,
  setWorkspaceUrl,
} from "@/lib/admin-v2-api";
import { createLatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";
import {
  CHARACTER_PORTFOLIO_PHASES,
  CHARACTER_PORTFOLIO_READINESS_STATES,
  CHARACTER_PORTFOLIO_SERVING_STATES,
  characterPortfolioQuery,
  parseCharacterPortfolioUrl,
  type CharacterPortfolioUrlState,
} from "./portfolio-query";

type Permissions = {
  read: boolean;
  writeProject: boolean;
  proposeRelease: boolean;
  publishRelease: boolean;
  reviewRelease: boolean;
  writeVisual: boolean;
  evaluateRoute: boolean;
  readAssets: boolean;
  createAssets: boolean;
  reviewAssets: boolean;
  manageVoiceDefaults: boolean;
};

type ProjectDraft = Pick<
  CharacterWorkspaceDetail["project"],
  | "ownerId"
  | "audience"
  | "companionNeed"
  | "hypothesis"
  | "differentiation"
  | "targetPlacementKeys"
  | "successCriteria"
  | "productionPackage"
  | "qaPlan"
  | "plannedLaunchAt"
>;

type Tab = CharacterWorkspaceTab;

const characterWorkspaceTabLabels: Record<Tab, string> = {
  project: "Details",
  visual: "Visual identity",
  assets: "Images",
  video: "Video",
  voice: "Voice",
  preview: "Launch preview",
  release: "Release",
  monitor: "Live performance",
};

export function characterWorkspaceTabLabel(tab: Tab) {
  return characterWorkspaceTabLabels[tab];
}

const mediaOperationLabels = {
  image: "Image",
  video: "Video",
  voice: "Voice",
} as const;

const mediaRecoveryLabels = {
  not_needed: "No recovery needed",
  retryable: "Retry available",
  operator_action: "Operator action required",
  not_recoverable: "Not retryable",
  unavailable: "Recovery unavailable",
} as const;

function mediaOperationDuration(durationMs: number | null) {
  if (durationMs === null) return "Unavailable";
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function shouldReleaseVoiceReclaimIdempotencyKey(cause: unknown) {
  if (!(cause instanceof AdminV2RequestError)) return false;
  const details =
    cause.details &&
    typeof cause.details === "object" &&
    !Array.isArray(cause.details)
      ? cause.details as Record<string, unknown>
      : {};
  return !(
    cause.status === 409 &&
    cause.code === "conflict" &&
    details.reason === "command_in_progress"
  );
}

export function CharacterMediaOperationsCard({
  projection,
  canReclaimVoice = false,
  reclaimingVoiceRequestId = null,
  onReclaimVoice,
}: {
  readonly projection: CharacterMediaOperationsProjection;
  readonly canReclaimVoice?: boolean;
  readonly reclaimingVoiceRequestId?: string | null;
  readonly onReclaimVoice?: (input: {
    readonly requestId: string;
    readonly actionHref: string;
    readonly confirmation: string;
    readonly reason: string;
  }) => Promise<void>;
}) {
  const { t } = useAdminI18n();
  const [pendingReclaim, setPendingReclaim] = useState<{
    readonly requestId: string;
    readonly actionHref: string;
    readonly confirmation: string;
    readonly attemptNo: number;
    readonly provider: string | null;
  } | null>(null);
  return (
    <>
    <section
      aria-labelledby="character-media-operations-title"
      className="mt-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]"
    >
      <div className="border-b border-[var(--ad-border)] px-4 py-3">
        <h3 className="text-sm font-semibold" id="character-media-operations-title">
          {t("Recent media operations")}
        </h3>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          {t("Latest authoritative request per modality")}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-[var(--ad-text-muted)]">
            <tr className="border-b border-[var(--ad-border)]">
              <th className="px-4 py-2 font-semibold" scope="col">{t("Media")}</th>
              <th className="px-3 py-2 font-semibold" scope="col">{t("Latest run")}</th>
              <th className="px-3 py-2 font-semibold" scope="col">{t("Evidence")}</th>
              <th className="px-3 py-2 font-semibold" scope="col">{t("Recovery")}</th>
              <th className="px-4 py-2 text-right font-semibold" scope="col">{t("Open")}</th>
            </tr>
          </thead>
          <tbody>
            {projection.operations.map((operation) => (
              <tr
                className="border-b border-[var(--ad-border)] last:border-b-0"
                data-media-operation={operation.modality}
                key={operation.modality}
              >
                <th className="px-4 py-3 text-sm font-semibold" scope="row">
                  {t(mediaOperationLabels[operation.modality])}
                </th>
                <td className="px-3 py-3">
                  {operation.status ? <StatusBadge value={operation.status} /> : t("No runs")}
                  <span className="mt-1 block max-w-44 truncate font-mono text-[10px] text-[var(--ad-text-muted)]">
                    {operation.requestId ?? t("Unavailable")}
                  </span>
                </td>
                <td className="px-3 py-3 text-[var(--ad-text-muted)]">
                  <span className="block">
                    {operation.provider?.key ?? t("Provider unavailable")}
                    {operation.attempt ? ` · ${t("Attempt")} ${operation.attempt.number}` : ""}
                  </span>
                  <span className="mt-1 block">
                    {t("Time")} {mediaOperationDuration(operation.timing?.latencyMs ?? null)}
                    {" · "}{operation.costDreamcoins === null
                      ? t("Cost unavailable")
                      : t("{cost} Dreamcoins", { cost: operation.costDreamcoins })}
                    {" · "}{operation.output
                      ? t(operation.output.availability === "available"
                          ? "Available"
                          : operation.output.availability === "deleted"
                            ? "Deleted"
                            : "Unavailable")
                      : t("No output")}
                  </span>
                </td>
                <td className="max-w-64 px-3 py-3">
                  <span className="font-semibold">
                    {t(mediaRecoveryLabels[operation.recoverability.state])}
                  </span>
                  {operation.recoverability.reason ? (
                    <span className="mt-1 block text-[var(--ad-text-muted)]">
                      {t(operation.recoverability.reason)}
                    </span>
                  ) : null}
                  {operation.modality === "voice" &&
                  operation.requestId &&
                  operation.recoverability.actionHref &&
                  operation.recoverability.actionConfirmation ? (
                    <button
                      className="mt-2 block font-semibold underline disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        !canReclaimVoice ||
                        !onReclaimVoice ||
                        reclaimingVoiceRequestId === operation.requestId
                      }
                      onClick={() =>
                        setPendingReclaim({
                          requestId: operation.requestId!,
                          actionHref: operation.recoverability.actionHref!,
                          confirmation:
                            operation.recoverability.actionConfirmation!,
                          attemptNo: operation.attempt?.number ?? 1,
                          provider: operation.provider?.key ?? null,
                        })
                      }
                      type="button"
                    >
                      {t(
                        reclaimingVoiceRequestId === operation.requestId
                          ? "Reclaiming Voice request…"
                          : "Reclaim Voice request",
                      )}
                    </button>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link className="font-semibold underline" href={operation.studioHref}>
                    {t("Open Studio")}
                  </Link>
                  {operation.operationsHref ? (
                    <Link className="ml-3 font-semibold underline" href={operation.operationsHref}>
                      {t("Open operations")}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--ad-border)] px-4 py-2 text-xs text-[var(--ad-text-muted)]">
        {t("Run completion does not approve or publish an asset.")} {t("Review and Release remain separate decisions.")}
      </p>
    </section>
    {pendingReclaim && onReclaimVoice ? (
      <ConfirmDialog
        onClose={() => setPendingReclaim(null)}
        spec={{
          title: t("Reclaim expired Voice request"),
          summary: (
            <div className="space-y-2">
              <p>
                {t("Request")} <code>{pendingReclaim.requestId}</code>
                {" · "}{t("Attempt")} {pendingReclaim.attemptNo}
                {" · "}{pendingReclaim.provider ?? t("Provider unavailable")}
              </p>
              <p>
                {t(
                  "The reclaim reuses the pinned provider request and idempotency key, then rechecks the user's current Voice allowance and Dreamcoin balance.",
                )}
              </p>
            </div>
          ),
          destructive: {
            expectedName: pendingReclaim.confirmation,
            inputLabel: t("Type the projected Voice reclaim confirmation"),
          },
          reasonLabel: t("Operational reason (≥3)"),
          submitLabel: t("Reclaim Voice request"),
          onSubmit: (reason) =>
            onReclaimVoice({
              requestId: pendingReclaim.requestId,
              actionHref: pendingReclaim.actionHref,
              confirmation: pendingReclaim.confirmation,
              reason,
            }),
        }}
      />
    ) : null}
    </>
  );
}

const visualIdentityRepairBlockers = new Set([
  "visual_identity_unsealed",
  "visual_traits_incomplete",
]);

const visualReferenceRepairBlockers = new Set([
  "reference_set_not_active",
  "reference_set_unsealed",
  "reference_assets_unavailable",
]);

const visualRouteRepairBlockers = new Set([
  "generation_route_unqualified",
  "generation_route_stale",
]);

// SPEC: 阻塞入口必须落到能完成动作的控件，而不是只回到 Visual 页首。
// INTENT: identity -> references -> route 是生产权威的固定顺序；多项阻塞时只给最早可执行动作。
export function characterVisualReadinessTarget(
  blockerCodes: readonly string[],
): string | null {
  if (blockerCodes.some((code) => visualIdentityRepairBlockers.has(code))) {
    return "visual-identity-version";
  }
  if (blockerCodes.some((code) => visualReferenceRepairBlockers.has(code))) {
    return "visual-reference-set";
  }
  if (blockerCodes.some((code) => visualRouteRepairBlockers.has(code))) {
    return "route-qualification-workbench";
  }
  return null;
}

// SPEC: 视频是 character I2V，源图恒为角色主图（service.ts 的 mode==="video" 守卫）。
// INTENT: 主图不可用时用户端视频请求会 409，但角色本身在线、运营面看不出异常。只在「已上线 +
// 主图不可用」这个真正可行动的组合下告警——未上线时缺主图已由前面的生产步骤覆盖，再报一次是噪音。
// 不新增契约字段：detail.character.imageUrl 为 null 已等价于后端的 characterImageAvailable=false。
export function characterVideoSourceBroken(data: CharacterWorkspaceDetail) {
  return data.serving?.state === "live" && data.character.imageUrl === null;
}

export type CharacterOperationsFact = {
  readonly label: string;
  readonly value: string;
  readonly alert: boolean;
};

// SPEC: 角色详情只陈述当前事实，不把服务端推导的动作包装成强制流程。
// INTENT: 版本号、项目 ID 这类排障字段留在「技术状态」里。
// 采纳数用 missingPurposes 反推，不再数一遍 draftAssetPack——路线权威只有一份。
export function characterOperationsFacts(
  data: CharacterWorkspaceDetail,
): readonly CharacterOperationsFact[] {
  const currentRelease =
    data.releases.find(
      ({ release }) => release.id === data.serving?.currentReleaseId,
    )?.release ?? null;
  const visiblePack =
    data.journey.release.servingState === "live"
      ? data.journey.assetPack.live
      : data.journey.assetPack.draft;
  const changedCount = data.preview.changedFields.length;
  const releaseOrdinals = characterReleaseOrdinals(data.releases);
  // SPEC: 身份图片按 mediaAssetId 去重后计数。
  // INTENT: anchors 与 references 会重叠（已发布参考集里的图同时也是锚点），相加会把同一张
  // 图数两次 —— 这个角色实际 15 张，页面写 16。
  const identityImageCount = new Set(
    [...data.visual.anchors, ...data.visual.references]
      .filter((asset) => asset.available)
      .map((asset) => asset.mediaAssetId),
  ).size;
  return [
    {
      label: "Serving",
      value: data.serving?.state ?? "not_live",
      alert: data.serving?.state !== "live",
    },
    { label: "Visibility", value: data.character.visibility, alert: false },
    {
      label: "Live release",
      value: currentRelease
        ? `#${releaseOrdinals.get(currentRelease.id) ?? "?"} · ${(currentRelease.publishedAt ?? currentRelease.createdAt).slice(0, 10)}`
        : "None published",
      alert: currentRelease === null,
    },
    {
      label: "Unpublished changes",
      value: changedCount === 0 ? "None" : String(changedCount),
      alert: changedCount > 0,
    },
    {
      label: "Image pack",
      value: `${visiblePack.completed}/${visiblePack.total}`,
      alert: visiblePack.completed < visiblePack.total,
    },
    {
      label: "Owner",
      value: data.project.ownerId ?? "Unassigned",
      alert: data.project.ownerId === null,
    },
    {
      label: "Identity images",
      value: String(identityImageCount),
      alert: identityImageCount === 0,
    },
    // SPEC: 这一格数的是"能拿去生成视频的源图片"，不是视频数量。
    // INTENT: visual.videoSources 服务端就是一条 type:"image" 的查询，原先标签写的是
    // "Videos"，于是"视频 15"其实是 15 张图片（这个角色只有 1 个视频），而且数值恰好和图片数
    // 相同，误导更甚。0 张是真实信号：没有源图就生成不了视频。
    {
      label: "Video source images",
      value: String(
        data.visual.videoSources.filter((asset) => asset.available).length,
      ),
      alert: data.visual.videoSources.every((asset) => !asset.available),
    },
  ];
}

type CharacterMutationNotice =
  | {
      readonly kind: "mutation_in_flight";
      readonly message: string;
    }
  | {
      readonly kind: "command_pending";
      readonly message: string;
      readonly commandId: string;
    }
  | {
      readonly kind: "command_submission_unknown";
      readonly message: string;
    }
  | {
      readonly kind: "command_reconfirmation_required";
      readonly message: string;
    }
  | {
      readonly kind: "refresh_required";
      readonly message: string;
      readonly commandId?: string;
    };

type RunCommittedCharacterMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

type PendingCharacterCommand = {
  readonly commandId: string | null;
  readonly action: string;
  readonly signature: string;
  readonly endpoint?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly createdAt: number;
  readonly autoReplayUntil?: number;
  readonly terminal: boolean;
};

type CharacterCommandStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION = 1;
const UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS = 5 * 60_000;

function isSamePendingCharacterCommand(
  left: PendingCharacterCommand,
  right: PendingCharacterCommand,
) {
  if (left.commandId !== null || right.commandId !== null) {
    return left.commandId !== null && left.commandId === right.commandId;
  }
  return (
    left.signature === right.signature &&
    left.idempotencyKey === right.idempotencyKey
  );
}

type CharacterMutationRefreshResult<T> =
  | {
      readonly status: "superseded";
      readonly projection?: T;
      readonly error?: unknown;
    }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "kept_locked"; readonly projection: T }
  | {
      readonly status: "cleanup_failed";
      readonly projection: T;
      readonly error: unknown;
    }
  | { readonly status: "unlocked"; readonly projection: T };

export function createCharacterMutationAuthorityCoordinator() {
  let generation = 0;
  let journal: PendingCharacterCommand | null = null;
  let notice: CharacterMutationNotice | null = null;
  let pendingCleanup: {
    readonly generation: number;
    readonly cleanup: (() => void) | null;
  } | null = null;

  const advanceGeneration = () => {
    generation += 1;
    pendingCleanup = null;
    return generation;
  };

  return {
    advanceGeneration,
    clearCommand(command: PendingCharacterCommand) {
      if (!journal || !isSamePendingCharacterCommand(journal, command))
        return false;
      advanceGeneration();
      journal = null;
      notice = null;
      return true;
    },
    currentCommandIs(command: PendingCharacterCommand) {
      return (
        journal !== null && isSamePendingCharacterCommand(journal, command)
      );
    },
    getGeneration() {
      return generation;
    },
    getSnapshot() {
      return {
        journal,
        notice,
        writesLocked: journal !== null || notice !== null,
      } as const;
    },
    isCurrentGeneration(candidate: number) {
      return generation === candidate;
    },
    rememberCommand(
      command: PendingCharacterCommand,
      nextNotice: CharacterMutationNotice,
    ) {
      if (!journal || !isSamePendingCharacterCommand(journal, command)) {
        advanceGeneration();
      }
      journal = command;
      notice = nextNotice;
    },
    setNotice(nextNotice: CharacterMutationNotice | null) {
      notice = nextNotice;
    },
    async refresh<T>(input: {
      readonly load: () => Promise<T>;
      readonly canUnlock: (projection: T) => boolean;
      readonly onUnlock?: () => void;
      readonly reusePendingCleanup?: boolean;
    }): Promise<CharacterMutationRefreshResult<T>> {
      const refreshGeneration = generation;
      if (!input.reusePendingCleanup) {
        pendingCleanup = {
          generation: refreshGeneration,
          cleanup: input.onUnlock ?? null,
        };
      }
      let projection: T;
      try {
        projection = await input.load();
      } catch (error) {
        if (generation !== refreshGeneration) {
          return { status: "superseded", error };
        }
        return { status: "failed", error };
      }
      if (generation !== refreshGeneration) {
        return { status: "superseded", projection };
      }
      if (!input.canUnlock(projection)) {
        pendingCleanup = null;
        return { status: "kept_locked", projection };
      }
      const cleanup =
        pendingCleanup?.generation === refreshGeneration
          ? pendingCleanup.cleanup
          : null;
      pendingCleanup = null;
      notice = null;
      try {
        cleanup?.();
      } catch (error) {
        return { status: "cleanup_failed", projection, error };
      }
      return { status: "unlocked", projection };
    },
  };
}

export function commandIdempotencyStorageKey(
  actorId: string,
  characterId: string,
) {
  return `idream:admin:character:${encodeURIComponent(actorId)}:${encodeURIComponent(characterId)}:command-idempotency`;
}

export function pendingCommandStorageKey(actorId: string, characterId: string) {
  return `idream:admin:character:${encodeURIComponent(actorId)}:${encodeURIComponent(characterId)}:pending-command`;
}

function browserCommandEnvironment() {
  return typeof window === "undefined" ? "" : window.location.origin;
}

function browserCharacterCommandStorage(): CharacterCommandStorage | null {
  if (typeof window === "undefined") return null;
  const candidates: Storage[] = [];
  for (const candidate of ["localStorage", "sessionStorage"] as const) {
    try {
      candidates.push(window[candidate]);
    } catch {
      // Keep probing the next browser-backed store.
    }
  }
  if (candidates.length === 0) return null;
  return {
    getItem(key) {
      let lastError: unknown;
      for (const storage of candidates) {
        try {
          const value = storage.getItem(key);
          if (value !== null) return value;
        } catch (cause) {
          lastError = cause;
        }
      }
      if (lastError) throw lastError;
      return null;
    },
    setItem(key, value) {
      let stored = false;
      let lastError: unknown;
      for (const storage of candidates) {
        try {
          storage.setItem(key, value);
          stored = true;
        } catch (cause) {
          lastError = cause;
        }
      }
      if (!stored && lastError) throw lastError;
    },
    removeItem(key) {
      let removed = false;
      let lastError: unknown;
      for (const storage of candidates) {
        try {
          storage.removeItem(key);
          removed = true;
        } catch (cause) {
          lastError = cause;
        }
      }
      if (!removed && lastError) throw lastError;
    },
  };
}

function readStoredStringRecord(storage: CharacterCommandStorage, key: string) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return {} as Record<string, string>;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function getOrCreateCharacterCommandIdempotencyKey(
  storage: CharacterCommandStorage,
  actorId: string,
  characterId: string,
  signature: string,
  createKey: () => string = () => crypto.randomUUID(),
) {
  const storageKey = commandIdempotencyStorageKey(actorId, characterId);
  const identities = readStoredStringRecord(storage, storageKey);
  const existing = identities[signature];
  if (existing) return existing;
  const created = createKey();
  try {
    storage.setItem(
      storageKey,
      JSON.stringify({
        ...identities,
        [signature]: created,
      }),
    );
  } catch {
    // The in-memory ReleasePanel fallback still protects the current page.
  }
  return created;
}

export function releaseCharacterCommandIdempotencyKey(
  storage: CharacterCommandStorage,
  actorId: string,
  characterId: string,
  signature: string,
) {
  const storageKey = commandIdempotencyStorageKey(actorId, characterId);
  const identities = readStoredStringRecord(storage, storageKey);
  if (!Object.hasOwn(identities, signature)) return;
  delete identities[signature];
  try {
    if (Object.keys(identities).length === 0) storage.removeItem(storageKey);
    else storage.setItem(storageKey, JSON.stringify(identities));
  } catch {
    // A storage failure must not turn a terminal command into a UI failure.
  }
}

export function parsePendingCharacterCommandJournal(
  raw: string,
  actorId: string,
  environment: string,
): PendingCharacterCommand | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.schemaVersion !== CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION ||
      record.actorId !== actorId ||
      record.environment !== environment
    )
      return null;
    if (
      !(record.commandId === null || typeof record.commandId === "string") ||
      typeof record.action !== "string" ||
      typeof record.signature !== "string" ||
      typeof record.createdAt !== "number" ||
      !Number.isFinite(record.createdAt) ||
      record.createdAt <= 0
    )
      return null;
    if (
      Object.hasOwn(record, "autoReplayUntil") &&
      (typeof record.autoReplayUntil !== "number" ||
        !Number.isFinite(record.autoReplayUntil))
    )
      return null;
    if (
      record.commandId === null &&
      (typeof record.endpoint !== "string" ||
        typeof record.idempotencyKey !== "string" ||
        !Object.hasOwn(record, "body"))
    )
      return null;
    return {
      commandId: record.commandId,
      action: record.action,
      signature: record.signature,
      ...(typeof record.endpoint === "string"
        ? { endpoint: record.endpoint }
        : {}),
      ...(Object.hasOwn(record, "body") ? { body: record.body } : {}),
      ...(typeof record.idempotencyKey === "string"
        ? { idempotencyKey: record.idempotencyKey }
        : {}),
      createdAt: record.createdAt,
      ...(typeof record.autoReplayUntil === "number"
        ? { autoReplayUntil: record.autoReplayUntil }
        : {}),
      terminal: false,
    };
  } catch {
    return null;
  }
}

function readPendingCharacterCommand(
  characterId: string,
  actorId: string,
): PendingCharacterCommand | null {
  const storage = browserCharacterCommandStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingCommandStorageKey(actorId, characterId));
    if (!raw) return null;
    return parsePendingCharacterCommandJournal(
      raw,
      actorId,
      browserCommandEnvironment(),
    );
  } catch {
    return null;
  }
}

function persistPendingCharacterCommand(
  characterId: string,
  actorId: string,
  command: PendingCharacterCommand,
) {
  const storage = browserCharacterCommandStorage();
  if (!storage) return;
  try {
    storage.setItem(
      pendingCommandStorageKey(actorId, characterId),
      JSON.stringify({
        schemaVersion: CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION,
        actorId,
        environment: browserCommandEnvironment(),
        commandId: command.commandId,
        action: command.action,
        signature: command.signature,
        endpoint: command.endpoint,
        body: command.body,
        idempotencyKey: command.idempotencyKey,
        createdAt: command.createdAt,
        autoReplayUntil:
          command.autoReplayUntil ??
          command.createdAt + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS,
      }),
    );
  } catch {
    // The current page still keeps the command locked and polling.
  }
}

function clearPendingCharacterCommand(
  characterId: string,
  actorId: string,
  command: PendingCharacterCommand,
) {
  const storage = browserCharacterCommandStorage();
  if (!storage) return true;
  try {
    const raw = storage.getItem(pendingCommandStorageKey(actorId, characterId));
    if (raw) {
      const stored = parsePendingCharacterCommandJournal(
        raw,
        actorId,
        browserCommandEnvironment(),
      );
      if (stored && !isSamePendingCharacterCommand(stored, command))
        return false;
    }
    storage.removeItem(pendingCommandStorageKey(actorId, characterId));
    return true;
  } catch {
    // Terminal state is authoritative even when browser storage is unavailable.
    return true;
  }
}

function isDefinitiveCommandRejection(cause: unknown) {
  return (
    cause instanceof AdminV2RequestError &&
    [400, 401, 403, 404, 409, 422].includes(cause.status)
  );
}

export function characterCommandReplayFailureDisposition(
  status: number | null,
): "keep_locked" | "reconcile" | "retry" {
  if (status === 401 || status === 403) return "keep_locked";
  if (status !== null && [400, 404, 409, 422].includes(status)) {
    return "reconcile";
  }
  return "retry";
}

function activeCommandConflict(cause: unknown) {
  if (!(cause instanceof AdminV2RequestError) || cause.status !== 409)
    return null;
  if (
    !cause.details ||
    typeof cause.details !== "object" ||
    Array.isArray(cause.details)
  ) {
    return null;
  }
  const details = cause.details as Record<string, unknown>;
  if (typeof details.activeCommandId !== "string") return null;
  return {
    commandId: details.activeCommandId,
    commandType:
      typeof details.activeCommandType === "string"
        ? details.activeCommandType
        : "character.command",
  };
}

export function characterCommandJournalCanAutoReplay(
  command: Pick<
    PendingCharacterCommand,
    "commandId" | "createdAt" | "autoReplayUntil"
  >,
  now = Date.now(),
) {
  if (command.commandId) return true;
  return (
    now <=
    (command.autoReplayUntil ??
      command.createdAt + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS)
  );
}

function percent(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

// SPEC: 零观测本身不是结论——「窗口还没走完」要等，「整个窗口都没有」要查投放和埋点。
// INTENT: 不加字段，maturity 已经把时间维度算好了；缺的只是把这个组合翻译成一句能照做的话。
export function characterNoDataDiagnosis(metric: {
  readonly qualityState: string;
  readonly maturity: string;
  readonly window: string;
}) {
  if (metric.qualityState !== "no_data") return null;
  return metric.maturity === "immature"
    ? {
        message:
          "No observations yet. The {window} window has not closed since publish.",
        alert: false,
      }
    : {
        message:
          "No observations across a full {window} window. Check placement targeting and event delivery.",
        alert: true,
      };
}

// SPEC: 零数据首屏只显示一次诊断，不重复渲染多个完全相同的 N/A 指标行。
// INTENT: 观测窗口仍由服务端权威决定；这里只把“还没有有效样本”压缩成一个可理解的空状态。
export function characterPerformanceHasObservations(
  performance: CharacterWorkspaceDetail["performance"],
) {
  return performance.some(
    (metric) =>
      metric.sampleSize > 0 ||
      metric.qceRate !== null ||
      metric.sameCharacterD7 !== null ||
      metric.contributionMargin.valueMicros !== null,
  );
}

export function characterPortfolioPerformanceLabel(
  performance: Pick<
    CharacterPortfolioItem["performance"][number],
    "maturity" | "qceRate" | "sameCharacterD7"
  > | null,
) {
  if (!performance) {
    return "28d performance will appear after sufficient live traffic.";
  }
  const metrics = [
    performance.qceRate === null
      ? null
      : `28d QCE ${percent(performance.qceRate)}`,
    performance.sameCharacterD7 === null
      ? null
      : `D7 ${percent(performance.sameCharacterD7)}`,
  ].filter((metric): metric is string => metric !== null);
  if (metrics.length === 0) {
    return "28d performance will appear after sufficient live traffic.";
  }
  return `${metrics.join(" · ")} · ${performance.maturity.replaceAll("_", " ")}`;
}

// SPEC: 发布卡片与回滚下拉必须让运营一眼分辨"哪个更新"。
// INTENT: CharacterRelease.version 是行级乐观锁计数（每次改动 +1），不是发布序号——
// 直接渲染成 "Release v{version}" 会出现"v2 比 v1 更早发布"这种读反的顺序。
// 这里按发布时间给出单调递增的序号；version 仍用于命令的并发校验，只在技术证据里出现。
export function characterReleaseOrdinals(
  items: readonly { readonly release: { id: string; publishedAt: string | null; createdAt: string } }[],
) {
  const stamp = (release: { publishedAt: string | null; createdAt: string }) =>
    Date.parse(release.publishedAt ?? release.createdAt);
  return new Map(
    [...items]
      .sort((left, right) => stamp(left.release) - stamp(right.release))
      .map((item, index) => [item.release.id, index + 1] as const),
  );
}

export function characterMonitorWindows(
  monitors: ReadonlyArray<{ readonly window: string }>,
) {
  return [
    ...new Set([
      "route_qualification",
      "24h",
      "72h",
      ...monitors.map((monitor) => monitor.window),
    ]),
  ];
}

function characterCommandActionLabel(commandType: string) {
  return commandType
    .replace(/^character\./, "")
    .replaceAll(".", " ")
    .replaceAll("_", " ");
}

function pendingCommandFromAuthority(
  command: AdminCommandStatus,
): PendingCharacterCommand {
  return {
    commandId: command.commandId,
    action: characterCommandActionLabel(command.commandType),
    signature: `authority:${command.commandId}`,
    createdAt: Date.parse(command.createdAt),
    terminal: false,
  };
}

export function committedCharacterProjectionWarning(
  action: string,
  cause: unknown,
) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return `${action} was committed, but the authoritative Character workspace could not be refreshed${detail}. Refresh the authoritative workspace before another write.`;
}

function permissionDenied(label: string) {
  return (
    <section
      aria-labelledby="permission-title"
      className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"
    >
      <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
      <h2 className="mt-4 text-lg font-semibold" id="permission-title">
        <AdminText text="No permission" />
      </h2>
      <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
        <AdminText text="Your effective grants do not include" /> {label}
        <AdminText text=". Ask an administrator for the matching scoped permission." />
      </p>
    </section>
  );
}

export function CharacterPortfolioVisual({
  canOpenAssets,
  eager = false,
  linkToAssets = true,
  name,
  variant = "compact",
  visualProduction,
}: {
  canOpenAssets: boolean;
  eager?: boolean;
  linkToAssets?: boolean;
  name: string;
  variant?: "compact" | "featured" | "tile";
  visualProduction: CharacterPortfolioItem["visualProduction"];
}) {
  const { t } = useAdminI18n();
  const draftCount = visualProduction.draftPurposes.length;
  const liveCount = visualProduction.livePurposes.length;
  const canRenderPrimaryImage =
    visualProduction.primaryImageUrl !== null &&
    (canOpenAssets || visualProduction.primaryImageSource !== "draft");
  const mediaClassName =
    variant === "featured"
      ? "relative min-h-[320px] overflow-hidden bg-black/[0.04] sm:min-h-[360px]"
      : variant === "tile"
        ? "relative aspect-[4/5] w-full overflow-hidden rounded-lg bg-black/[0.04]"
        : "relative h-20 w-20 overflow-hidden rounded-lg bg-black/[0.04]";
  const content = (
    <>
      <div className={mediaClassName}>
        {canRenderPrimaryImage ? (
          <Image
            alt={t("{name} primary role portrait", { name })}
            className="h-full w-full object-cover"
            height={variant === "compact" ? 80 : 640}
            loading={eager ? "eager" : "lazy"}
            src={visualProduction.primaryImageUrl as string}
            unoptimized
            width={variant === "compact" ? 80 : 720}
          />
        ) : (
          <div className="grid h-full min-h-20 w-full place-items-center text-[var(--ad-text-muted)]">
            <div className="flex flex-col items-center gap-2">
              <ImageIcon
                aria-hidden="true"
                className={variant === "compact" ? "h-5 w-5" : "h-8 w-8"}
              />
              <span
                className={
                  variant === "compact" ? "sr-only" : "text-xs font-semibold"
                }
              >
                {t("No primary role portrait")}
              </span>
            </div>
          </div>
        )}
        {variant === "compact" &&
        canRenderPrimaryImage &&
        visualProduction.primaryImageSource ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {visualProduction.primaryImageSource === "draft"
              ? t("Draft portrait")
              : t("Live portrait")}
          </span>
        ) : null}
      </div>
      {variant === "compact" ? (
        <p className="mt-2 text-[10px] leading-4 text-[var(--ad-text-muted)]">
          {t("Draft")} {draftCount} {t("of 3")}
          <span aria-hidden="true"> · </span>
          <span>
            {t("Live")} {liveCount} {t("of 3")}
          </span>
        </p>
      ) : null}
    </>
  );
  const className =
    variant === "compact"
      ? "block w-24 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
      : "block h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--ad-ink)]";
  return canOpenAssets && linkToAssets ? (
    <Link
      aria-label={t(
        "{name}: open role-image assets, Draft {draftCount} of 3, Live {liveCount} of 3",
        { name, draftCount, liveCount },
      )}
      className={`${className} hover:opacity-90`}
      href={visualProduction.deepLink}
    >
      {content}
    </Link>
  ) : (
    <div
      className={
        variant === "compact"
          ? "w-24"
          : variant === "featured"
            ? "h-full w-full"
            : "w-full"
      }
    >
      {content}
    </div>
  );
}

type CharacterPortfolioPrimaryAction = {
  readonly description: string;
  readonly eyebrow: string;
  readonly href: string;
  readonly label: string;
  readonly requiresAssets: boolean;
};

const characterPortfolioPrimaryActionCopy: Record<
  CharacterPortfolioItem["journey"]["primaryAction"]["code"],
  Omit<CharacterPortfolioPrimaryAction, "href">
> = {
  recover_active_command: {
    description:
      "Finish or reconcile the command that currently owns this Character.",
    eyebrow: "Mutation in progress",
    label: "Open active command",
    requiresAssets: false,
  },
  create_primary_portrait: {
    description:
      "Start here: lock the face once, then reuse it for every new image.",
    eyebrow: "First-time setup",
    label: "Create first identity portrait",
    requiresAssets: true,
  },
  prepare_image_production: {
    description:
      "Use the existing live portrait once, then create future images without changing the live character.",
    eyebrow: "Enable image production",
    label: "Use existing portrait",
    requiresAssets: true,
  },
  complete_image_route: {
    description:
      "The identity portrait is locked. Activate a compatible image route before creating an image.",
    eyebrow: "Image route setup",
    label: "Complete image route setup",
    requiresAssets: false,
  },
  continue_image_run: {
    description: "Return to the latest unfinished image without starting over.",
    eyebrow: "Image in progress",
    label: "Continue current image",
    requiresAssets: true,
  },
  continue_asset_pack: {
    description: "Complete the portrait, hero, and chat image set.",
    eyebrow: "Image pack in progress",
    label: "Continue filling image pack",
    requiresAssets: true,
  },
  run_preview_qa: {
    description: "Check the customer-facing draft before publishing.",
    eyebrow: "Ready for launch review",
    label: "Review launch preview",
    requiresAssets: false,
  },
  review_candidate_release: {
    description: "Confirm the candidate version and release evidence.",
    eyebrow: "Release in progress",
    label: "Continue release review",
    requiresAssets: false,
  },
  monitor_live_character: {
    description: "Open live monitoring and performance evidence.",
    eyebrow: "Live character",
    label: "Review live character",
    requiresAssets: false,
  },
};

export function resolveCharacterPortfolioPrimaryAction(
  item: CharacterPortfolioItem,
): CharacterPortfolioPrimaryAction {
  return {
    ...characterPortfolioPrimaryActionCopy[item.journey.primaryAction.code],
    href: item.journey.primaryAction.deepLink,
  };
}

export function characterPortfolioState(item: CharacterPortfolioItem) {
  if (
    item.serving.state === "live" ||
    item.journey.stage === "live_operations"
  ) {
    return { label: "Live", tone: "text-[var(--ad-green-text)]" } as const;
  }
  if (item.journey.stage === "image_production") {
    return {
      label: "In production",
      tone: "text-[var(--ad-blue-text)]",
    } as const;
  }
  if (item.journey.stage === "preview_qa") {
    return {
      label: "Ready for preview",
      tone: "text-[var(--ad-blue-text)]",
    } as const;
  }
  if (item.journey.stage === "release_review") {
    return {
      label: "Pending release",
      tone: "text-[var(--ad-yellow-text)]",
    } as const;
  }
  return { label: "Draft", tone: "text-[var(--ad-text-muted)]" } as const;
}

export function CharacterPortfolioCard({
  canOpenAssets,
  canOpenProject,
  eager = false,
  item,
  mode,
}: {
  canOpenAssets: boolean;
  canOpenProject: boolean;
  eager?: boolean;
  item: CharacterPortfolioItem;
  mode: "studio" | "performance";
}) {
  const { t } = useAdminI18n();
  const performanceMode = mode === "performance";
  const performance =
    item.performance.find(
      (metric) => metric.window === "28d" && metric.placementId === null,
    ) ??
    item.performance.find((metric) => metric.window === "28d") ??
    null;
  const primaryAction = resolveCharacterPortfolioPrimaryAction(item);
  const canOpenNextAction =
    canOpenProject && (!primaryAction.requiresAssets || canOpenAssets);
  if (performanceMode) {
    return (
      <article className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors md:grid-cols-[96px_minmax(0,1fr)_minmax(220px,280px)]">
        <CharacterPortfolioVisual
          canOpenAssets={canOpenProject && canOpenAssets}
          eager={eager}
          name={item.name}
          visualProduction={item.visualProduction}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold text-[var(--ad-ink)]">
              {canOpenProject ? (
                <Link
                  className="hover:underline"
                  href={`/admin/characters/${encodeURIComponent(item.characterId)}`}
                >
                  {item.name}
                </Link>
              ) : (
                item.name
              )}
            </h3>
            <StatusBadge value={item.serving.state} />
            <StatusBadge value={item.readiness} />
          </div>
          <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
            {t(item.project.audience)} ·{" "}
            {t(item.project.phase.replaceAll("_", " "))}
          </p>
          <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
            {characterPortfolioPerformanceLabel(performance)}
          </p>
        </div>
        <div className="self-center rounded-lg border border-[var(--ad-border)] bg-black/[0.02] p-3 text-left text-xs text-[var(--ad-text-muted)]">
          <p className="font-semibold uppercase tracking-[0.14em]">
            {t(primaryAction.eyebrow)}
          </p>
          {canOpenNextAction ? (
            <Link
              className="mt-1 inline-flex min-h-8 items-center gap-1.5 text-sm font-semibold text-[var(--ad-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
              href={primaryAction.href}
            >
              {t(primaryAction.label)}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : (
            <span className="mt-1 block font-semibold text-[var(--ad-ink)]">
              {t("Performance only")}
            </span>
          )}
          <p className="mt-1 leading-5">{t(primaryAction.description)}</p>
          {item.latestDecision ? (
            <span className="mt-2 block border-t border-[var(--ad-border)] pt-2">
              {t("Latest decision:")} {item.latestDecision.decision}
            </span>
          ) : null}
        </div>
      </article>
    );
  }

  const state = characterPortfolioState(item);
  const content = (
    <>
      <CharacterPortfolioVisual
        canOpenAssets={canOpenAssets}
        eager={eager}
        linkToAssets={false}
        name={item.name}
        variant="tile"
        visualProduction={item.visualProduction}
      />
      <div className="pt-3">
        <h3 className="truncate text-base font-semibold text-[var(--ad-ink)]">
          {item.name}
        </h3>
        <p className={cn("mt-1 text-sm", state.tone)}>{t(state.label)}</p>
      </div>
    </>
  );

  return canOpenProject ? (
    <Link
      aria-label={t("Open {name}", { name: item.name })}
      className="group block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--ad-ink)]"
      data-layout="roster"
      href={`/admin/characters/${encodeURIComponent(item.characterId)}`}
    >
      <article className="transition-opacity group-hover:opacity-90">
        {content}
      </article>
    </Link>
  ) : (
    <article data-layout="roster">{content}</article>
  );
}

export function CharacterListEmptyState({
  filtered,
  attentionOnly = false,
  onClear,
}: {
  filtered: boolean;
  attentionOnly?: boolean;
  onClear: () => void;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-xl bg-[var(--ad-surface)] px-6 py-14 text-center">
      <h3 className="text-base font-semibold">
        {attentionOnly
          ? t("No character needs attention right now")
          : filtered
            ? t("No characters match these filters")
            : t("No characters yet")}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--ad-text-muted)]">
        {attentionOnly
          ? t(
              "Every live character has a complete image pack and is recording observations.",
            )
          : filtered
            ? t("Clear filters to return to all characters.")
            : t("No characters are available yet.")}
      </p>
      {filtered ? (
        <div className="mt-5">
          <WorkspaceButton onClick={onClear}>
            {t("Clear filters")}
          </WorkspaceButton>
        </div>
      ) : null}
    </section>
  );
}

function CharacterPortfolio({
  canOpenAssets,
  canCreate,
  canOpenProjects,
  canRead,
  mode,
}: {
  canOpenAssets: boolean;
  canCreate: boolean;
  canOpenProjects: boolean;
  canRead: boolean;
  mode: "studio" | "performance";
}) {
  const { locale, t } = useAdminI18n();
  const performanceMode = mode === "performance";
  const [items, setItems] = useState<CharacterPortfolioItem[]>([]);
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState("");
  const [servingState, setServingState] = useState("");
  const [readiness, setReadiness] = useState("");
  const [attention, setAttention] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState<{
    endCursor: string | null;
    hasNextPage: boolean;
  }>({ endCursor: null, hasNextPage: false });
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const successfulQueryKey = useRef<string | null>(null);

  const load = useCallback(
    async (
      next: CharacterPortfolioUrlState,
      historyMode: "none" | "push" | "replace",
    ) => {
      if (!canRead) return;
      const request = requestGate.current.begin();
      const queryKey = JSON.stringify(next);
      if (successfulQueryKey.current !== queryKey) {
        setItems([]);
        setPageInfo({ endCursor: null, hasNextPage: false });
        setAsOf(null);
      }
      setLoading(true);
      setError(null);
      try {
        const query = characterPortfolioQuery(next, true);
        if (historyMode !== "none") {
          const locationQuery = characterPortfolioQuery(next);
          window.history[historyMode === "push" ? "pushState" : "replaceState"](
            null,
            "",
            `${window.location.pathname}${locationQuery ? `?${locationQuery}` : ""}`,
          );
        }
        const data = await adminV2Request(
          `/api/v2/admin/characters/portfolio?${query}`,
          { schema: characterPortfolioResponseSchema },
        );
        if (!request.isCurrent()) return;
        setItems([...data.items]);
        setPageInfo(data.pageInfo);
        setAsOf(data.asOf);
        successfulQueryKey.current = queryKey;
      } catch (reason) {
        if (request.isCurrent()) {
          setError(
            reason instanceof Error
              ? reason.message
              : performanceMode
                ? "Character portfolio could not be loaded"
                : "Characters could not be loaded",
          );
        }
      } finally {
        if (request.isCurrent()) setLoading(false);
      }
    },
    [canRead, performanceMode],
  );

  useEffect(() => {
    const gate = requestGate.current;
    const restore = (historyMode: "none" | "replace") => {
      const next = parseCharacterPortfolioUrl(window.location.search);
      setSearch(next.search);
      setPhase(next.phase ?? "");
      setServingState(next.servingState ?? "");
      setReadiness(next.readiness ?? "");
      setAttention(next.attention ?? false);
      setCursor(next.cursor);
      void load(next, historyMode);
    };
    const timer = window.setTimeout(() => restore("replace"), 0);
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
    };
  }, [load]);

  function apply(nextCursor?: string) {
    setCursor(nextCursor);
    void load(
      {
        search,
        phase: phase || undefined,
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: attention || undefined,
        cursor: nextCursor,
      },
      "push",
    );
  }

  const activeStatusFilterCount = [phase, servingState, readiness].filter(
    Boolean,
  ).length;

  // INTENT: 「需要处理」是发现入口，不是第四个下拉——藏进 More filters 折叠等于没人会用。
  function toggleAttention() {
    const next = !attention;
    setAttention(next);
    setCursor(undefined);
    void load(
      {
        search,
        phase: phase || undefined,
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: next || undefined,
      },
      "push",
    );
  }

  function clearStatusFilters() {
    setPhase("");
    setServingState("");
    setReadiness("");
    setCursor(undefined);
    void load({ search, attention: attention || undefined }, "push");
  }

  const statusFilterControls = (
    <div className="grid gap-3 p-3 sm:grid-cols-3">
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Character stage")}
        <select
          aria-label={t("Filter by character stage")}
          className={`${fieldClass} mt-1`}
          onChange={(event) => setPhase(event.target.value)}
          value={phase}
        >
          <option value="">{t("All phases")}</option>
          {CHARACTER_PORTFOLIO_PHASES.map((value) => (
            <option key={value} value={value}>
              {t(value.replaceAll("_", " "))}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Serving state")}
        <select
          aria-label={t("Filter by serving state")}
          className={`${fieldClass} mt-1`}
          onChange={(event) => setServingState(event.target.value)}
          value={servingState}
        >
          <option value="">{t("All serving states")}</option>
          {CHARACTER_PORTFOLIO_SERVING_STATES.map((value) => (
            <option key={value} value={value}>
              {t(value.replaceAll("_", " "))}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Readiness")}
        <select
          aria-label={t("Filter by readiness")}
          className={`${fieldClass} mt-1`}
          onChange={(event) => setReadiness(event.target.value)}
          value={readiness}
        >
          <option value="">{t("All readiness")}</option>
          {CHARACTER_PORTFOLIO_READINESS_STATES.map((value) => (
            <option key={value} value={value}>
              {t(value.replaceAll("_", " "))}
            </option>
          ))}
        </select>
      </label>
      {activeStatusFilterCount > 0 ? (
        <button
          className="min-h-11 text-left text-xs font-semibold underline sm:col-span-3"
          onClick={clearStatusFilters}
          type="button"
        >
          {t("Clear status filters")}
        </button>
      ) : null}
    </div>
  );
  const filterForm = (
    <form
      aria-label={t("Search and filter characters")}
      className="relative z-20 flex w-full flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{t("Search characters")}</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ad-text-muted)]"
        />
        <input
          aria-label={t("Search characters")}
          className={`${fieldClass} pl-9`}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("Search name or character ID")}
          value={search}
        />
      </label>
      <WorkspaceButton type="submit">{t("Search")}</WorkspaceButton>
      {performanceMode ? (
        <button
          aria-pressed={attention}
          className={cn(
            "min-h-11 shrink-0 rounded-lg border px-3 text-sm font-semibold",
            attention
              ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white"
              : "border-[var(--ad-border)] text-[var(--ad-ink)]",
          )}
          onClick={toggleAttention}
          type="button"
        >
          {t("Needs attention")}
        </button>
      ) : null}
      <details className="group shrink-0 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold">
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          <span>{t("Filters")}</span>
          {activeStatusFilterCount > 0 ? (
            <span>({activeStatusFilterCount})</span>
          ) : null}
        </summary>
        <div className="absolute right-0 top-full mt-1 w-[min(680px,calc(100vw-2rem))] rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-[var(--ad-shadow-hover)]">
          {statusFilterControls}
        </div>
      </details>
    </form>
  );

  if (!canRead)
    return permissionDenied(
      mode === "performance"
        ? "character.performance.read"
        : "character.project.read",
    );
  return (
    <section aria-labelledby="character-list-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {performanceMode ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
              {t("Growth")}
            </p>
            <h2
              className="mt-1 text-2xl font-semibold"
              id="character-list-title"
            >
              {t("Character Performance")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">
              {t(
                "Compare release-attributed value, maturity, and portfolio decisions without expanding Project authority.",
              )}
            </p>
          </div>
        ) : (
          <h2 className="sr-only" id="character-list-title">
            {t("Characters")}
          </h2>
        )}
        {!performanceMode ? (
          <div className="ml-auto flex w-full max-w-3xl flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">{filterForm}</div>
            {canCreate ? (
              <Link
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-[var(--ad-surface)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
                href="/admin/characters/new"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t("Create Character")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
      {performanceMode ? (
        <div className="mt-4 flex justify-end">{filterForm}</div>
      ) : null}
      {error ? (
        <div
          className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {error}{" "}
          <button
            className="ml-2 underline"
            onClick={() =>
              void load(
                {
                  search,
                  phase: phase || undefined,
                  servingState: servingState || undefined,
                  readiness: readiness || undefined,
                  attention: attention || undefined,
                  cursor,
                },
                "none",
              )
            }
            type="button"
          >
            {t("Retry")}
          </button>
        </div>
      ) : null}
      <div className="mt-4">
        {loading && items.length === 0 ? (
          <LoadingWorkspace
            label={
              performanceMode
                ? "Loading release-attributed portfolio"
                : "Loading characters"
            }
          />
        ) : items.length === 0 ? (
          error ? null : (
            <CharacterListEmptyState
              attentionOnly={attention}
              filtered={Boolean(
                search || phase || servingState || readiness || attention,
              )}
              onClear={() => {
                setSearch("");
                setPhase("");
                setServingState("");
                setReadiness("");
                setAttention(false);
                setCursor(undefined);
                void load({ search: "" }, "push");
              }}
            />
          )
        ) : (
          <>
            {!performanceMode ? (
              <p className="mb-5 text-sm text-[var(--ad-text-muted)]">
                {t("{count} characters", { count: items.length })}
              </p>
            ) : null}
            <div
              className={
                performanceMode
                  ? "grid gap-3"
                  : "grid gap-x-7 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              }
            >
              {items.map((item, index) => (
                <CharacterPortfolioCard
                  canOpenAssets={canOpenAssets}
                  canOpenProject={canOpenProjects}
                  eager={index < (performanceMode ? 1 : 4)}
                  item={item}
                  key={item.characterId}
                  mode={mode}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--ad-text-muted)]">
          {asOf
            ? t("Fresh as of {time}", {
                time: new Date(asOf).toLocaleString(adminDateLocale(locale)),
              })
            : t("No successful query yet")}
        </p>
        <WorkspaceButton
          disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor}
          onClick={() => apply(pageInfo.endCursor ?? undefined)}
        >
          {t("Next page")}
        </WorkspaceButton>
      </div>
    </section>
  );
}

export function characterRecentAssets(data: CharacterWorkspaceDetail) {
  const seen = new Set<string>();
  const assets: { id: string; url: string }[] = [];
  const add = (id: string, url: string | null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    assets.push({ id, url });
  };
  add(`${data.character.id}:primary`, data.character.imageUrl);
  for (const asset of [...data.visual.anchors, ...data.visual.references]) {
    if (asset.available)
      add(asset.mediaAssetId, asset.thumbnailUrl ?? asset.url);
  }
  return assets.slice(0, 3);
}

function ProjectEditor({
  data,
  permissions,
  onReload,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  onReload: () => Promise<void>;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const initial = useMemo<ProjectDraft>(
    () => ({
      ownerId: data.project.ownerId,
      audience: data.project.audience,
      companionNeed: data.project.companionNeed,
      hypothesis: data.project.hypothesis,
      differentiation: data.project.differentiation,
      targetPlacementKeys: [...data.project.targetPlacementKeys],
      successCriteria: [...data.project.successCriteria],
      productionPackage: data.project.productionPackage,
      qaPlan: data.project.qaPlan,
      plannedLaunchAt: data.project.plannedLaunchAt,
    }),
    [data],
  );
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<
    "Saved" | "Saving" | "Conflict" | "Failed to save"
  >("Saved");
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const savedKey = useRef(JSON.stringify(initial));
  const recentAssets = useMemo(() => characterRecentAssets(data), [data]);

  useEffect(() => {
    const key = JSON.stringify(draft);
    if (!permissions.writeProject || key === savedKey.current) return;
    setState("Saving");
    const timer = window.setTimeout(async () => {
      try {
        await runCommittedMutation({
          action: "Character Project autosave",
          commit: async () => {
            const result = await adminV2Request(
              `/api/v2/admin/characters/${data.character.id}/project`,
              {
                method: "PATCH",
                ifMatch: data.project.version,
                body: {
                  ...draft,
                  entityVersion: data.project.version,
                  reason: "Autosave Character Project changes",
                },
              },
            );
            setState("Saved");
            setMessage(null);
            return result;
          },
          afterRefresh: () => {
            savedKey.current = key;
            setMessage(null);
          },
        });
      } catch (reason) {
        if (reason instanceof AdminV2RequestError && reason.status === 409) {
          setState("Conflict");
          setMessage(
            "A newer server revision exists. Review your local text, then reload the authority before reapplying it.",
          );
        } else {
          setState("Failed to save");
          setMessage(
            reason instanceof Error
              ? reason.message
              : "Project autosave failed",
          );
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    data.character.id,
    data.project.version,
    draft,
    permissions.writeProject,
    runCommittedMutation,
  ]);

  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const disabled = !permissions.writeProject;
  const characterDetails = [
    { label: "Description", value: data.character.description || "N/A" },
    { label: "Age", value: String(data.character.age) },
    { label: "Gender", value: data.character.gender || "N/A" },
    { label: "Style", value: data.character.style || "N/A" },
  ] as const;
  const operationalFacts = characterOperationsFacts(data).filter(
    (fact) => fact.label !== "Serving" && fact.label !== "Visibility",
  );
  return (
    <div className="space-y-5">
      <section className="border-b border-[var(--ad-border)] pb-8">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-lg font-semibold">{t("Character details")}</h3>
          {permissions.writeProject ? (
            <button
              className="min-h-10 text-sm font-semibold underline-offset-4 hover:underline"
              onClick={() => setEditing((current) => !current)}
              type="button"
            >
              {t(editing ? "Close editor" : "Edit details")}
            </button>
          ) : null}
        </div>
        <div className="mt-5 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] xl:divide-x xl:divide-[var(--ad-border)]">
          <dl className="grid grid-cols-2 content-start gap-x-8 gap-y-5">
            {characterDetails.map((detail) => (
              <div
                className={
                  detail.label === "Description" ? "sm:col-span-2" : undefined
                }
                key={detail.label}
              >
                <dt className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t(detail.label)}
                </dt>
                <dd className="mt-1 break-words text-sm leading-6 text-[var(--ad-ink)]">
                  {t(detail.value)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="xl:pl-8">
            <h3 className="text-sm font-semibold">{t("Current status")}</h3>
            <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {operationalFacts.map((fact) => (
                <div key={fact.label}>
                  <dt className="text-xs text-[var(--ad-text-muted)]">
                    {t(fact.label)}
                  </dt>
                  <dd
                    className={cn(
                      "mt-1 text-sm font-semibold",
                      fact.alert && "text-[var(--ad-yellow-text)]",
                    )}
                  >
                    {t(fact.value)}
                  </dd>
                </div>
              ))}
            </dl>
            {characterVideoSourceBroken(data) ? (
              <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-[var(--ad-yellow-text)]">
                <ShieldAlert
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                {t(
                  "Live without a usable primary image. Video generation for this character is rejected. Repair it in Image assets.",
                )}
              </p>
            ) : null}
            <div className="mt-7 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{t("Recent assets")}</h3>
              {/* SPEC: "查看全部"必须落到这个角色的全部图片。
                  INTENT: 曾指向 ?tab=assets，但那个 tab 只呈现最近一次生成批次的候选图，
                  详情页写着"图片 16"却只能看到 1 张。图库支持 targetId 收窄，直接跳过去。 */}
              <Link
                className="text-xs font-semibold hover:underline"
                href={`/admin/creative/library?targetId=${encodeURIComponent(data.character.id)}`}
              >
                {t("View all")}
              </Link>
            </div>
            {recentAssets.length > 0 ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {recentAssets.map((asset) => (
                  <Image
                    alt=""
                    className="aspect-square w-full rounded-md object-cover"
                    height={160}
                    key={asset.id}
                    src={asset.url}
                    unoptimized
                    width={160}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
                {t("No recent assets")}
              </p>
            )}
          </div>
        </div>
      </section>
      {editing ? (
        <section className="grid gap-5 border-b border-[var(--ad-border)] pb-8 xl:grid-cols-[1fr_320px]">
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={disabled}>
            <legend className="mb-4 text-sm font-semibold">
              {t("Project details")}
            </legend>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Owner ID")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) => set("ownerId", event.target.value || null)}
                value={draft.ownerId ?? ""}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Audience")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("audience", event.target.value)}
                value={draft.audience}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Companion need")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("companionNeed", event.target.value)}
                value={draft.companionNeed}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Hypothesis")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("hypothesis", event.target.value)}
                value={draft.hypothesis}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Differentiation")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("differentiation", event.target.value)}
                value={draft.differentiation}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Target placements")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  set(
                    "targetPlacementKeys",
                    event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
                value={draft.targetPlacementKeys.join(", ")}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Planned launch")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  set(
                    "plannedLaunchAt",
                    event.target.value
                      ? new Date(event.target.value).toISOString()
                      : null,
                  )
                }
                type="datetime-local"
                value={draft.plannedLaunchAt?.slice(0, 16) ?? ""}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Success criteria")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) =>
                  set(
                    "successCriteria",
                    event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
                value={draft.successCriteria.join("\n")}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Production package")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) =>
                  set("productionPackage", event.target.value)
                }
                value={draft.productionPackage}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("QA plan")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("qaPlan", event.target.value)}
                value={draft.qaPlan}
              />
            </label>
          </fieldset>
          <aside className="border-l border-[var(--ad-border)] pl-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
              {t("Server draft")}
            </p>
            <div className="mt-4 flex items-center gap-2" role="status">
              <Save className="h-4 w-4" />
              <strong>{disabled ? t("Read only") : state}</strong>
            </div>
            <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
              {t("Project revision")} {data.project.version}
              {t(
                ". Autosave uses If-Match; conflicts never overwrite a newer revision.",
              )}
            </p>
            {message ? (
              <p
                className="mt-4 text-xs text-[var(--ad-yellow-text)]"
                role={state === "Failed to save" ? "alert" : "status"}
              >
                {message}
              </p>
            ) : null}
            {state === "Conflict" ? (
              <div className="mt-3">
                <WorkspaceButton
                  onClick={() => void onReload().catch(() => undefined)}
                >
                  <RefreshCcw className="h-4 w-4" /> {t("Load server revision")}
                </WorkspaceButton>
              </div>
            ) : null}
          </aside>
        </section>
      ) : null}
      <details className="border-b border-[var(--ad-border)] pb-5">
        <summary className="cursor-pointer py-2 text-sm font-semibold">
          {t("Project collaboration")}
        </summary>
        <div className="pt-4">
          <CollaborationPanel
            canWrite={permissions.writeProject}
            targetId={data.project.id}
            targetType="character_project"
            targetVersion={data.project.version}
          />
        </div>
      </details>
    </div>
  );
}

export type VisualIdentityPanelData = Pick<
  CharacterWorkspaceDetail,
  "visual"
> & {
  character: Pick<
    CharacterWorkspaceDetail["character"],
    "id" | "name" | "style" | "imageUrl"
  >;
};

export function uniqueAvailableVisualAssets<
  T extends { readonly available: boolean; readonly mediaAssetId: string },
>(assets: readonly T[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (!asset.available || seen.has(asset.mediaAssetId)) return false;
    seen.add(asset.mediaAssetId);
    return true;
  });
}

export function referenceIdsRemovedFromPublishedSet(
  activeReferenceIds: readonly string[],
  selectedReferenceIds: readonly string[],
) {
  const selected = new Set(selectedReferenceIds);
  return [...new Set(activeReferenceIds)].filter((id) => !selected.has(id));
}

export function requiresReviewedIdentityBootstrap(input: {
  readonly hasActiveIdentity: boolean;
  readonly hasCurrentCharacterImage: boolean;
  readonly availableReferenceCount: number;
  readonly hasActiveReferenceSet: boolean;
}) {
  return (
    !input.hasCurrentCharacterImage &&
    (!input.hasActiveIdentity ||
      (input.availableReferenceCount === 0 && !input.hasActiveReferenceSet))
  );
}

export function VisualIdentityPanel({
  data,
  navigateToTab,
  permissions,
  runCommittedMutation,
}: {
  data: VisualIdentityPanelData;
  permissions: Pick<Permissions, "writeVisual" | "evaluateRoute"> &
    Partial<
      Pick<Permissions, "writeProject" | "createAssets" | "reviewAssets">
    >;
  runCommittedMutation: RunCommittedCharacterMutation;
  navigateToTab?: (tab: CharacterWorkspaceTab) => void;
}) {
  const { t } = useAdminI18n();
  const identity = data.visual.activeIdentity;
  const [identityPrompt, setIdentityPrompt] = useState(
    identity?.identityPrompt ?? "",
  );
  const [negativeIdentityPrompt, setNegativeIdentityPrompt] = useState(
    identity?.negativeIdentityPrompt ?? "",
  );
  const [style, setStyle] = useState(identity?.style ?? data.character.style);
  const [defaultSeed, setDefaultSeed] = useState(identity?.defaultSeed ?? "");
  const [identityReason, setIdentityReason] = useState("");
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const routeEvaluation = data.visual.routeEvaluation;
  const activeGenerationRoute =
    data.visual.routeQualifications.find(
      (route) => route.result === "qualified" && !route.stale,
    ) ?? null;
  const recommendedGenerationProfile =
    routeEvaluation.profiles.find((profile) => profile.recommended) ??
    routeEvaluation.profiles[0] ??
    null;
  const [productionSettingsOpen, setProductionSettingsOpen] = useState(
    !data.visual.readiness.ready,
  );
  const identityVersionNeedsAttention = data.visual.readiness.blockers.some(
    (blocker) => visualIdentityRepairBlockers.has(blocker.code),
  );
  const [advancedIdentityOpen, setAdvancedIdentityOpen] = useState(
    identityVersionNeedsAttention,
  );
  const referenceCandidates = useMemo(
    () =>
      uniqueAvailableVisualAssets([
        ...data.visual.anchors,
        ...data.visual.references,
      ]),
    [data.visual.anchors, data.visual.references],
  );
  // SPEC: 参考集只有一个网格 —— 看图即可勾选。
  // INTENT: 拆成"缩略图展示区 + 纯 media ID 勾选区"时，运营要靠 ID 在两区之间对照才能
  // 剔除掉混进锚点池的多人合照/他人脸，实际不可用。不可用资产保留展示但禁止勾选，
  // 以免"少了一张"却查不到原因。
  const referenceRows = useMemo(() => {
    const activeIds = new Set(
      (data.visual.activeReferenceSet?.references ?? []).map(
        (reference) => reference.mediaAssetId,
      ),
    );
    const seen = new Set<string>();
    return [
      ...data.visual.anchors,
      ...data.visual.references,
      ...(data.visual.activeReferenceSet?.references ?? []),
    ]
      .filter((asset) => {
        if (seen.has(asset.mediaAssetId)) return false;
        seen.add(asset.mediaAssetId);
        return true;
      })
      .map((asset) => ({
        asset,
        active: activeIds.has(asset.mediaAssetId),
        selectable: asset.available,
      }));
  }, [
    data.visual.activeReferenceSet,
    data.visual.anchors,
    data.visual.references,
  ]);
  const requiresReviewedBootstrap =
    requiresReviewedIdentityBootstrap({
      hasActiveIdentity: identity !== null,
      hasCurrentCharacterImage: Boolean(data.character.imageUrl),
      availableReferenceCount: referenceCandidates.length,
      hasActiveReferenceSet: data.visual.activeReferenceSet !== null,
    }) && data.visual.identityBootstrap.allowed;
  const usesCurrentCharacterImageAsAnchor =
    Boolean(data.character.imageUrl) &&
    referenceCandidates.length === 0 &&
    data.visual.activeReferenceSet === null;
  const blockedIdentityRepair =
    data.visual.identityBootstrap.state === "blocked_existing_authority" &&
    !usesCurrentCharacterImageAsAnchor &&
    referenceCandidates.length === 0;
  const activeReferenceIds = useMemo(
    () =>
      data.visual.activeReferenceSet?.references.map(
        (reference) => reference.mediaAssetId,
      ) ?? [],
    [data.visual.activeReferenceSet],
  );
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>(
    () =>
      data.visual.activeReferenceSet
        ? activeReferenceIds
        : referenceCandidates.map((asset) => asset.mediaAssetId),
  );
  const [referenceReason, setReferenceReason] = useState("");
  const [referenceConfirmed, setReferenceConfirmed] = useState(false);
  const [selectedLookId, setSelectedLookId] = useState<string | null>(null);
  const [lookArchiveReason, setLookArchiveReason] = useState("");
  const [busy, setBusy] = useState<"identity" | "references" | "look" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});
  const removedReferenceIds = referenceIdsRemovedFromPublishedSet(
    activeReferenceIds,
    selectedReferenceIds,
  );
  const readinessActions = useMemo(() => {
    const grouped = new Map<
      string,
      {
        readonly deepLink: string;
        readonly messages: string[];
        readonly codes: string[];
      }
    >();
    for (const blocker of data.visual.readiness.blockers) {
      const action = characterAssetReadinessAction(blocker.code);
      const existing = grouped.get(action);
      grouped.set(action, {
        deepLink: existing?.deepLink ?? blocker.deepLink,
        messages: [...(existing?.messages ?? []), blocker.message],
        codes: [...(existing?.codes ?? []), blocker.code],
      });
    }
    return [...grouped].map(([action, value]) => {
      const target = characterVisualReadinessTarget(value.codes);
      return {
        action,
        ...value,
        deepLink: target ? `#${target}` : value.deepLink,
      };
    });
  }, [data.visual.readiness.blockers]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedReferenceIds(
        data.visual.activeReferenceSet
          ? activeReferenceIds
          : referenceCandidates.map((asset) => asset.mediaAssetId),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeReferenceIds,
    data.visual.activeIdentity?.id,
    data.visual.activeReferenceSet,
    referenceCandidates,
  ]);
  const stableIdempotencyKey = (scope: string, payload: unknown) => {
    const signature = `${scope}:${JSON.stringify(payload)}`;
    const key = idempotencyKeys.current[signature] ?? crypto.randomUUID();
    idempotencyKeys.current[signature] = key;
    return { key, signature };
  };

  const createIdentityVersion = async () => {
    setBusy("identity");
    setError(null);
    const body = {
      identityPrompt: identityPrompt.trim() || undefined,
      negativeIdentityPrompt: negativeIdentityPrompt.trim() || undefined,
      style,
      defaultSeed: defaultSeed.trim() || undefined,
      reason: identityReason.trim(),
      confirmation: identityConfirmed
        ? `${data.character.id}:visual-profile`
        : "",
    };
    const requestIdentity = stableIdempotencyKey("visual-profile", body);
    try {
      await runCommittedMutation({
        action: "Visual Identity version",
        commit: () =>
          apiWrite(
            `/api/v1/admin/content/characters/${data.character.id}/visual-profiles`,
            "POST",
            body,
            {
              "idempotency-key": requestIdentity.key,
              "x-request-id": crypto.randomUUID(),
            },
          ),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setIdentityReason("");
          setIdentityConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Visual Identity version could not be created",
      );
    } finally {
      setBusy(null);
    }
  };

  const activateIdentityCandidate = async (
    body: ActivateIdentityCandidateInput,
  ) => {
    const requestIdentity = stableIdempotencyKey(
      "activate-identity-candidate",
      body,
    );
    await runCommittedMutation({
      action: "Identity candidate activation",
      commit: () =>
        apiWrite(
          `/api/v1/admin/content/characters/${data.character.id}/visual-profiles`,
          "POST",
          body,
          {
            "idempotency-key": requestIdentity.key,
            "x-request-id": crypto.randomUUID(),
          },
        ),
      afterRefresh: () => {
        delete idempotencyKeys.current[requestIdentity.signature];
      },
    });
  };

  const publishReferenceSet = async () => {
    if (!identity) return;
    setBusy("references");
    setError(null);
    const selected = referenceCandidates.filter((asset) =>
      selectedReferenceIds.includes(asset.mediaAssetId),
    );
    const body = {
      visualProfileId: identity.id,
      expectedActiveReferenceSetRevisionId:
        data.visual.activeReferenceSet?.id ?? null,
      expectedActiveReferenceSetRevision:
        data.visual.activeReferenceSet?.revision ?? 0,
      selectorVersion: "admin-visual-workbench-v1",
      references: selected.map((asset) => ({
        mediaAssetId: asset.mediaAssetId,
        role: asset.role,
        weight: 1,
      })),
      reason: {
        code: "reference_snapshot_publish",
        summary: referenceReason.trim(),
      },
      confirmation: referenceConfirmed
        ? `PUBLISH REFERENCES ${data.character.id}`
        : "",
    };
    const requestIdentity = stableIdempotencyKey("reference-set", body);
    try {
      await runCommittedMutation({
        action: "Reference Set publication",
        commit: () =>
          adminV2Request(
            `/api/v2/admin/characters/${data.character.id}/reference-sets`,
            {
              method: "POST",
              idempotencyKey: requestIdentity.key,
              schema: characterReferenceSetPublishResponseSchema,
              body,
            },
          ),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setReferenceReason("");
          setReferenceConfirmed(false);
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Reference Set could not be published",
      );
    } finally {
      setBusy(null);
    }
  };

  const archiveLook = async () => {
    const look = (data.visual.looks ?? []).find(
      (item) => item.id === selectedLookId,
    );
    if (!look) return;
    setBusy("look");
    setError(null);
    const body = {
      operation: "archive" as const,
      expectedUpdatedAt: look.updatedAt,
      reason: {
        code: "look_retired",
        summary: lookArchiveReason.trim() || "Archived by operator",
      },
      confirmation: `ARCHIVE LOOK ${look.id}`,
    };
    const requestIdentity = stableIdempotencyKey(
      `archive-look:${look.id}`,
      body,
    );
    try {
      await runCommittedMutation({
        action: "Character Look archive",
        commit: () =>
          adminV2Request(
            `/api/v2/admin/characters/${data.character.id}/looks/${look.id}`,
            {
              method: "PATCH",
              idempotencyKey: requestIdentity.key,
              schema: characterLookArchiveResponseSchema,
              body,
            },
          ),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setSelectedLookId(null);
          setLookArchiveReason("");
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Character Look could not be archived",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <VisualIdentityExperimentWorkbench
        canActivate={permissions.writeVisual}
        canCreate={permissions.createAssets ?? false}
        canUploadSource={
          (permissions.writeProject ?? false) &&
          (permissions.createAssets ?? false)
        }
        canReview={permissions.reviewAssets ?? false}
        data={data}
        onActivateCandidate={activateIdentityCandidate}
      />
      <details
        className="scroll-mt-4 rounded-xl border border-[var(--ad-border)] bg-black/[0.015]"
        id="visual-production-readiness"
        onToggle={(event) =>
          setProductionSettingsOpen(event.currentTarget.open)
        }
        open={productionSettingsOpen || !data.visual.readiness.ready}
      >
        <summary className="cursor-pointer px-4 py-4 text-sm font-semibold sm:px-5">
          正式身份与生产设置
        </summary>
        <div className="grid gap-5 border-t border-[var(--ad-border)] p-4 xl:grid-cols-[minmax(0,1fr)_380px] sm:p-5">
          <div className="space-y-5">
            <section
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              aria-labelledby="visual-authority-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold" id="visual-authority-title">
                    {t("Visual Identity authority")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "Selection, published references, and the active image route are separate evidence.",
                    )}
                  </p>
                </div>
                <StatusBadge
                  value={
                    data.visual.readiness.ready ? "visual ready" : "blocked"
                  }
                />
              </div>
              {identity ? (
                <>
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-[var(--ad-text-muted)]">
                        {t("Active identity")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        v{identity.version} · {identity.style}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--ad-text-muted)]">
                        {t("Anchors available")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {
                          data.visual.anchors.filter((asset) => asset.available)
                            .length
                        }
                        /{data.visual.anchors.length}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-[var(--ad-text-muted)]">
                        {t("Reference Set")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {data.visual.activeReferenceSet
                          ? t("revision {version}", {
                              version: data.visual.activeReferenceSet.revision,
                            })
                          : t("Not published")}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-4 rounded-lg bg-black/[0.03] p-3 text-sm">
                    {identity.identityPrompt}
                  </p>
                </>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {t("No active immutable Visual Identity version exists.")}
                </p>
              )}
              {readinessActions.length ? (
                <div className="mt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
                    {t("Image-production readiness")}
                  </h4>
                  <ol
                    aria-label={t("Image production readiness")}
                    className="mt-2 space-y-2"
                  >
                    {readinessActions.map((item, index) => (
                      <li
                        aria-current={index === 0 ? "step" : undefined}
                        className="flex flex-col gap-2 rounded-lg border border-[var(--ad-border)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                        key={item.action}
                      >
                        <span className="flex gap-3">
                          <span
                            aria-hidden="true"
                            className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--ad-border)] text-xs font-semibold"
                          >
                            {index + 1}
                          </span>
                          <span>
                            <strong>{t(item.action)}</strong>
                            <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">
                              {item.messages
                                .map((message) => t(message))
                                .join(" ")}
                            </span>
                          </span>
                        </span>
                        <Link
                          aria-label={t("Resolve: {action}", {
                            action: t(item.action),
                          })}
                          className="shrink-0 text-xs font-semibold underline"
                          href={item.deepLink}
                        >
                          {t("Resolve")}
                        </Link>
                      </li>
                    ))}
                  </ol>
                  <details className="mt-3 text-xs text-[var(--ad-text-muted)]">
                    <summary className="cursor-pointer font-semibold">
                      {t("Technical blocker codes")}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {readinessActions.flatMap((item) =>
                        item.codes.map((code) => <li key={code}>{code}</li>),
                      )}
                    </ul>
                  </details>
                </div>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-green-text)]">
                  {t("All visual evidence gates currently pass.")}
                </p>
              )}
            </section>

            <section
              className="scroll-mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="visual-reference-set"
              aria-labelledby="reference-set-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold" id="reference-set-title">
                    {t("Anchors & published references")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "Select available Identity assets, then seal an immutable Reference Set revision.",
                    )}
                  </p>
                </div>
                {navigateToTab ? (
                  <button
                    className="inline-flex min-h-11 items-center rounded-lg border border-[var(--ad-border)] px-3 text-sm font-semibold"
                    onClick={() => navigateToTab("assets")}
                    type="button"
                  >
                    {t("Open role image production")}
                  </button>
                ) : (
                  <Link
                    className="inline-flex min-h-11 items-center rounded-lg border border-[var(--ad-border)] px-3 text-sm font-semibold"
                    href={data.visual.readiness.productionDeepLink}
                  >
                    {t("Open role image production")}
                  </Link>
                )}
              </div>
              {identity ? (
                <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t(
                    "Only checked images become active generation references. Unchecked images leave runtime authority after this revision is published; historical snapshots remain unchanged.",
                  )}
                </p>
              ) : null}
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {referenceRows.length === 0 ? (
                  <p className="text-sm text-[var(--ad-text-muted)]">
                    {t("No anchor or published reference assets.")}
                  </p>
                ) : (
                  referenceRows.map((row) => {
                    const checked = selectedReferenceIds.includes(
                      row.asset.mediaAssetId,
                    );
                    const preview = row.asset.thumbnailUrl ?? row.asset.url;
                    return (
                      <label
                        className={`block cursor-pointer rounded-lg border p-3 transition-colors ${
                          checked
                            ? "border-[var(--ad-ink)] bg-black/[0.03]"
                            : "border-[var(--ad-border)]"
                        } ${row.selectable ? "" : "cursor-not-allowed opacity-60"}`}
                        key={row.asset.mediaAssetId}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
                            <input
                              checked={checked}
                              disabled={!row.selectable}
                              onChange={(event) =>
                                setSelectedReferenceIds((current) =>
                                  event.target.checked
                                    ? [
                                        ...new Set([
                                          ...current,
                                          row.asset.mediaAssetId,
                                        ]),
                                      ]
                                    : current.filter(
                                        (id) => id !== row.asset.mediaAssetId,
                                      ),
                                )
                              }
                              type="checkbox"
                            />
                            <span className="truncate">
                              {t(row.asset.role.replaceAll("_", " "))}
                            </span>
                          </span>
                          <StatusBadge
                            tone={row.active ? "good" : undefined}
                            value={
                              !row.asset.available
                                ? "unavailable"
                                : row.active
                                  ? "live reference"
                                  : "available"
                            }
                          />
                        </div>
                        {preview ? (
                          <Image
                            alt={t("Visual reference evidence")}
                            className="mt-3 aspect-square w-full rounded-md object-cover"
                            height={320}
                            src={preview}
                            unoptimized
                            width={320}
                          />
                        ) : null}
                        <p className="mt-2 truncate text-[11px] text-[var(--ad-text-muted)]">
                          {row.asset.mediaAssetId}
                        </p>
                      </label>
                    );
                  })
                )}
              </div>
              {identity ? (
                <div className="mt-5 border-t border-[var(--ad-border)] pt-4">
                  <h4 className="text-sm font-semibold">
                    {t("Publish Reference Set revision")}
                  </h4>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t("{count} of {total} images selected", {
                      count: selectedReferenceIds.length,
                      total: referenceCandidates.length,
                    })}
                  </p>
                  {removedReferenceIds.length > 0 ? (
                    <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
                      {t(
                        "{count} current references will be removed from active generation.",
                        { count: removedReferenceIds.length },
                      )}
                    </p>
                  ) : null}
                  <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Publication reason")}
                    <input
                      className={`${fieldClass} mt-1`}
                      onChange={(event) =>
                        setReferenceReason(event.target.value)
                      }
                      value={referenceReason}
                    />
                  </label>
                  <label className="mt-3 flex items-start gap-2 text-xs">
                    <input
                      checked={referenceConfirmed}
                      className="mt-0.5"
                      onChange={(event) =>
                        setReferenceConfirmed(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      {t(
                        "Publish a new immutable reference snapshot and supersede the active revision.",
                      )}
                    </span>
                  </label>
                  <div className="mt-4">
                    <WorkspaceButton
                      disabled={
                        !permissions.writeVisual ||
                        busy !== null ||
                        selectedReferenceIds.length === 0 ||
                        referenceReason.trim().length < 3 ||
                        !referenceConfirmed
                      }
                      onClick={() => void publishReferenceSet()}
                      tone="primary"
                    >
                      {t("Publish Reference Set")}
                    </WorkspaceButton>
                  </div>
                </div>
              ) : null}
            </section>

            <section
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="character-looks"
              aria-labelledby="character-looks-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold" id="character-looks-title">
                    {t("Character Looks using role images")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "Archive an unused Look before retiring its reference image. Historical generations keep their pinned snapshot.",
                    )}
                  </p>
                </div>
                <StatusBadge
                  value={`${(data.visual.looks ?? []).length} active`}
                />
              </div>
              {(data.visual.looks ?? []).length === 0 ? (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {t(
                    "No active or rebase-required Looks depend on this Character.",
                  )}
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {(data.visual.looks ?? []).map((look) => (
                    <article
                      className="flex flex-col gap-3 rounded-lg border border-[var(--ad-border)] p-3 sm:flex-row sm:items-center sm:justify-between"
                      key={look.id}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm">{look.label}</strong>
                          <StatusBadge value={look.status} />
                        </div>
                        <p className="mt-1 truncate text-xs text-[var(--ad-text-muted)]">
                          {look.id} {t("· reference")}{" "}
                          {look.referenceAssetId ?? t("none")}
                        </p>
                      </div>
                      <WorkspaceButton
                        disabled={!permissions.writeVisual || busy !== null}
                        onClick={() => {
                          setSelectedLookId(look.id);
                          setLookArchiveReason("");
                        }}
                      >
                        {t("Archive Look")}
                      </WorkspaceButton>
                    </article>
                  ))}
                </div>
              )}
              {selectedLookId ? (
                <div className="mt-4 border-t border-[var(--ad-border)] pt-4">
                  <h4 className="text-sm font-semibold">
                    {t("Archive")} {selectedLookId}
                  </h4>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {t(
                      "This removes the active Look dependency. It does not delete the role image.",
                    )}
                  </p>
                  <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Reason")}
                    <input
                      className={`${fieldClass} mt-1`}
                      onChange={(event) =>
                        setLookArchiveReason(event.target.value)
                      }
                      value={lookArchiveReason}
                    />
                  </label>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <WorkspaceButton
                      // 归档 Look 是可逆的（status 可改回 active），按钮本身即确认动作——
                      // 不再要求先填理由、再默写内部 ID。
                      disabled={busy !== null}
                      onClick={() => void archiveLook()}
                      tone="primary"
                    >
                      {t("Confirm archive")}
                    </WorkspaceButton>
                    <WorkspaceButton
                      disabled={busy !== null}
                      onClick={() => {
                        setSelectedLookId(null);
                        setLookArchiveReason("");
                      }}
                    >
                      {t("Cancel")}
                    </WorkspaceButton>
                  </div>
                </div>
              ) : null}
            </section>

            <section
              aria-labelledby="single-image-policy-title"
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
            >
              <h3 className="font-semibold" id="single-image-policy-title">
                {t("One image at a time")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">
                {t(
                  "Every generation creates one candidate. Review that image before selecting it for the draft asset pack; nothing changes the live character automatically.",
                )}
              </p>
            </section>
          </div>

          <aside className="space-y-5">
            <details
              className="scroll-mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="visual-identity-version"
              onToggle={(event) =>
                setAdvancedIdentityOpen(event.currentTarget.open)
              }
              open={advancedIdentityOpen || identityVersionNeedsAttention}
            >
              <summary className="cursor-pointer font-semibold">
                {t("Advanced identity controls")}
              </summary>
              <section className="mt-4" aria-labelledby="new-identity-title">
                <h3 className="font-semibold" id="new-identity-title">
                  {t("Create identity version")}
                </h3>
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {t(
                    "Creates a new active immutable version; existing assets are carried forward.",
                  )}
                </p>
                {requiresReviewedBootstrap ? (
                  <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
                    <p>
                      {t(
                        "Establish a reviewed portrait anchor in Character Assets before creating later identity versions.",
                      )}
                    </p>
                    {navigateToTab ? (
                      <div className="mt-3">
                        <WorkspaceButton
                          onClick={() => navigateToTab("assets")}
                        >
                          {t("Open Character Assets")}
                        </WorkspaceButton>
                      </div>
                    ) : null}
                  </div>
                ) : blockedIdentityRepair ? (
                  <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">
                    <p>
                      {t(
                        "This character has earlier visual history but no usable portrait authority. Repair its reviewed image evidence before creating another identity version.",
                      )}
                    </p>
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer font-semibold">
                        {t("Technical identity diagnostics")}
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {data.visual.identityBootstrap.blockers.map(
                          (blocker) => (
                            <li key={blocker}>{blocker}</li>
                          ),
                        )}
                      </ul>
                    </details>
                  </div>
                ) : usesCurrentCharacterImageAsAnchor ? (
                  <p className="mt-4 rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm text-[var(--ad-blue-text)]">
                    {t(
                      "The current Character image is available and will be carried forward as the anchor for this identity version.",
                    )}
                  </p>
                ) : null}
                <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Identity lock")}
                  <textarea
                    className={`${textAreaClass} mt-1`}
                    onChange={(event) => setIdentityPrompt(event.target.value)}
                    value={identityPrompt}
                  />
                </label>
                <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Must not change")}
                  <textarea
                    className={`${textAreaClass} mt-1`}
                    onChange={(event) =>
                      setNegativeIdentityPrompt(event.target.value)
                    }
                    value={negativeIdentityPrompt}
                  />
                </label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Style")}
                    <select
                      className={`${fieldClass} mt-1`}
                      onChange={(event) => setStyle(event.target.value)}
                      value={style}
                    >
                      {["realistic", "anime", "hybrid", "other"].map(
                        (value) => (
                          <option key={value}>{value}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Seed")}
                    <input
                      className={`${fieldClass} mt-1`}
                      onChange={(event) => setDefaultSeed(event.target.value)}
                      value={defaultSeed}
                    />
                  </label>
                </div>
                <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Change reason")}
                  <input
                    className={`${fieldClass} mt-1`}
                    onChange={(event) => setIdentityReason(event.target.value)}
                    value={identityReason}
                  />
                </label>
                <label className="mt-3 flex items-start gap-2 text-xs">
                  <input
                    checked={identityConfirmed}
                    className="mt-0.5"
                    onChange={(event) =>
                      setIdentityConfirmed(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>{t("Activate this as a new identity version.")}</span>
                </label>
                <div className="mt-4">
                  <WorkspaceButton
                    disabled={
                      requiresReviewedBootstrap ||
                      blockedIdentityRepair ||
                      !permissions.writeVisual ||
                      busy !== null ||
                      identityReason.trim().length < 3 ||
                      !identityConfirmed
                    }
                    onClick={() => void createIdentityVersion()}
                    tone="primary"
                  >
                    {t("Create & activate version")}
                  </WorkspaceButton>
                </div>
                {!permissions.writeVisual ? (
                  <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
                    {t("Read-only: content.official.write is not granted.")}
                  </p>
                ) : null}
              </section>
            </details>
            <details
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              id="route-qualification-workbench"
              open
            >
              <summary className="cursor-pointer font-semibold">
                {t("Image generation route")}
              </summary>
              <section
                className="mt-4"
                aria-labelledby="generation-route-title"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3
                      className="text-lg font-semibold"
                      id="generation-route-title"
                    >
                      {activeGenerationRoute?.generationProfileKey ??
                        recommendedGenerationProfile?.label ??
                        t("No compatible image route")}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                      {activeGenerationRoute
                        ? `${activeGenerationRoute.workflowKey} · v${activeGenerationRoute.workflowVersion}`
                        : recommendedGenerationProfile
                          ? `${recommendedGenerationProfile.workflowKey} · v${recommendedGenerationProfile.workflowVersion}`
                          : t(
                              routeEvaluation.blocker ??
                                "No active reference-capable image profile can consume this Reference Set.",
                            )}
                    </p>
                  </div>
                  <StatusBadge
                    value={
                      activeGenerationRoute || recommendedGenerationProfile
                        ? "ready"
                        : "blocked"
                    }
                  />
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t(
                    "The platform keeps the compatible route fixed for lineage. Operators create and review one image at a time; no test images are required first.",
                  )}
                </p>
                {navigateToTab &&
                (activeGenerationRoute || recommendedGenerationProfile) ? (
                  <WorkspaceButton
                    className="mt-4"
                    onClick={() => navigateToTab("assets")}
                    tone="primary"
                  >
                    {t("Generate one image")}
                  </WorkspaceButton>
                ) : null}
              </section>
            </details>
            {error ? (
              <p className="text-sm text-[var(--ad-red-text)]" role="alert">
                {error}
              </p>
            ) : null}
          </aside>
        </div>
      </details>
    </div>
  );
}

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

type CharacterWorkspaceQaAuthorityRun = Pick<
  CharacterWorkspaceDetail["qaRuns"][number],
  | "id"
  | "status"
  | "createdAt"
  | "characterId"
  | "projectId"
  | "projectVersion"
  | "characterContentVersionId"
  | "visualProfileId"
  | "visualProfileVersion"
  | "visualProfileHash"
  | "referenceSetRevisionId"
  | "referenceSetRevision"
  | "referenceSetHash"
  | "draftAssetPackHash"
>;

type CharacterWorkspaceQaAuthority = {
  readonly character: {
    readonly id: string;
  };
  readonly project: {
    readonly id: string;
    readonly version: number;
    readonly draftAssetPackHash: string;
    readonly draftAssetRouteAuthority?: {
      readonly status: "empty" | "current" | "stale" | "route_unavailable";
      readonly qaReady?: boolean;
    };
  };
  readonly preview: {
    readonly draft: {
      readonly contentVersionId: string | null;
      readonly assetPackReady?: boolean;
    };
  };
  readonly visual: {
    readonly activeIdentity: {
      readonly id: string;
      readonly version: number;
      readonly immutableHash: string | null;
    } | null;
    readonly activeReferenceSet: {
      readonly id: string;
      readonly revision: number;
      readonly snapshotHash: string | null;
    } | null;
  };
};

function currentWorkspaceQaAuthority(data: CharacterWorkspaceQaAuthority) {
  return {
    characterId: data.character.id,
    projectId: data.project.id,
    characterContentVersionId: data.preview.draft.contentVersionId,
    projectVersion: data.project.version,
    visualProfileId: data.visual.activeIdentity?.id ?? null,
    visualProfileVersion: data.visual.activeIdentity?.version ?? null,
    visualProfileHash: data.visual.activeIdentity?.immutableHash ?? null,
    referenceSetRevisionId: data.visual.activeReferenceSet?.id ?? null,
    referenceSetRevision: data.visual.activeReferenceSet?.revision ?? null,
    referenceSetHash: data.visual.activeReferenceSet?.snapshotHash ?? null,
    draftAssetPackHash: data.project.draftAssetPackHash,
  };
}

export function qaRunMatchesCurrentWorkspaceAuthority(
  run: Omit<CharacterWorkspaceQaAuthorityRun, "id" | "createdAt">,
  data: CharacterWorkspaceQaAuthority,
) {
  return (
    data.project.draftAssetRouteAuthority?.qaReady !== false &&
    data.project.draftAssetRouteAuthority?.status !== "stale" &&
    data.project.draftAssetRouteAuthority?.status !== "route_unavailable" &&
    data.preview.draft.assetPackReady !== false &&
    run.status === "passed" &&
    characterQaAuthorityMatches(run, currentWorkspaceQaAuthority(data))
  );
}

export function latestQaRunForCurrentWorkspaceAuthority<
  T extends CharacterWorkspaceQaAuthorityRun,
>(runs: readonly T[], data: CharacterWorkspaceQaAuthority) {
  if (
    data.project.draftAssetRouteAuthority?.qaReady === false ||
    data.project.draftAssetRouteAuthority?.status === "stale" ||
    data.project.draftAssetRouteAuthority?.status === "route_unavailable" ||
    data.preview.draft.assetPackReady === false
  )
    return null;
  return latestCharacterQaAuthorityRun(runs, currentWorkspaceQaAuthority(data));
}

export function releasableQaRunForCurrentWorkspaceAuthority<
  T extends CharacterWorkspaceQaAuthorityRun,
>(runs: readonly T[], data: CharacterWorkspaceQaAuthority) {
  const latest = latestQaRunForCurrentWorkspaceAuthority(runs, data);
  return latest?.status === "passed" ? latest : null;
}

export function PreviewDiff({
  data,
  permissions,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const snapshots = [data.preview.live, data.preview.draft].filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  const activeReleaseCandidate = data.releases.find(({ release }) =>
    ["draft", "validating", "in_review", "approved"].includes(release.status),
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
        commit: () => adminV2Request(mutation.path, mutation.options),
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
          {/* SPEC: 待发布的改动要列出改了什么，不能只给个计数。
              INTENT: 详情页写"未发布改动 2"、这里也只显示"2 项变更"，运营无从判断该不该发布。
              未被阻塞的分支一直是列字段名的，阻塞分支同样列出来，两条路径口径一致。 */}
          {data.preview.changedFields.length ? (
            <div className="mt-2 flex flex-wrap gap-2" aria-label={t("Changed fields")}>
              {data.preview.changedFields.map((field) => (
                <StatusBadge key={field} tone="warn" value={`${field} changed`} />
              ))}
            </div>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {snapshots.map((snapshot) => {
              const cover = snapshot.assetPack.character_cover;
              const missing = Object.values(snapshot.assetPack).filter(
                (slot) => !slot.imageUrl,
              ).length;
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
      <div
        className="mb-4 flex flex-wrap gap-2"
        aria-label={t("Changed fields")}
      >
        {data.preview.changedFields.map((field) => (
          <StatusBadge key={field} tone="warn" value={`${field} changed`} />
        ))}
      </div>
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

function ReleasePanel({
  data,
  permissions,
  mutationNotice,
  runCommittedMutation,
  beginCommandSubmission,
  abortCommandSubmission,
  pendingCommand,
  rememberPendingCommand,
  discardPendingCommand,
  getDurableCommandIdempotencyKey,
}: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  mutationNotice: CharacterMutationNotice | null;
  runCommittedMutation: RunCommittedCharacterMutation;
  beginCommandSubmission: (message: string) => boolean;
  abortCommandSubmission: () => void;
  pendingCommand: PendingCharacterCommand | null;
  rememberPendingCommand: (command: PendingCharacterCommand) => void;
  discardPendingCommand: (command: PendingCharacterCommand) => void;
  getDurableCommandIdempotencyKey: (signature: string) => string;
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
    if (pendingCommand || mutationNotice) return;
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
      !beginCommandSubmission(
        `Submitting Release ${kind}. Character writes stay locked until command acceptance is known.`,
      )
    ) {
      setBusy(null);
      return;
    }
    let submission: PendingCharacterCommand | null = null;
    try {
      const body = {
        entityVersion: version,
        reason: { code: `operator_${kind}`, summary: reason },
        confirmation: expectedConfirmation,
        ...(scheduledDate ? { scheduledAt: scheduledDate.toISOString() } : {}),
      };
      const signature = `${kind}:${releaseId}:${JSON.stringify(body)}`;
      const idempotencyKey = getDurableCommandIdempotencyKey(signature);
      const endpoint = `/api/v2/admin/characters/${data.character.id}/releases/${releaseId}/commands/${kind}`;
      submission = {
        commandId: null,
        action: `Release ${kind}`,
        signature,
        endpoint,
        body,
        idempotencyKey,
        createdAt: Date.now(),
        terminal: false,
      };
      rememberPendingCommand(submission);
      const accepted = await adminV2Request(endpoint, {
        method: "POST",
        idempotencyKey,
        schema: adminCommandAcceptedSchema,
        body,
      });
      const pending = {
        ...submission,
        commandId: accepted.commandId,
      } satisfies PendingCharacterCommand;
      rememberPendingCommand(pending);
      setReleaseConfirmed(false);
    } catch (cause) {
      const conflict = activeCommandConflict(cause);
      if (!submission) {
        abortCommandSubmission();
      } else if (conflict) {
        rememberPendingCommand({
          commandId: conflict.commandId,
          action: characterCommandActionLabel(conflict.commandType),
          signature: `authority:${conflict.commandId}`,
          createdAt: Date.now(),
          terminal: false,
        });
      } else if (isDefinitiveCommandRejection(cause)) {
        discardPendingCommand(submission);
      }
      setError(
        conflict
          ? `${characterCommandActionLabel(conflict.commandType)} is already active. This workspace attached to that command instead of accepting another one.`
          : cause instanceof Error
            ? cause.message
            : submission
              ? `Release ${kind} acceptance is unknown. The same command will be replayed safely.`
              : `Could not ${kind} release`,
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
        commit: () => adminV2Request(mutation.path, mutation.options),
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
        commit: () => adminV2Request(mutation.path, mutation.options),
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
          adminV2Request(
            `/api/v2/admin/characters/${data.character.id}/releases/${candidate.release.id}/validation`,
            {
              method: "POST",
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
    if (!data.serving || pendingCommand || mutationNotice) return;
    setBusy(action);
    setError(null);
    if (
      !beginCommandSubmission(
        `Submitting Serving ${action}. Character writes stay locked until command acceptance is known.`,
      )
    ) {
      setBusy(null);
      return;
    }
    let submission: PendingCharacterCommand | null = null;
    try {
      const body = {
        entityVersion: data.serving.version,
        reason: { code: `operator_${action}`, summary: reason },
        confirmation: `${data.character.id}:${action}`,
      };
      const signature = `${action}:${data.character.id}:${JSON.stringify(body)}`;
      const idempotencyKey = getDurableCommandIdempotencyKey(signature);
      const endpoint = `/api/v2/admin/characters/${data.character.id}/commands/${action}`;
      submission = {
        commandId: null,
        action: `Serving ${action}`,
        signature,
        endpoint,
        body,
        idempotencyKey,
        createdAt: Date.now(),
        terminal: false,
      };
      rememberPendingCommand(submission);
      const accepted = await adminV2Request(endpoint, {
        method: "POST",
        idempotencyKey,
        schema: adminCommandAcceptedSchema,
        body,
      });
      const pending = {
        ...submission,
        commandId: accepted.commandId,
      } satisfies PendingCharacterCommand;
      rememberPendingCommand(pending);
      setReleaseConfirmed(false);
    } catch (cause) {
      const conflict = activeCommandConflict(cause);
      if (!submission) {
        abortCommandSubmission();
      } else if (conflict) {
        rememberPendingCommand({
          commandId: conflict.commandId,
          action: characterCommandActionLabel(conflict.commandType),
          signature: `authority:${conflict.commandId}`,
          createdAt: Date.now(),
          terminal: false,
        });
      } else if (isDefinitiveCommandRejection(cause)) {
        discardPendingCommand(submission);
      }
      setError(
        conflict
          ? `${characterCommandActionLabel(conflict.commandType)} is already active. This workspace attached to that command instead of accepting another one.`
          : cause instanceof Error
            ? cause.message
            : submission
              ? `Serving ${action} acceptance is unknown. The same command will be replayed safely.`
              : `Could not ${action} Character`,
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
        {candidate || releasableQaRun ? (
          <>
            <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Reason")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </label>
            {!candidate ? (
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
              {!candidate ? (
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

export function MonitorPanel({
  data,
  permissions,
  runCommittedMutation,
  onOpenVisual,
}: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  runCommittedMutation: RunCommittedCharacterMutation;
  onOpenVisual: () => void;
}) {
  const { t } = useAdminI18n();
  const current = data.releases.find(
    ({ release }) => release.id === data.serving?.currentReleaseId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshIdempotencyKeys = useRef<Record<string, string>>({});
  const refresh = async (window: "24h" | "72h") => {
    if (!current) return;
    setBusy(true);
    setError(null);
    const signature = `${current.release.id}:${current.release.version}:${window}`;
    const idempotencyKey =
      refreshIdempotencyKeys.current[signature] ?? crypto.randomUUID();
    refreshIdempotencyKeys.current[signature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: `${window} Release monitor refresh`,
        commit: () =>
          adminV2Request(
            `/api/v2/admin/characters/${data.character.id}/releases/${current.release.id}/monitors/${window}/refresh`,
            {
              method: "POST",
              idempotencyKey,
              body: { entityVersion: current.release.version },
            },
          ),
        afterRefresh: () => {
          delete refreshIdempotencyKeys.current[signature];
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("Monitor refresh failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!current)
    return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  const windows = characterMonitorWindows(current.monitors);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <WorkspaceButton
          disabled={busy || !permissions.reviewRelease}
          onClick={() => void refresh("24h")}
        >
          <RefreshCcw className="h-4 w-4" /> {t("Refresh 24h")}
        </WorkspaceButton>
        <WorkspaceButton
          disabled={busy || !permissions.reviewRelease}
          onClick={() => void refresh("72h")}
        >
          <RefreshCcw className="h-4 w-4" /> {t("Refresh 72h")}
        </WorkspaceButton>
      </div>
      {!permissions.reviewRelease ? (
        <p className="mb-4 text-xs text-[var(--ad-text-muted)]">
          {t("Read-only: character.release.review is not granted.")}
        </p>
      ) : null}
      {error ? (
        <p className="mb-4 text-sm text-[var(--ad-red-text)]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {windows.map((window) => {
          const monitor = current.monitors.find(
            (item) => item.window === window,
          );
          const emptyStatus =
            window === "route_qualification" ? "not_required" : "pending";
          return (
            <article
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              key={window}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  {t(window.replaceAll("_", " "))} {t("guardrail")}
                </h3>
                <StatusBadge value={monitor?.status ?? emptyStatus} />
              </div>
              {monitor ? (
                <>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    {Object.entries(monitor.observed).map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-[var(--ad-text-muted)]">{key}</dt>
                        <dd className="mt-1 font-semibold">
                          {String(value ?? t("Unavailable"))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 text-xs text-[var(--ad-text-muted)]">
                    {t("Recommendation:")}{" "}
                    {t(
                      String(
                        monitor.verification.recommendation ??
                          (window === "route_qualification" &&
                          monitor.status === "action_required"
                            ? "refresh the active image route before the next Release"
                            : "continue_monitoring"),
                      ),
                    )}
                  </p>
                  {window === "route_qualification" &&
                  monitor.status === "action_required" ? (
                    <button
                      className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold underline"
                      onClick={onOpenVisual}
                      type="button"
                    >
                      {t("Open image route")}
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {window === "route_qualification"
                    ? t("No image route action is currently required.")
                    : t(
                        "No observation yet. Refresh once the release is published.",
                      )}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PerformanceMetricCard({
  metric,
}: {
  metric: CharacterWorkspaceDetail["performance"][number];
}) {
  const { t } = useAdminI18n();
  return (
    <article className="grid gap-3 border-b border-[var(--ad-border)] px-1 py-3 last:border-b-0 sm:grid-cols-[minmax(9rem,1.4fr)_repeat(4,minmax(4.5rem,.7fr))_auto] sm:items-center">
      <div>
        <h3 className="text-sm font-semibold">{metric.window}</h3>
        <p className="mt-0.5 text-xs text-[var(--ad-text-muted)]">
          {metric.placementId ? t(metric.placementId) : t("all placements")}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs sm:contents">
        <div><dt className="text-[var(--ad-text-muted)]">{t("QCE")}</dt><dd className="mt-0.5 font-semibold">{percent(metric.qceRate)}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Same-character D7")}</dt><dd className="mt-0.5 font-semibold">{percent(metric.sameCharacterD7)}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Sample")}</dt><dd className="mt-0.5 font-semibold">{metric.sampleSize}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Margin")}</dt><dd className="mt-0.5 font-semibold">{metric.contributionMargin.valueMicros === null ? t("Unavailable") : metric.contributionMargin.valueMicros.toLocaleString()}</dd></div>
      </dl>
      <span className="justify-self-start">
        <StatusBadge value={metric.maturity} />
      </span>
    </article>
  );
}

export const portfolioDecisions = [
  "Promote",
  "Maintain",
  "Improve",
  "Pause",
  "Retire",
] as const;

export function PerformancePanel({
  data,
  permissions,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const releaseId =
    data.serving?.currentReleaseId ?? data.releases[0]?.release.id ?? "";
  const [decision, setDecision] =
    useState<(typeof portfolioDecisions)[number]>("Maintain");
  // INTENT: 这三条是决策记录的正文，运营会改后提交——初值用 lazy t()，跟随 PreviewDiff 的 reason 惯例。
  const [question, setQuestion] = useState(() =>
    t(
      "What should we do with this Character based on current release evidence?",
    ),
  );
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [evidenceLevel, setEvidenceLevel] = useState<
    "observational" | "attribution" | "causal"
  >("observational");
  const [confidence, setConfidence] = useState("");
  const [successCriteria, setSuccessCriteria] = useState(() =>
    t("Review the selected action at the next portfolio window"),
  );
  const [guardrails, setGuardrails] = useState(() =>
    t("Do not regress qualified conversation or Same-character D7"),
  );
  const [reviewAt, setReviewAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionIdempotencyKeys = useRef<Record<string, string>>({});
  const recordDecision = async () => {
    setBusy(true);
    setError(null);
    const body = {
      releaseId,
      decision,
      question,
      evidenceRefs: evidenceRefs
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      evidenceLevel,
      confidence: confidence ? Number(confidence) : null,
      successCriteria: successCriteria
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      guardrails: guardrails
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      reviewAt: reviewAt ? new Date(reviewAt).toISOString() : null,
    };
    const signature = JSON.stringify(body);
    const idempotencyKey =
      decisionIdempotencyKeys.current[signature] ?? crypto.randomUUID();
    decisionIdempotencyKeys.current[signature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: "Portfolio decision",
        commit: () =>
          adminV2Request(
            `/api/v2/admin/characters/${data.character.id}/portfolio-decisions`,
            {
              method: "POST",
              idempotencyKey,
              body,
            },
          ),
        afterRefresh: () => {
          delete decisionIdempotencyKeys.current[signature];
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("Could not record portfolio decision"),
      );
    } finally {
      setBusy(false);
    }
  };
  const latest = data.portfolio.latestDecision;
  const primaryDiagnosisMetric =
    data.performance.find((metric) => characterNoDataDiagnosis(metric)?.alert) ??
    data.performance.find((metric) => characterNoDataDiagnosis(metric));
  const primaryDiagnosis = primaryDiagnosisMetric
    ? characterNoDataDiagnosis(primaryDiagnosisMetric)
    : null;
  const primaryQualityProblem = data.performance.find(
    (metric) => metric.qualityState === "invalid",
  );
  const hasObservations = characterPerformanceHasObservations(
    data.performance,
  );
  return (
    <div className="space-y-5">
      <section
        aria-labelledby="character-performance-title"
        className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold" id="character-performance-title">
              {t("Performance")}
            </h3>
            {primaryQualityProblem ? (
              <p className="mt-1 text-sm text-[var(--ad-red-text)]">
                {t(primaryQualityProblem.qualityState)}
              </p>
            ) : primaryDiagnosis && primaryDiagnosisMetric ? (
              <p
                className={cn(
                  "mt-1 text-sm",
                  primaryDiagnosis.alert
                    ? "text-[var(--ad-yellow-text)]"
                    : "text-[var(--ad-text-muted)]",
                )}
              >
                {t(primaryDiagnosis.message, {
                  window: primaryDiagnosisMetric.window,
                })}
              </p>
            ) : null}
          </div>
          <span className="text-xs text-[var(--ad-text-muted)]">
            {t("{count} views", { count: data.performance.length })}
          </span>
        </div>
        <div className="mt-3">
          {data.performance.length === 0 ? (
            <EmptyWorkspace filtered={false} onClear={() => undefined} />
          ) : !hasObservations ? (
            <div
              className="border-t border-[var(--ad-border)] py-5"
              role="status"
            >
              <strong className="text-sm">{t("No performance data yet")}</strong>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
                {t(
                  "{count} monitoring windows are active. QCE, same-character D7, and margin will appear after the first valid events arrive.",
                  { count: data.performance.length },
                )}
              </p>
            </div>
          ) : (
            data.performance.map((metric) => (
              <PerformanceMetricCard
                key={`${metric.window}-${metric.placementId ?? "all"}`}
                metric={metric}
              />
            ))
          )}
        </div>
      </section>
      <section
        aria-labelledby="latest-portfolio-decision-title"
        className="border-b border-[var(--ad-border)] pb-5"
      >
        <h3 className="font-semibold" id="latest-portfolio-decision-title">
          {t("Latest Decision Record")}
        </h3>
          {latest ? (
            <div className="mt-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <StatusBadge value={latest.decision} />
                <StatusBadge value={latest.evidenceLevel} />
              </div>
              <p className="mt-3">{latest.question}</p>
              <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
                {t("Owner")} {latest.ownerId} {t("· review")}{" "}
                {latest.reviewAt ?? t("not scheduled")} {t("· confidence")}{" "}
                {latest.confidence ?? t("unavailable")}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
              {t("No portfolio decision has been recorded.")}
            </p>
          )}
      </section>
      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer p-4 font-semibold">
          {t("New portfolio decision")}
        </summary>
        <div className="border-t border-[var(--ad-border)] p-4">
          {/* SPEC: option 必须显式带 value —— 提交给后端的是 characterPortfolioDecisionSchema 的英文枚举，
          缺了 value 时译文会当成枚举值提交并被后端拒掉。 */}
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Action")}
            <select
              className={`${fieldClass} mt-1`}
              onChange={(event) =>
                setDecision(event.target.value as typeof decision)
              }
              value={decision}
            >
              {portfolioDecisions.map((value) => (
                <option key={value} value={value}>
                  {t(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Decision question")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setQuestion(event.target.value)}
              value={question}
            />
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Evidence references")}
            <input
              className={`${fieldClass} mt-1`}
              onChange={(event) => setEvidenceRefs(event.target.value)}
              placeholder={t("metric:, release:, qa: (comma separated)")}
              value={evidenceRefs}
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Evidence level")}
              <select
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  setEvidenceLevel(event.target.value as typeof evidenceLevel)
                }
                value={evidenceLevel}
              >
                <option value="observational">{t("Observational")}</option>
                <option value="attribution">{t("Attribution")}</option>
                <option value="causal">{t("Causal")}</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Confidence")}
              <input
                className={`${fieldClass} mt-1`}
                max="1"
                min="0"
                onChange={(event) => setConfidence(event.target.value)}
                step="0.01"
                type="number"
                value={confidence}
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Success criteria")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setSuccessCriteria(event.target.value)}
              value={successCriteria}
            />
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Guardrails")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setGuardrails(event.target.value)}
              value={guardrails}
            />
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Review at")}
            <input
              className={`${fieldClass} mt-1`}
              onChange={(event) => setReviewAt(event.target.value)}
              type="datetime-local"
              value={reviewAt}
            />
          </label>
          {error ? (
            <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4">
            <WorkspaceButton
              disabled={
                !permissions.writeProject ||
                busy ||
                !releaseId ||
                question.trim().length < 3 ||
                !evidenceRefs.trim() ||
                !successCriteria.trim()
              }
              onClick={() => void recordDecision()}
              tone="primary"
            >
              {t("Record Decision")}
            </WorkspaceButton>
          </div>
        </div>
      </details>
    </div>
  );
}

function CharacterDetail({
  actorId,
  id,
  permissions,
}: {
  actorId: string;
  id: string;
  permissions: Permissions;
}) {
  const { locale, t } = useAdminI18n();
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandRecoveryError, setCommandRecoveryError] = useState<
    string | null
  >(null);
  const [pendingCommand, setPendingCommand] =
    useState<PendingCharacterCommand | null>(null);
  const [mutationNotice, setMutationNotice] =
    useState<CharacterMutationNotice | null>(null);
  const [reclaimingVoiceRequestId, setReclaimingVoiceRequestId] = useState<
    string | null
  >(null);
  const mutationNoticeRef = useRef<CharacterMutationNotice | null>(
    mutationNotice,
  );
  const pendingCommandRef = useRef<PendingCharacterCommand | null>(
    pendingCommand,
  );
  const mutationAuthority = useRef(
    createCharacterMutationAuthorityCoordinator(),
  );
  const requestGate = useRef(createLatestRequestGate());
  const durableCommandIdempotencyKeys = useRef<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "project";
    if (readPendingCharacterCommand(id, actorId)) return "release";
    return characterWorkspaceTabFromSearch(window.location.search);
  });
  const tabRef = useRef(tab);
  const load = useCallback(async () => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const next = await adminV2Request(`/api/v2/admin/characters/${id}`, {
        schema: characterWorkspaceDetailSchema,
      });
      if (request.isCurrent()) setData(next);
    } catch (cause) {
      if (request.isCurrent()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Character workspace could not be loaded",
        );
      }
      throw cause;
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [id]);
  const loadAuthoritative = useCallback(async () => {
    requestGate.current.invalidate();
    setLoading(true);
    setError(null);
    try {
      const next = await adminV2Request(`/api/v2/admin/characters/${id}`, {
        schema: characterWorkspaceDetailSchema,
      });
      setData(next);
      return next;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Character workspace could not be loaded",
      );
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [id]);
  const updateMutationNotice = useCallback(
    (notice: CharacterMutationNotice | null) => {
      mutationAuthority.current.setNotice(notice);
      mutationNoticeRef.current = notice;
      setMutationNotice(notice);
    },
    [],
  );
  const getDurableCommandIdempotencyKey = useCallback(
    (signature: string) => {
      const inMemory = durableCommandIdempotencyKeys.current[signature];
      const storage = browserCharacterCommandStorage();
      if (!storage) {
        const key = inMemory ?? crypto.randomUUID();
        durableCommandIdempotencyKeys.current[signature] = key;
        return key;
      }
      const key = getOrCreateCharacterCommandIdempotencyKey(
        storage,
        actorId,
        id,
        signature,
        () => inMemory ?? crypto.randomUUID(),
      );
      durableCommandIdempotencyKeys.current[signature] = key;
      return key;
    },
    [actorId, id],
  );
  const releaseDurableCommandIdempotencyKey = useCallback(
    (signature: string) => {
      delete durableCommandIdempotencyKeys.current[signature];
      const storage = browserCharacterCommandStorage();
      if (storage) {
        releaseCharacterCommandIdempotencyKey(storage, actorId, id, signature);
      }
    },
    [actorId, id],
  );
  const rememberPendingCommand = useCallback(
    (command: PendingCharacterCommand) => {
      const nextNotice: CharacterMutationNotice = command.commandId
        ? {
            kind: "command_pending",
            message: `${command.action} command is pending. Character writes stay locked until the worker records a terminal result and the workspace refreshes.`,
            commandId: command.commandId,
          }
        : {
            kind: "command_submission_unknown",
            message: `${command.action} may already be accepted. The exact command is being replayed with the same idempotency key before any other Character write is allowed.`,
          };
      mutationAuthority.current.rememberCommand(command, nextNotice);
      persistPendingCharacterCommand(id, actorId, command);
      pendingCommandRef.current = command;
      setPendingCommand(command);
      setCommandRecoveryError(null);
      updateMutationNotice(nextNotice);
    },
    [actorId, id, updateMutationNotice],
  );
  const refreshCommittedProjection = useCallback(
    async (action: string, commandId?: string, afterRefresh?: () => void) => {
      const result = await mutationAuthority.current.refresh({
        load: loadAuthoritative,
        canUnlock: (authoritative) => authoritative.activeCommand === null,
        onUnlock: () => {
          updateMutationNotice(null);
          afterRefresh?.();
        },
      });
      if (result.status === "superseded") {
        return !("error" in result);
      }
      if (result.status === "failed") {
        setError(null);
        updateMutationNotice({
          kind: "refresh_required",
          message: committedCharacterProjectionWarning(action, result.error),
          ...(commandId ? { commandId } : {}),
        });
        return false;
      }
      if (result.status === "kept_locked") {
        if (result.projection.activeCommand) {
          rememberPendingCommand(
            pendingCommandFromAuthority(result.projection.activeCommand),
          );
        }
        return true;
      }
      updateMutationNotice(null);
      setError(null);
      if (result.status === "cleanup_failed") {
        const cleanupCause = result.error;
        setCommandRecoveryError(
          cleanupCause instanceof Error
            ? `The authoritative workspace refreshed, but local cleanup needs attention: ${cleanupCause.message}`
            : "The authoritative workspace refreshed, but local cleanup needs attention.",
        );
      }
      return true;
    },
    [loadAuthoritative, rememberPendingCommand, updateMutationNotice],
  );
  const runCommittedMutation = useCallback(
    async <T,>(input: {
      readonly action: string;
      readonly commit: () => Promise<T>;
      readonly afterRefresh?: () => void;
    }) => {
      if (mutationNoticeRef.current || pendingCommandRef.current) {
        throw new Error(
          "Refresh the authoritative Character workspace before another write.",
        );
      }
      const generation = mutationAuthority.current.advanceGeneration();
      updateMutationNotice({
        kind: "mutation_in_flight",
        message: `${input.action} is being committed. Character writes stay locked until the authoritative workspace refreshes.`,
      });
      let result: T;
      try {
        result = await input.commit();
      } catch (cause) {
        if (mutationAuthority.current.isCurrentGeneration(generation)) {
          updateMutationNotice(null);
        }
        throw cause;
      }
      const refreshed = await refreshCommittedProjection(
        input.action,
        undefined,
        input.afterRefresh,
      );
      return { result, refreshed };
    },
    [refreshCommittedProjection, updateMutationNotice],
  );
  const reclaimVoiceRequest = useCallback(
    async (input: {
      readonly requestId: string;
      readonly actionHref: string;
      readonly confirmation: string;
      readonly reason: string;
    }) => {
      const signature = `voice-clip-reclaim:${input.requestId}`;
      const idempotencyKey = getDurableCommandIdempotencyKey(signature);
      setReclaimingVoiceRequestId(input.requestId);
      setError(null);
      try {
        await runCommittedMutation({
          action: "Voice request reclaim",
          commit: () =>
            adminV2Request(input.actionHref, {
              method: "POST",
              idempotencyKey,
              body: {
                requestId: input.requestId,
                confirmation: input.confirmation,
                reason: input.reason,
              },
              schema: characterVoiceClipReclaimResponseSchema,
            }),
        });
        releaseDurableCommandIdempotencyKey(signature);
      } catch (cause) {
        if (shouldReleaseVoiceReclaimIdempotencyKey(cause)) {
          releaseDurableCommandIdempotencyKey(signature);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Voice request reclaim failed",
        );
        throw cause;
      } finally {
        setReclaimingVoiceRequestId(null);
      }
    },
    [
      getDurableCommandIdempotencyKey,
      releaseDurableCommandIdempotencyKey,
      runCommittedMutation,
    ],
  );
  const discardPendingCommand = useCallback(
    (command: PendingCharacterCommand) => {
      const current = pendingCommandRef.current;
      if (!current || !isSamePendingCharacterCommand(current, command))
        return false;
      if (!mutationAuthority.current.currentCommandIs(command)) return false;
      if (!clearPendingCharacterCommand(id, actorId, command)) return false;
      if (!mutationAuthority.current.clearCommand(command)) return false;
      releaseDurableCommandIdempotencyKey(command.signature);
      pendingCommandRef.current = null;
      setPendingCommand(null);
      updateMutationNotice(null);
      return true;
    },
    [actorId, id, releaseDurableCommandIdempotencyKey, updateMutationNotice],
  );
  const beginCommandSubmission = useCallback(
    (message: string) => {
      if (mutationNoticeRef.current || pendingCommandRef.current) return false;
      mutationAuthority.current.advanceGeneration();
      updateMutationNotice({ kind: "mutation_in_flight", message });
      return true;
    },
    [updateMutationNotice],
  );
  const abortCommandSubmission = useCallback(() => {
    if (mutationNoticeRef.current?.kind === "mutation_in_flight") {
      mutationAuthority.current.advanceGeneration();
      updateMutationNotice(null);
    }
  }, [updateMutationNotice]);
  const settlePendingCommand = useCallback(
    (
      action: string,
      commandId: string | undefined,
      afterRefresh?: () => void,
    ) => refreshCommittedProjection(action, commandId, afterRefresh),
    [refreshCommittedProjection],
  );
  const refreshAuthoritativeWorkspace = useCallback(async () => {
    if (
      mutationNoticeRef.current?.kind === "command_pending" ||
      mutationNoticeRef.current?.kind === "command_submission_unknown" ||
      mutationNoticeRef.current?.kind === "command_reconfirmation_required"
    )
      return false;
    const current = mutationNoticeRef.current;
    const result = await mutationAuthority.current.refresh({
      load: loadAuthoritative,
      canUnlock: (authoritative) => authoritative.activeCommand === null,
      reusePendingCleanup: true,
    });
    if (result.status === "superseded") {
      return !("error" in result);
    }
    if (result.status === "failed") {
      setError(null);
      updateMutationNotice({
        kind: "refresh_required",
        message:
          current?.kind === "refresh_required"
            ? current.message
            : committedCharacterProjectionWarning(
                "Character mutation",
                result.error,
              ),
        ...(current?.kind === "refresh_required" && current.commandId
          ? { commandId: current.commandId }
          : {}),
      });
      return false;
    }
    if (result.status === "kept_locked") {
      if (result.projection.activeCommand) {
        rememberPendingCommand(
          pendingCommandFromAuthority(result.projection.activeCommand),
        );
      }
      return true;
    }
    updateMutationNotice(null);
    setError(null);
    if (result.status === "cleanup_failed") {
      const cleanupCause = result.error;
      setCommandRecoveryError(
        cleanupCause instanceof Error
          ? `The authoritative workspace refreshed, but local cleanup needs attention: ${cleanupCause.message}`
          : "The authoritative workspace refreshed, but local cleanup needs attention.",
      );
    }
    return true;
  }, [loadAuthoritative, rememberPendingCommand, updateMutationNotice]);
  const reconcilePendingCommandAuthority = useCallback(
    async (command: PendingCharacterCommand, message: string) => {
      const current = pendingCommandRef.current;
      if (!current || !isSamePendingCharacterCommand(current, command))
        return false;
      if (!mutationAuthority.current.currentCommandIs(command)) return false;
      const generation = mutationAuthority.current.getGeneration();
      updateMutationNotice({
        kind: "refresh_required",
        message,
        ...(command.commandId ? { commandId: command.commandId } : {}),
      });
      try {
        const authoritative = await loadAuthoritative();
        if (
          !mutationAuthority.current.isCurrentGeneration(generation) ||
          !mutationAuthority.current.currentCommandIs(command) ||
          !pendingCommandRef.current ||
          !isSamePendingCharacterCommand(pendingCommandRef.current, command)
        )
          return false;
        if (authoritative.activeCommand) {
          const active = pendingCommandFromAuthority(
            authoritative.activeCommand,
          );
          rememberPendingCommand(active);
          setCommandRecoveryError(
            `${active.action} is still active according to server authority. Character writes remain locked.`,
          );
          return false;
        }
        if (!discardPendingCommand(command)) return false;
        setCommandRecoveryError(null);
        return true;
      } catch (cause) {
        if (
          !mutationAuthority.current.isCurrentGeneration(generation) ||
          !mutationAuthority.current.currentCommandIs(command) ||
          !pendingCommandRef.current ||
          !isSamePendingCharacterCommand(pendingCommandRef.current, command)
        )
          return false;
        setError(null);
        updateMutationNotice({
          kind: "refresh_required",
          message: committedCharacterProjectionWarning(
            `${command.action} command reconciliation`,
            cause,
          ),
          ...(command.commandId ? { commandId: command.commandId } : {}),
        });
        return false;
      }
    },
    [
      discardPendingCommand,
      loadAuthoritative,
      rememberPendingCommand,
      updateMutationNotice,
    ],
  );
  const authorizePendingCommandReplay = useCallback(() => {
    const current = pendingCommandRef.current;
    if (!current || current.commandId) return;
    const now = Date.now();
    mutationAuthority.current.advanceGeneration();
    rememberPendingCommand({
      ...current,
      createdAt: now,
      autoReplayUntil: now + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS,
    });
    setCommandRecoveryError(null);
  }, [rememberPendingCommand]);
  useEffect(() => {
    pendingCommandRef.current = pendingCommand;
  }, [pendingCommand]);
  useEffect(() => {
    if (!permissions.read) return;
    const gate = requestGate.current;
    const timer = window.setTimeout(
      () => void load().catch(() => undefined),
      0,
    );
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [load, permissions.read]);
  useEffect(() => {
    const restore = () => {
      const pending = readPendingCharacterCommand(id, actorId);
      if (!pending) {
        return;
      }
      rememberPendingCommand(pending);
      setTab("release");
      setWorkspaceUrl(new URLSearchParams({ tab: "release" }), {
        mode: "replace",
      });
    };
    const timer = window.setTimeout(restore, 0);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== pendingCommandStorageKey(actorId, id)) return;
      if (event.newValue !== null) {
        restore();
        return;
      }
      const current = pendingCommandRef.current;
      if (!current) return;
      void reconcilePendingCommandAuthority(
        current,
        `${current.action} was completed or cleared in another tab. This tab must refresh server authority before writes resume.`,
      );
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [actorId, id, reconcilePendingCommandAuthority, rememberPendingCommand]);
  useEffect(() => {
    const active = data?.activeCommand;
    if (!active || pendingCommandRef.current?.commandId === active.commandId)
      return;
    rememberPendingCommand(pendingCommandFromAuthority(active));
    setTab("release");
    setWorkspaceUrl(new URLSearchParams({ tab: "release" }), {
      mode: "replace",
    });
  }, [data?.activeCommand, rememberPendingCommand]);
  useEffect(() => {
    if (!pendingCommand || pendingCommand.terminal) return;
    let cancelled = false;
    let timer = 0;
    const schedule = (callback: () => void, delay: number) => {
      if (!cancelled) timer = window.setTimeout(callback, delay);
    };
    const recover = async () => {
      if (!pendingCommand.commandId) {
        if (!characterCommandJournalCanAutoReplay(pendingCommand)) {
          updateMutationNotice({
            kind: "command_reconfirmation_required",
            message: `${pendingCommand.action} was saved before acceptance could be proven, but the automatic replay window expired. Review the action and explicitly resume it; no old command will run automatically.`,
          });
          setCommandRecoveryError(
            `${pendingCommand.action} requires fresh operator confirmation before the saved request can be replayed.`,
          );
          return;
        }
        if (
          !pendingCommand.endpoint ||
          pendingCommand.body === undefined ||
          !pendingCommand.idempotencyKey
        ) {
          setPendingCommand((current) =>
            current ? { ...current, terminal: true } : current,
          );
          setCommandRecoveryError(
            `${pendingCommand.action} recovery journal is incomplete. The authoritative workspace must be reconciled before writes resume.`,
          );
          await reconcilePendingCommandAuthority(
            pendingCommand,
            `${pendingCommand.action} recovery evidence is incomplete. Server authority must be reconciled before writes resume.`,
          );
          return;
        }
        try {
          const accepted = await adminV2Request(pendingCommand.endpoint, {
            method: "POST",
            idempotencyKey: pendingCommand.idempotencyKey,
            schema: adminCommandAcceptedSchema,
            body: pendingCommand.body,
          });
          if (cancelled) return;
          rememberPendingCommand({
            ...pendingCommand,
            commandId: accepted.commandId,
          });
          return;
        } catch (cause) {
          if (cancelled) return;
          const conflict = activeCommandConflict(cause);
          if (conflict) {
            rememberPendingCommand({
              commandId: conflict.commandId,
              action: characterCommandActionLabel(conflict.commandType),
              signature: `authority:${conflict.commandId}`,
              createdAt: Date.now(),
              terminal: false,
            });
            setCommandRecoveryError(
              `${characterCommandActionLabel(conflict.commandType)} is already active according to server authority. The workspace attached to that command instead of submitting a second one.`,
            );
            return;
          }
          const replayDisposition = characterCommandReplayFailureDisposition(
            cause instanceof AdminV2RequestError ? cause.status : null,
          );
          if (replayDisposition === "keep_locked") {
            setCommandRecoveryError(
              `${pendingCommand.action} acceptance cannot be proven with the current session or permissions. The original command may already exist, so Character writes remain locked while the exact idempotent request waits to retry.`,
            );
            schedule(() => void recover(), 5_000);
            return;
          }
          if (replayDisposition === "reconcile") {
            setCommandRecoveryError(
              `${pendingCommand.action} replay was rejected, but the original acceptance is still unknown. Server-side Character authority must reconcile the active command before writes resume.`,
            );
            const reconciled = await reconcilePendingCommandAuthority(
              pendingCommand,
              `${pendingCommand.action} replay was rejected after its original response was lost. Server-side Character authority must prove that no command remains active before writes resume.`,
            );
            if (reconciled) {
              setCommandRecoveryError(
                cause instanceof Error
                  ? `${pendingCommand.action} replay was rejected, and server-side Character authority confirmed that no active command remains: ${cause.message}`
                  : `${pendingCommand.action} replay was rejected, and server-side Character authority confirmed that no active command remains.`,
              );
            }
            return;
          }
          setCommandRecoveryError(
            cause instanceof Error
              ? `${pendingCommand.action} acceptance is still unknown: ${cause.message}. Retrying the exact command safely.`
              : `${pendingCommand.action} acceptance is still unknown. Retrying the exact command safely.`,
          );
          schedule(() => void recover(), 2_000);
          return;
        }
      }

      try {
        const status = await adminV2Request<AdminCommandStatus>(
          `/api/v2/admin/commands/${encodeURIComponent(pendingCommand.commandId)}`,
          { schema: adminCommandStatusSchema },
        );
        if (cancelled) return;
        if (["failed", "cancelled", "succeeded"].includes(status.status)) {
          setPendingCommand((current) =>
            current ? { ...current, terminal: true } : current,
          );
          const failed = status.status !== "succeeded";
          await settlePendingCommand(
            failed
              ? `${pendingCommand.action} ${status.status}`
              : pendingCommand.action,
            pendingCommand.commandId,
            () => discardPendingCommand(pendingCommand),
          );
          setCommandRecoveryError(
            failed
              ? `${pendingCommand.action} command ${status.status}. Open command evidence for the authoritative result.`
              : null,
          );
          return;
        }
        setCommandRecoveryError(null);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof AdminV2RequestError && cause.status === 404) {
          setPendingCommand((current) =>
            current ? { ...current, terminal: true } : current,
          );
          const reconciled = await reconcilePendingCommandAuthority(
            pendingCommand,
            `${pendingCommand.action} command evidence returned 404. Server-side Character authority must prove that no command remains active before writes resume.`,
          );
          setCommandRecoveryError(
            reconciled
              ? `${pendingCommand.action} command evidence was unavailable, and server-side Character authority confirmed that no command remains active.`
              : `${pendingCommand.action} command evidence is unavailable. Character writes remain locked until server authority can be reconciled.`,
          );
          return;
        }
        if (
          cause instanceof AdminV2RequestError &&
          [401, 403].includes(cause.status)
        ) {
          setCommandRecoveryError(
            `${pendingCommand.action} command evidence cannot be read with the current session or permissions. The command may still be running, so Character writes remain locked.`,
          );
          schedule(() => void recover(), 5_000);
          return;
        }
        setCommandRecoveryError(
          cause instanceof Error
            ? `${pendingCommand.action} status could not be refreshed: ${cause.message}`
            : `${pendingCommand.action} status could not be refreshed.`,
        );
      }
      schedule(() => void recover(), 1_000);
    };
    const initialDelay = pendingCommand.commandId
      ? 500
      : Math.max(250, pendingCommand.createdAt + 1_500 - Date.now());
    schedule(() => void recover(), initialDelay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    discardPendingCommand,
    pendingCommand,
    reconcilePendingCommandAuthority,
    rememberPendingCommand,
    settlePendingCommand,
    updateMutationNotice,
  ]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    if (tab !== "visual") return;
    const targetId = window.location.hash.replace(/^#/, "");
    if (
      ![
        "visual-production-readiness",
        "visual-identity-version",
        "visual-reference-set",
        "route-qualification-workbench",
      ].includes(targetId)
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ block: "start" });
      target?.querySelector("summary")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tab, data?.visual.imageReadiness?.state, data?.visual.readiness.ready]);
  useEffect(() => {
    const restoreTab = () => {
      if (
        mutationNoticeRef.current ||
        pendingCommandRef.current ||
        data?.activeCommand
      ) {
        setWorkspaceUrl(new URLSearchParams({ tab: tabRef.current }), {
          mode: "replace",
        });
        return;
      }
      setTab(characterWorkspaceTabFromSearch(window.location.search));
    };
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, [data?.activeCommand, id]);
  if (!permissions.read) return permissionDenied("character.project.read");
  if (loading && !data && !pendingCommand) {
    return (
      <LoadingWorkspace label="Loading Character Project, Release and Monitor evidence" />
    );
  }
  if (!data) {
    return (
      <section className="space-y-3">
        {mutationNotice ? (
          <div
            className="rounded-xl bg-[var(--ad-blue-bg)] p-4 text-sm text-[var(--ad-blue-text)]"
            role="status"
          >
            <p>{mutationNotice.message}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              {mutationNotice.kind === "refresh_required" ? (
                <button
                  className="font-semibold underline"
                  onClick={() => void refreshAuthoritativeWorkspace()}
                  type="button"
                >
                  {t("Retry authoritative workspace")}
                </button>
              ) : null}
              {mutationNotice.kind === "command_reconfirmation_required" &&
              pendingCommand ? (
                <button
                  className="font-semibold underline"
                  onClick={authorizePendingCommandReplay}
                  type="button"
                >
                  {t("Review and resume saved command")}
                </button>
              ) : null}
              {"commandId" in mutationNotice && mutationNotice.commandId ? (
                <Link
                  className="font-semibold underline"
                  href={`/admin/system/audit?commandId=${encodeURIComponent(mutationNotice.commandId)}`}
                >
                  {t("Open command evidence")}
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        {commandRecoveryError ? (
          <p
            className="rounded-xl bg-[var(--ad-yellow-bg)] p-4 text-sm text-[var(--ad-yellow-text)]"
            role="alert"
          >
            {commandRecoveryError}
          </p>
        ) : null}
        <div
          className="rounded-xl bg-[var(--ad-red-bg)] p-5 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {error ??
            (loading
              ? t("Loading the authoritative Character workspace…")
              : t("Character not found"))}
          <button
            className="ml-2 font-semibold underline"
            onClick={() => void load().catch(() => undefined)}
            type="button"
          >
            {t("Retry workspace")}
          </button>
        </div>
      </section>
    );
  }
  const selectTab = (next: Tab) => {
    if (
      (mutationNoticeRef.current ||
        pendingCommandRef.current ||
        data.activeCommand) &&
      next !== tab
    )
      return;
    setTab(next);
    setWorkspaceUrl(new URLSearchParams({ tab: next }), {
      mode: "push",
    });
  };
  const onTabKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: number,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (mutationNotice || pendingCommand || data.activeCommand) return;
    const visibleTabs = characterWorkspaceTabs;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visibleTabs.length - 1
          : (current +
              (event.key === "ArrowRight" ? 1 : -1) +
              visibleTabs.length) %
            visibleTabs.length;
    const next = visibleTabs[nextIndex];
    selectTab(next);
    document.getElementById(`character-tab-${next}`)?.focus();
  };
  const workspaceName =
    data.preview.draft?.name ?? data.preview.live?.name ?? data.character.name;
  const workspaceImageUrl =
    data.preview.draft?.imageUrl ??
    data.preview.live?.imageUrl ??
    data.character.imageUrl;
  const visibleTabs = characterWorkspaceTabs;
  const writesLocked =
    mutationNotice !== null ||
    pendingCommand !== null ||
    data.activeCommand !== null;
  const guardedPermissions = {
    ...permissions,
    writeProject: permissions.writeProject && !writesLocked,
    proposeRelease: permissions.proposeRelease && !writesLocked,
    publishRelease: permissions.publishRelease && !writesLocked,
    reviewRelease: permissions.reviewRelease && !writesLocked,
    writeVisual: permissions.writeVisual && !writesLocked,
    evaluateRoute: permissions.evaluateRoute && !writesLocked,
    createAssets: permissions.createAssets && !writesLocked,
    reviewAssets: permissions.reviewAssets && !writesLocked,
  };
  return (
    <section aria-labelledby="character-workspace-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          {workspaceImageUrl ? (
            <Image
              alt={t("{name} primary role portrait", { name: workspaceName })}
              className="h-24 w-24 shrink-0 rounded-lg object-cover"
              height={96}
              loading="eager"
              src={workspaceImageUrl}
              unoptimized
              width={96}
            />
          ) : (
            <div className="grid h-24 w-24 shrink-0 place-items-center rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text-muted)]">
              <ImageIcon aria-hidden="true" className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2
                className="truncate text-2xl font-semibold"
                id="character-workspace-title"
              >
                {workspaceName}
              </h2>
              <p className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-2 w-2 rounded-full",
                    data.serving?.state === "live"
                      ? "bg-[var(--ad-green-text)]"
                      : "bg-[var(--ad-text-muted)]/45",
                  )}
                />
                {t(data.serving?.state ?? "not_live")}{" "}
                <span aria-hidden="true">·</span> {t(data.character.visibility)}
              </p>
            </div>
            <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
              {t("Updated")}{" "}
              {new Date(data.character.updatedAt).toLocaleDateString(
                adminDateLocale(locale),
              )}
            </p>
          </div>
        </div>
        <details className="text-xs text-[var(--ad-text-muted)] sm:text-right">
          <summary className="cursor-pointer py-2 font-semibold">
            {t("Technical status")}
          </summary>
          <p>
            {t("Project v")}
            {data.project.version} {t("· Serving v")}
            {data.serving?.version ?? 0}
          </p>
          <p className="mt-1 break-all">
            {t("Character ID")} · {data.character.id}
          </p>
          <p className="mt-1 break-all">
            {t("Project ID")} · {data.project.id}
          </p>
        </details>
      </div>
      {error ? (
        <p
          className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {error}{" "}
          <button
            className="ml-2 underline"
            onClick={() => void load().catch(() => undefined)}
            type="button"
          >
            {t("Retry workspace")}
          </button>
        </p>
      ) : null}
      {commandRecoveryError ? (
        <p
          className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
          role="alert"
        >
          {commandRecoveryError}
        </p>
      ) : null}
      {mutationNotice ? (
        <div
          className={cn(
            "mt-4 rounded-lg p-3 text-sm",
            [
              "command_pending",
              "command_submission_unknown",
              "mutation_in_flight",
            ].includes(mutationNotice.kind)
              ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
              : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
          )}
          role="status"
        >
          <p>{mutationNotice.message}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {mutationNotice.kind === "refresh_required" ? (
              <button
                className="font-semibold underline"
                onClick={() => void refreshAuthoritativeWorkspace()}
                type="button"
              >
                {t("Refresh authoritative workspace")}
              </button>
            ) : null}
            {mutationNotice.kind === "command_reconfirmation_required" &&
            pendingCommand ? (
              <button
                className="font-semibold underline"
                onClick={authorizePendingCommandReplay}
                type="button"
              >
                {t("Review and resume saved command")}
              </button>
            ) : null}
            {"commandId" in mutationNotice && mutationNotice.commandId ? (
              <Link
                className="font-semibold underline"
                href={`/admin/system/audit?commandId=${encodeURIComponent(mutationNotice.commandId)}`}
              >
                {t("Open command evidence")}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
      <CharacterMediaOperationsCard
        canReclaimVoice={
          guardedPermissions.writeProject && !writesLocked
        }
        onReclaimVoice={reclaimVoiceRequest}
        projection={data.mediaOperations}
        reclaimingVoiceRequestId={reclaimingVoiceRequestId}
      />
      <label className="mt-4 block sm:hidden">
        <span className="sr-only">{t("Workspace page")}</span>
        <select
          aria-label={t("Workspace page")}
          className={fieldClass}
          disabled={writesLocked}
          onChange={(event) => selectTab(event.target.value as Tab)}
          value={tab}
        >
          {visibleTabs.map((item) => (
            <option key={item} value={item}>
              {t(characterWorkspaceTabLabel(item))}
            </option>
          ))}
        </select>
      </label>
      <div
        className="mt-4 hidden gap-1 overflow-x-auto border-b border-[var(--ad-border)] sm:flex"
        role="tablist"
        aria-label={t("Character workspace")}
      >
        {visibleTabs.map((item, index) => (
          <button
            aria-controls={`character-panel-${item}`}
            aria-selected={tab === item}
            className={cn(
              "min-h-11 shrink-0 border-b-2 px-3 text-sm capitalize focus-visible:outline focus-visible:outline-2",
              tab === item
                ? "border-[var(--ad-ink)] font-semibold text-[var(--ad-ink)]"
                : "border-transparent text-[var(--ad-text-muted)]",
            )}
            disabled={writesLocked && item !== tab}
            id={`character-tab-${item}`}
            key={item}
            onClick={() => selectTab(item)}
            onKeyDown={(event) => onTabKey(event, index)}
            role="tab"
            tabIndex={tab === item ? 0 : -1}
            type="button"
          >
            {t(characterWorkspaceTabLabel(item))}
          </button>
        ))}
      </div>
      <div
        className="mt-5"
        id={`character-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`character-tab-${tab}`}
      >
        {tab === "project" ? (
          <ProjectEditor
            data={data}
            key={data.project.version}
            onReload={async () => {
              await loadAuthoritative();
            }}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "visual" ? (
          <VisualIdentityPanel
            data={data}
            key={data.visual.activeIdentity?.id ?? "visual-empty"}
            navigateToTab={selectTab}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "assets" ? (
          <div id="character-image-studio">
            <CharacterAssetStudio
              actorId={actorId}
              commitProjectMutation={runCommittedMutation}
              data={data}
              key={`${actorId}:${data.character.id}`}
              onContinue={selectTab}
              onProjectReload={load}
              permissions={{
                read: permissions.readAssets,
                create: guardedPermissions.createAssets,
                review: guardedPermissions.reviewAssets,
                selectDraft: guardedPermissions.writeProject,
              }}
            />
          </div>
        ) : tab === "video" ? (
          <CharacterVideoStudio
            actorId={actorId}
            data={data}
            onCreateImage={() => selectTab("assets")}
            permissions={{
              read: permissions.readAssets,
              create: guardedPermissions.createAssets,
              review: guardedPermissions.reviewAssets,
            }}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "voice" ? (
          <CharacterVoicePanel
            canActivate={guardedPermissions.publishRelease}
            canManageDefaults={permissions.manageVoiceDefaults}
            canWrite={guardedPermissions.writeProject}
            data={data}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "preview" ? (
          <PreviewDiff
            data={data}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "release" ? (
          <ReleasePanel
            abortCommandSubmission={abortCommandSubmission}
            beginCommandSubmission={beginCommandSubmission}
            data={data}
            discardPendingCommand={discardPendingCommand}
            getDurableCommandIdempotencyKey={getDurableCommandIdempotencyKey}
            mutationNotice={mutationNotice}
            pendingCommand={pendingCommand}
            permissions={guardedPermissions}
            rememberPendingCommand={rememberPendingCommand}
            runCommittedMutation={runCommittedMutation}
          />
        ) : (
          // SPEC: 「线上」= 表现证据 → 组合决策 → 发布护栏，自上而下就是运营复盘的顺序。
          <div className="space-y-5">
            <PerformancePanel
              data={data}
              permissions={guardedPermissions}
              runCommittedMutation={runCommittedMutation}
            />
            <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
              <summary className="cursor-pointer p-4 font-semibold">
                {t("Release monitoring")}
              </summary>
              <div className="border-t border-[var(--ad-border)] p-4">
                <MonitorPanel
                  data={data}
                  onOpenVisual={() => selectTab("visual")}
                  permissions={guardedPermissions}
                  runCommittedMutation={runCommittedMutation}
                />
              </div>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}

export function CharacterWorkspace({
  actorId,
  view,
  permissions,
}: {
  actorId: string;
  view: AdminSubview;
  permissions: Permissions;
}) {
  if (view.kind === "new") {
    return (
      <CharacterCreateWizard
        actorId={actorId}
        canCreate={permissions.writeProject}
        key={actorId}
      />
    );
  }
  return view.kind === "detail" ? (
    <CharacterDetail
      actorId={actorId}
      id={view.id}
      key={`${actorId}:${view.id}`}
      permissions={permissions}
    />
  ) : (
    <CharacterPortfolio
      canOpenAssets={permissions.readAssets}
      canCreate={permissions.writeProject}
      canOpenProjects={permissions.read}
      canRead={permissions.read}
      mode="studio"
    />
  );
}

export function CharacterPerformanceWorkspace({
  canOpenProjects,
  canRead,
}: {
  canOpenProjects: boolean;
  canRead: boolean;
}) {
  return (
    <CharacterPortfolio
      canOpenAssets={false}
      canCreate={false}
      canOpenProjects={canOpenProjects}
      canRead={canRead}
      mode="performance"
    />
  );
}
