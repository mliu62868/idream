"use client";

import { characterCommandMessage, renderCharacterCommandMessage } from "./character-command-copy";

import { useAdminI18n } from "@/components/admin/i18n";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import Link from "next/link";
import {
  type AdminPermissionKey,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { CharacterVideoLibrary } from "@/features/characters/CharacterVideoLibrary";
import { CharacterCreateWizard } from "@/features/characters/CharacterCreateWizard";
import { CharacterDuplicateReceipt } from "@/features/characters/CharacterDuplicateButton";
import { CharacterVoicePanel } from "@/features/characters/CharacterVoicePanel";
import { CharacterSoulPanel } from "@/features/characters/CharacterSoulPanel";
import { characterWorkspaceTabFromSearch } from "@/features/image-workflow-transport";
import { LoadingWorkspace } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  adminV2Operation,
  adminV2OperationAllowed,
} from "@/lib/admin-v2-operation";
import {
  usePollingTask,
  type PollDecision,
  type PollingTask,
} from "@/lib/authority-resource";
import { createLatestRequestGate, type LatestRequestToken } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { cn } from "@/lib/utils";
import { CharacterHandoffAction } from "./CharacterHandoff";
import { CharacterWorkspaceHeader } from "./CharacterWorkspaceHeader";
import { CharacterWorkspaceNav } from "./CharacterWorkspaceNav";
import { useCharacterWorkspaceTabRoute } from "./use-character-workspace-tab-route";
import { FeaturedAuthorityProvider } from "@/features/content-merchandising/CharacterFeaturedToggle";
import { CharacterWorkspaceActionsProvider } from "./character-workspace-actions";
import { characterWorkspacePermissions } from "./character-workspace-permissions";
import { permissionDenied } from "./character-permission-denied";
import { CharacterPortfolio } from "./CharacterPortfolio";
import { characterPrimaryActionCopy } from "./character-primary-action-copy";
import { CharacterOverview } from "./CharacterOverview";
import { CharacterContentSettings } from "./CharacterContentSettings";
import { VisualIdentityPanel } from "./VisualIdentityPanel";
import { PreviewDiff } from "./PreviewDiff";
import { CharacterImageLibrary } from "./CharacterImageLibrary";
import { CharacterPlacementEditor } from "./CharacterPlacementEditor";
import { ReleasePanel } from "./ReleasePanel";
import { MonitorPanel } from "./MonitorPanel";
import { characterMonitorNeedsAttention } from "./character-workspace-format";
import { PerformancePanel } from "./PerformancePanel";
import {
  CharacterMediaOperationsCard,
  shouldReleaseVoiceReclaimIdempotencyKey,
} from "./CharacterMediaOperationsCard";
import {
  committedCharacterProjectionWarning,
  createCharacterCommandJournal,
  type CharacterCommandRecoveryCopy,
} from "./character-command-journal";

export {
  CHARACTER_WORKSPACE_TABS,
  characterWorkspaceAreaForTab,
  characterWorkspaceAreaLabel,
  characterWorkspaceAreaTabs,
  characterWorkspaceTabLabel,
  type CharacterWorkspaceArea,
} from "./CharacterWorkspaceNav";

type CustomerPublicationPrepRecovery = {
  characterId: string;
  submissionId: string;
};

export function customerPublicationPrepRecoveryFromError(
  cause: unknown,
  characterId: string,
): CustomerPublicationPrepRecovery | null {
  if (
    !(cause instanceof AdminV2RequestError) ||
    cause.status !== 404 ||
    !cause.details ||
    typeof cause.details !== "object" ||
    Array.isArray(cause.details)
  )
    return null;
  const details = cause.details as Record<string, unknown>;
  return details.reason === "customer_publication_prep_missing" &&
    details.characterId === characterId &&
    typeof details.submissionId === "string" &&
    details.submissionId.length > 0 &&
    details.recoveryOperation === "POST /api/v2/admin/characters/:id/project"
    ? { characterId, submissionId: details.submissionId }
    : null;
}

// SPEC: 把 journal 给出的非受理处置翻译成操作员能读的一句话。
// INTENT: 处置本身（解锁 / 保持锁定 / 改挂到别的命令）已经由 journal 做完并生效了，
// 这里只负责措辞——所以三种出口的文案改错也改不动写入锁的行为。
function localCleanupWarning(cause: unknown) {
  return cause instanceof Error
    ? characterCommandMessage("The authoritative workspace refreshed, but local cleanup needs attention: {detail}", { detail: cause.message })
    : "The authoritative workspace refreshed, but local cleanup needs attention.";
}

export function characterWorkspaceLoadError(cause: unknown) {
  if (!(cause instanceof Error))
    return "Character workspace could not be loaded";
  return cause.message.startsWith("Validation failed")
    ? "This Character contains older operational evidence. Refresh and try the release again."
    : cause.message;
}

// INVARIANT: 不能先把 HTTP 异常压成 message，requestId、状态码与权威详情必须保留到渲染。
type CharacterWorkspaceError = string | AdminV2RequestError;

function CharacterWorkspaceErrorMessage({ error }: { error: CharacterWorkspaceError }) {
  const { t } = useAdminI18n();
  if (typeof error === "string") return t(error);
  const copy = operatorErrorCopy(error);
  return <>
    <p className="font-semibold">{t(copy.headline)}</p>
    <p className="mt-1">{t(copy.nextStep, copy.nextStepValues)}</p>
    <RequestErrorDetails technical={copy.technical} />
  </>;
}

/**
 * SPEC: 恢复回路每一种处置对应的一句运营文案。
 * INTENT: 处置本身（能不能重放、该不该解锁、等多久）全在 journal 里，所以这张表改错也改不动
 *         安全语义；反过来，任何一支漏了措辞都会立刻表现为"运营看不到发生了什么"。
 */
const characterCommandRecoveryCopy: CharacterCommandRecoveryCopy = {
  attached: ({ action }) =>
    characterCommandMessage("{action} is already active according to server authority. The workspace attached to that command instead of submitting a second one.", { action: action }),
  windowExpired: ({ action }) =>
    characterCommandMessage("{action} requires fresh operator confirmation before the saved request can be replayed.", { action: action }),
  evidenceIncomplete: ({ action }) =>
    characterCommandMessage("{action} recovery journal is incomplete. The authoritative workspace must be reconciled before writes resume.", { action: action }),
  replayBlocked: ({ action }) =>
    characterCommandMessage("{action} acceptance cannot be proven with the current session or permissions. The original command may already exist, so Character writes remain locked while the exact idempotent request waits to retry.", { action: action }),
  replayUnreconciled: ({ action }) =>
    characterCommandMessage("{action} replay was rejected, but the original acceptance is still unknown. Server-side Character authority must reconcile the active command before writes resume.", { action: action }),
  replayReconciled: ({ action, cause }) =>
    cause instanceof Error
      ? characterCommandMessage("{action} replay was rejected, and server-side Character authority confirmed that no active command remains: {detail}", { action: action, detail: cause.message })
      : characterCommandMessage("{action} replay was rejected, and server-side Character authority confirmed that no active command remains.", { action: action }),
  replayRetrying: ({ action, cause }) =>
    cause instanceof Error
      ? characterCommandMessage("{action} acceptance is still unknown: {detail}. Retrying the exact command safely.", { action: action, detail: cause.message })
      : characterCommandMessage("{action} acceptance is still unknown. Retrying the exact command safely.", { action: action }),
  commandFailed: ({ action, status }) =>
    characterCommandMessage("{action} command {status}. Open command evidence for the authoritative result.", { action: action, status: status }),
  evidenceMissingCleared: ({ action }) =>
    characterCommandMessage("{action} command evidence was unavailable, and server-side Character authority confirmed that no command remains active.", { action: action }),
  evidenceMissingLocked: ({ action }) =>
    characterCommandMessage("{action} command evidence is unavailable. Character writes remain locked until server authority can be reconciled.", { action: action }),
  statusBlocked: ({ action }) =>
    characterCommandMessage("{action} command evidence cannot be read with the current session or permissions. The command may still be running, so Character writes remain locked.", { action: action }),
  statusUnavailable: ({ action, cause }) =>
    cause instanceof Error
      ? characterCommandMessage("{action} status could not be refreshed: {detail}", { action: action, detail: cause.message })
      : characterCommandMessage("{action} status could not be refreshed.", { action: action }),
  reconcileNotice: ({ action, reason }) => {
    if (reason === "evidence_incomplete") {
      return characterCommandMessage("{action} recovery evidence is incomplete. Server authority must be reconciled before writes resume.", { action: action });
    }
    if (reason === "replay_rejected") {
      return characterCommandMessage("{action} replay was rejected after its original response was lost. Server-side Character authority must prove that no command remains active before writes resume.", { action: action });
    }
    if (reason === "evidence_missing") {
      return characterCommandMessage("{action} command evidence returned 404. Server-side Character authority must prove that no command remains active before writes resume.", { action: action });
    }
    return characterCommandMessage("{action} was completed or cleared in another tab. This tab must refresh server authority before writes resume.", { action: action });
  },
  reconcileStillActive: ({ action }) =>
    characterCommandMessage("{action} is still active according to server authority. Character writes remain locked.", { action: action }),
  reconcileFailed: ({ action, cause }) =>
    characterCommandMessage("{action} could not be reconciled with server authority{detail}. Character writes remain locked until the authoritative workspace refreshes.", { action, detail: cause instanceof Error ? `: ${cause.message}` : "" }),
};

function CharacterCommandNotice({
  actionsClassName,
  canResume,
  className,
  notice,
  onRefresh,
  onResume,
  refreshLabel,
}: {
  actionsClassName: string;
  canResume: boolean;
  className: string;
  notice: NonNullable<ReturnType<ReturnType<typeof createCharacterCommandJournal>["getSnapshot"]>["notice"]>;
  onRefresh: () => void;
  onResume: () => void;
  refreshLabel: "Retry" | "Refresh";
}) {
  const { t } = useAdminI18n();
  return (
    <div className={className} role="status">
      <p>{renderCharacterCommandMessage(notice.message, t)}</p>
      <div className={`${actionsClassName} flex flex-wrap gap-3`}>
        {notice.kind === "refresh_required" ? (
          <button className="font-semibold underline" onClick={onRefresh} type="button">
            {t(refreshLabel)}
          </button>
        ) : null}
        {notice.kind === "command_reconfirmation_required" && canResume ? (
          <button className="font-semibold underline" onClick={onResume} type="button">
            {t("Review and resume saved command")}
          </button>
        ) : null}
        {"commandId" in notice && notice.commandId ? (
          <Link
            className="font-semibold underline"
            href={`/admin/system/audit?commandId=${encodeURIComponent(notice.commandId)}`}
          >
            {t("Open command evidence")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function CharacterDetail({
  actorId,
  canCreateCharacters,
  id,
  permissions: granted,
}: {
  actorId: string;
  canCreateCharacters: boolean;
  id: string;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const permissions = useMemo(
    () => characterWorkspacePermissions(granted, false),
    [granted],
  );
  const { t } = useAdminI18n();
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CharacterWorkspaceError | null>(null);
  const [publicationPrepRecovery, setPublicationPrepRecovery] =
    useState<CustomerPublicationPrepRecovery | null>(null);
  const [pendingPublicationPrep, setCustomerPublicationPrepRecovery] =
    useState<CustomerPublicationPrepRecovery | null>(null);
  const [reclaimingVoiceRequestId, setReclaimingVoiceRequestId] = useState<
    string | null
  >(null);
  // SPEC: 待决命令与写入锁只有 journal 一份权威，组件通过订阅镜像它。
  // INTENT: 这两个事实此前同时存在于 2 个 useState、2 个 useRef 和 coordinator 内部共 5 份
  //         副本里，refs 的存在只是为了让异步回调读到当前值。订阅之后 5 份塌成 1 份，
  //         "忘了同步 ref" 这一整类 bug 不再可表达。
  const [journal] = useState(() =>
    createCharacterCommandJournal({ actorId, characterId: id }),
  );
  const {
    command: pendingCommand,
    notice: mutationNotice,
    recoveryError: commandRecoveryError,
    recoveryErrorCommandId,
    writesLocked: commandWritesLocked,
  } = useSyncExternalStore(
    journal.subscribe,
    journal.getSnapshot,
    journal.getSnapshot,
  );
  const requestGate = useRef(createLatestRequestGate());
  const latestLoad = useRef<{ token: LatestRequestToken; promise: Promise<CharacterWorkspaceDetail> } | null>(null);
  const {
    tab,
    locationHash,
    returnQuery,
    navigateToWorkspaceTab,
    selectTab,
    onWorkspaceLinkClick,
  } = useCharacterWorkspaceTabRoute({ id, data, journal });
  const load = useCallback(async () => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    setPublicationPrepRecovery(null);
    const pending: Promise<CharacterWorkspaceDetail> = (async () => {
      try {
        const next = await adminV2Operation("GET /api/v2/admin/characters/:id", {
          path: { id },
        });
        // A superseded authority read must follow the newer read, including the
        // projection returned to the journal; ignoring setData alone can unlock it
        // against an older activeCommand snapshot.
        if (!request.isCurrent() && latestLoad.current && latestLoad.current.token !== request) {
          return latestLoad.current.promise;
        }
        if (request.isCurrent()) setData(next);
        return next;
      } catch (cause) {
        if (!request.isCurrent() && latestLoad.current && latestLoad.current.token !== request) {
          return latestLoad.current.promise;
        }
        if (request.isCurrent()) {
          const recovery = customerPublicationPrepRecoveryFromError(cause, id);
          setPublicationPrepRecovery(recovery);
          setError(
            recovery
              ? null
              : cause instanceof AdminV2RequestError
                ? cause
                : characterWorkspaceLoadError(cause),
          );
        }
        throw cause;
      } finally {
        if (request.isCurrent()) setLoading(false);
      }
    })();
    latestLoad.current = { token: request, promise: pending };
    return pending;
  }, [id]);
  const preparePublicationWorkspace = useCallback(
    async (pending: CustomerPublicationPrepRecovery) => {
      setError(null);
      try {
        await adminV2Operation("POST /api/v2/admin/characters/:id/project", {
          path: { id },
          body: {
            submissionId: pending.submissionId,
            confirmation: `PREPARE PUBLICATION ${id}`,
          },
        });
      } catch (cause) {
        const failure =
          cause instanceof Error
            ? cause
            : new Error("Publication workspace could not be prepared");
        setError(failure.message);
        throw failure;
      }
      setCustomerPublicationPrepRecovery(null);
      navigateToWorkspaceTab("assets", { mode: "replace" });
      await load().catch(() => undefined);
    },
    [id, load, navigateToWorkspaceTab],
  );
  const loadAuthoritative = load;
  const reloadProject = useCallback(async () => { await load(); }, [load]);
  // SPEC: journal.refresh 的结果只有这一处翻译成界面状态；两个调用方只在「需要刷新时显示什么」上不同。
  // Returns whether the workspace now shows authority it can act on.
  const settleWorkspaceRefresh = useCallback(
    (
      result: Awaited<ReturnType<typeof journal.refresh>>,
      refreshRequired: (cause: unknown) => Parameters<typeof journal.setNotice>[0],
    ) => {
      if (result.status === "superseded") {
        return !("error" in result);
      }
      if (result.status === "failed") {
        setError(null);
        journal.setNotice(refreshRequired(result.error));
        return false;
      }
      // SPEC: kept_locked 说明服务端仍有命令在跑；journal 已把日志改挂到那一条上。
      if (result.status === "kept_locked") return true;
      setError(null);
      if (result.status === "cleanup_failed") {
        journal.setRecoveryError(localCleanupWarning(result.error));
      }
      return true;
    },
    [journal],
  );
  const refreshCommittedProjection = useCallback(
    async (action: string, commandId?: string, afterRefresh?: () => void) => {
      const result = await journal.refresh({
        load: loadAuthoritative,
        onUnlock: () => {
          journal.setNotice(null);
          afterRefresh?.();
        },
      });
      return settleWorkspaceRefresh(result, (cause) => ({
        kind: "refresh_required",
        message: committedCharacterProjectionWarning(action, cause),
        ...(commandId ? { commandId } : {}),
      }));
    },
    [journal, loadAuthoritative, settleWorkspaceRefresh],
  );
  const runCommittedMutation = useCallback(
    async <T,>(input: {
      readonly action: string;
      readonly commit: () => Promise<T>;
      readonly afterRefresh?: () => void;
    }) => {
      if (
        !journal.beginSubmission(
          "Saving your changes and updating the character. Please wait before making another change.",
        )
      ) {
        throw new Error(
          "Refresh the authoritative Character workspace before another write.",
        );
      }
      const generation = journal.getGeneration();
      let result: T;
      try {
        result = await input.commit();
      } catch (cause) {
        if (journal.isCurrentGeneration(generation)) journal.setNotice(null);
        throw cause;
      }
      const refreshed = await refreshCommittedProjection(
        input.action,
        undefined,
        input.afterRefresh,
      );
      return { result, refreshed };
    },
    [journal, refreshCommittedProjection],
  );
  const reclaimVoiceRequest = useCallback(
    async (input: {
      readonly requestId: string;
      readonly confirmation: string;
      readonly reason: string;
    }) => {
      const signature = `voice-clip-reclaim:${input.requestId}`;
      const idempotencyKey = journal.takeIdempotencyKey(signature);
      setReclaimingVoiceRequestId(input.requestId);
      setError(null);
      try {
        await runCommittedMutation({
          action: "Voice request reclaim",
          commit: () =>
            adminV2Operation(
              "POST /api/v2/admin/characters/:id/voice-clips/:requestId/commands/reclaim",
              {
                path: { id, requestId: input.requestId },
                replayIdempotencyKey: idempotencyKey,
                body: {
                  requestId: input.requestId,
                  confirmation: input.confirmation,
                  reason: input.reason,
                },
              },
            ),
        });
        journal.releaseIdempotencyKey(signature);
      } catch (cause) {
        if (shouldReleaseVoiceReclaimIdempotencyKey(cause)) {
          journal.releaseIdempotencyKey(signature);
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
    [id, journal, runCommittedMutation],
  );
  const refreshAuthoritativeWorkspace = useCallback(async () => {
    const current = journal.getSnapshot().notice;
    if (
      current?.kind === "mutation_in_flight" ||
      current?.kind === "command_pending" ||
      current?.kind === "command_submission_unknown" ||
      current?.kind === "command_reconfirmation_required"
    )
      return false;
    const result = await journal.refresh({
      load: loadAuthoritative,
      reusePendingCleanup: true,
    });
    return settleWorkspaceRefresh(result, (cause) => ({
      kind: "refresh_required",
      message:
        current?.kind === "refresh_required"
          ? current.message
          : committedCharacterProjectionWarning("Character mutation", cause),
      ...(current?.kind === "refresh_required" && current.commandId
        ? { commandId: current.commandId }
        : {}),
    }));
  }, [journal, loadAuthoritative, settleWorkspaceRefresh]);
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
    if (!permissions.read) return;
    // INTENT: Shell refresh must reload client-owned Character facts while
    // preserving the journal's lock for an unresolved write.
    const refresh = () => {
      if (journal.getSnapshot().notice) {
        void refreshAuthoritativeWorkspace();
      } else {
        void load().catch(() => undefined);
      }
    };
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
  }, [journal, load, permissions.read, refreshAuthoritativeWorkspace]);
  useEffect(() => {
    const restore = () => {
      if (!journal.restore()) return;
      navigateToWorkspaceTab("release", { mode: "replace" });
    };
    const timer = window.setTimeout(restore, 0);
    const onStorage = (event: StorageEvent) => {
      if (!journal.ownsStorageEvent(event)) return;
      if (event.newValue !== null) {
        restore();
        return;
      }
      const current = journal.getSnapshot().command;
      if (!current) return;
      void journal.reconcileAuthority({
        command: current,
        copy: characterCommandRecoveryCopy,
        reason: "cross_tab_cleared",
        load: loadAuthoritative,
        clearLoadError: () => setError(null),
      });
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [journal, loadAuthoritative, navigateToWorkspaceTab]);
  // INTENT: 与上面的日志恢复一样延后一个 tick 再切页签——effect 里同步 setState 会触发级联
  //          渲染（构建期 react-hooks/set-state-in-effect 会拦），而这里本来就是"服务端说还有
  //          命令在跑"的异步事实，不需要在同一次提交里生效。
  useEffect(() => {
    const active = data?.activeCommand;
    if (
      !active ||
      journal.getSnapshot().command?.commandId === active.commandId
    )
      return;
    const timer = window.setTimeout(() => {
      journal.attachAuthorityCommand(active);
      navigateToWorkspaceTab("release", { mode: "replace" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data?.activeCommand, journal, navigateToWorkspaceTab]);
  // SPEC: 待决命令的恢复循环。整轮推进归 journal —— 这里只把它给出的重试间隔交回调度器。
  // INVARIANT: cancelled 只在本轮开始前判一次，拿到 journal 的处置之后不再中途退出。
  //            journal 的每次状态推进（受理 / 挂到别的命令 / 标记终态）都会 publish 并触发
  //            重渲染，于是本轮任务当场被换掉、cancelled 立刻为 true——中途判一次就等于把
  //            刚拿到的终态丢掉，命令永远settle不了、写入锁永远解不开。防重放靠的是 journal
  //            自己的命令身份与代际校验，不是这个标志位。
  const recoverPendingCommand = useCallback<PollingTask>(
    async (context): Promise<PollDecision> => {
      if (!pendingCommand || context.cancelled) return null;
      const outcome = await journal.recover({
        command: pendingCommand,
        copy: characterCommandRecoveryCopy,
        load: loadAuthoritative,
        settle: ({ action, commandId, onSettled }) =>
          refreshCommittedProjection(action, commandId, onSettled),
        clearLoadError: () => setError(null),
      });
      return outcome.retryInMs;
    },
    [journal, loadAuthoritative, pendingCommand, refreshCommittedProjection],
  );
  usePollingTask(
    pendingCommand && !pendingCommand.terminal ? recoverPendingCommand : null,
    // INTENT: 首轮延迟必须在 effect 执行时才求值——它要拿 createdAt 和此刻的 Date.now()
    //         算差值，好让"刚提交就刷新页面"的场景等满命令的最短受理窗口再去查。
    () => (pendingCommand ? journal.initialRecoveryDelayMs(pendingCommand) : 0),
  );
  if (!permissions.read) return permissionDenied("character.project.read");
  if (loading && !data && !pendingCommand) {
    return <LoadingWorkspace label="Loading character workspace" />;
  }
  if (!data) {
    return (
      <section className="space-y-3">
        {mutationNotice ? (
          <CharacterCommandNotice
            actionsClassName="mt-3"
            canResume={Boolean(pendingCommand)}
            className="rounded-xl bg-[var(--ad-blue-bg)] p-4 text-sm text-[var(--ad-blue-text)]"
            notice={mutationNotice}
            onRefresh={() => void refreshAuthoritativeWorkspace()}
            onResume={() => journal.authorizeReplay()}
            refreshLabel="Retry"
          />
        ) : null}
        {commandRecoveryError ? (
          <p
            className="rounded-xl bg-[var(--ad-yellow-bg)] p-4 text-sm text-[var(--ad-yellow-text)]"
            role="alert"
          >
            {renderCharacterCommandMessage(commandRecoveryError, t)}
            {recoveryErrorCommandId ? (
              <Link className="ml-2 underline" href={`/admin/system/audit?commandId=${encodeURIComponent(recoveryErrorCommandId)}`}>
                {t("Open command evidence")}
              </Link>
            ) : null}
          </p>
        ) : null}
        {publicationPrepRecovery && permissions.writeProject ? (
          <div
            className="rounded-xl bg-[var(--ad-yellow-bg)] p-5 text-sm text-[var(--ad-yellow-text)]"
            role="status"
          >
            <p className="font-semibold">
              {t("Awaiting publication preparation")}
            </p>
            <p className="mt-2">
              {t(
                "Prepare this Character for publishing. Automatic checks run first; nothing is published yet.",
              )}
            </p>
            {error ? (
              <div className="mt-2" role="alert">
                <CharacterWorkspaceErrorMessage error={error} />
              </div>
            ) : null}
            <button
              className="mt-3 font-semibold underline"
              onClick={() => {
                setCustomerPublicationPrepRecovery(publicationPrepRecovery);
              }}
              type="button"
            >
              {t("Prepare publication workspace")}
            </button>
          </div>
        ) : (
          <div
            className="rounded-xl bg-[var(--ad-red-bg)] p-5 text-sm text-[var(--ad-red-text)]"
            role="alert"
          >
            {error ? <CharacterWorkspaceErrorMessage error={error} /> :
              (loading ? t("Loading characters…") : t("Character not found"))}
            <button
              className="ml-2 font-semibold underline"
              onClick={() => void load().catch(() => undefined)}
              type="button"
            >
              {t("Retry workspace")}
            </button>
          </div>
        )}
        {pendingPublicationPrep ? (
          <ConfirmDialog
            onClose={() => setCustomerPublicationPrepRecovery(null)}
            spec={{
              title: t("Prepare publication workspace"),
              summary: (
                <div className="space-y-2">
                  <p>
                    {t(
                      "This creates a private publishing workspace for the Character.",
                    )}
                  </p>
                  <p>
                    {t(
                      "It does not create or publish a Release and does not make the Character visible in Explore or Community.",
                    )}
                  </p>
                </div>
              ),
              // INTENT: 只建一个私有工作区，不发布、不改用户可见面，确认一次即可，不要求原因或手输口令。
              requireReason: false,
              submitLabel: t("Prepare publication workspace"),
              onSubmit: () =>
                preparePublicationWorkspace(pendingPublicationPrep),
            }}
          />
        ) : null}
      </section>
    );
  }
  const nextStep = data.journey.primaryAction;
  const nextStepCopy = characterPrimaryActionCopy[nextStep.code];
  const releaseShowsNextStep = tab === "release" && nextStep.code === "create_primary_portrait";
  const destination = new URL(nextStep.deepLink, "https://admin.invalid");
  const atNextStep =
    destination.pathname === "/admin/characters/" + encodeURIComponent(id) &&
    destination.searchParams.has("tab") &&
    characterWorkspaceTabFromSearch(destination.search) === tab &&
    (!destination.hash || destination.hash === locationHash);
  const writesLocked = commandWritesLocked || data.activeCommand !== null;
  const guardedPermissions = characterWorkspacePermissions(
    granted,
    writesLocked,
  );
  const detailSection = (
    <section
      aria-labelledby="character-workspace-title"
      onClickCapture={onWorkspaceLinkClick}
    >
      {returnQuery !== null ? (
        <Link className="mb-3 inline-flex min-h-8 items-center text-sm font-medium underline underline-offset-4" href={`/admin/characters${returnQuery ? `?${returnQuery}` : ""}`}>
          {t("Back to character results")}
        </Link>
      ) : null}
      <CharacterWorkspaceHeader
        canCreateCharacters={canCreateCharacters}
        data={data}
        guardedPermissions={guardedPermissions}
        id={id}
        journal={journal}
        onError={setError}
        onOpenRelease={() => selectTab("release")}
        permissions={permissions}
        runCommittedMutation={runCommittedMutation}
        tab={tab}
        writesLocked={writesLocked}
      />
      <CharacterDuplicateReceipt characterId={id} />
      {error ? (
        <div
          className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          <CharacterWorkspaceErrorMessage error={error} />{" "}
          <button
            className="ml-2 underline"
            onClick={() => void load().catch(() => undefined)}
            type="button"
          >
            {t("Retry workspace")}
          </button>
        </div>
      ) : null}
      {commandRecoveryError ? (
        <p
          className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
          role="alert"
        >
          {renderCharacterCommandMessage(commandRecoveryError, t)}
          {recoveryErrorCommandId ? (
            <Link className="ml-2 underline" href={`/admin/system/audit?commandId=${encodeURIComponent(recoveryErrorCommandId)}`}>
              {t("Open command evidence")}
            </Link>
          ) : null}
        </p>
      ) : null}
      {mutationNotice ? (
        <CharacterCommandNotice
          actionsClassName="mt-2"
          canResume={Boolean(pendingCommand)}
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
          notice={mutationNotice}
          onRefresh={() => void refreshAuthoritativeWorkspace()}
          onResume={() => journal.authorizeReplay()}
          refreshLabel="Refresh"
        />
      ) : null}
      {!releaseShowsNextStep && (!atNextStep || !nextStep.canReadTarget) ? (
        <div
          className="mt-4 flex flex-col gap-2 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          data-testid="character-next-step"
        >
          <p className="min-w-0">
            <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
              {t("Next step")}
            </span>
            <strong>{t(nextStepCopy.eyebrow)}</strong>{" "}
            <span className="text-[var(--ad-text-muted)]">{t(nextStepCopy.description)}</span>
          </p>
          {nextStep.canReadTarget ? (
            <Link
              className="min-h-8 shrink-0 text-xs font-semibold underline underline-offset-4"
              href={nextStep.deepLink}
            >
              {t(nextStepCopy.label)}
            </Link>
          ) : (
            <span className="shrink-0 text-xs font-semibold">{t(nextStepCopy.label)}</span>
          )}
        </div>
      ) : null}
      <CharacterWorkspaceNav
        keyboardLocked={Boolean(mutationNotice || pendingCommand || data.activeCommand)}
        onSelectTab={selectTab}
        tab={tab}
        writesLocked={writesLocked}
      />
      {/* SPEC: 交接是 creator 向运营交代「做完了」的一句话事实，从不阻塞发布、发布也不读它。
          只给能写项目但无发布权的账号按钮；有发布权的人只在发布页看到 CharacterHandoffNotice。
          INTENT: 选完最后一张展示图会自动跳到发布页；创作者在那里只有禁用的发布按钮，
          交接必须也在发布页出现，否则本职链路的唯一出口在落地页上消失。 */}
      {["project", "soul", "assets", "release"].includes(tab) &&
      permissions.writeProject &&
      !permissions.publishRelease ? (
        <CharacterHandoffAction
          canWrite={guardedPermissions.writeProject}
          data={data}
          runCommittedMutation={runCommittedMutation}
        />
      ) : null}
      <CharacterWorkspaceActionsProvider
        journal={journal}
        permissions={guardedPermissions}
        runCommittedMutation={runCommittedMutation}
        writesLocked={writesLocked}
      >
      <div
        className="mt-5 scroll-mt-24"
        id={`character-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`character-tab-${tab}`}
      >
        {tab === "project" ? (
          <CharacterOverview data={data} />
        ) : tab === "soul" ? (
          <div className="space-y-5">
            <CharacterSoulPanel
              actorId={actorId}
              canWrite={guardedPermissions.writeProject}
              data={data}
              key={data.soul.current.contentVersionId}
              runCommittedMutation={runCommittedMutation}
            />
            <CharacterContentSettings
              canManageChatTools={guardedPermissions.manageChatTools}
              canReadContent={permissions.readContent}
              canWriteTags={guardedPermissions.writeTags}
              characterId={data.character.id}
            />
          </div>
        ) : tab === "visual" ? (
          <VisualIdentityPanel
            actorId={actorId}
            data={data}
            locationHash={locationHash}
            navigateToTab={selectTab}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "assets" ? (
          <div id="character-image-studio">
            <CharacterImageLibrary
              actorId={actorId}
              canPublish={guardedPermissions.publishRelease}
              canArchive={guardedPermissions.archiveAssets}
              canCreate={guardedPermissions.createAssets && guardedPermissions.writeProject}
              canRead={permissions.readImages}
              canReadProduction={permissions.readProduction}
              commitProjectMutation={runCommittedMutation}
              data={data}
              placements={
                <CharacterPlacementEditor
                  actorId={actorId}
                  canRead={permissions.readImages}
                  canWrite={guardedPermissions.writeProject}
                  data={data}
                  runCommittedMutation={runCommittedMutation}
                />
              }
              onContinue={(next) => {
                selectTab(next);
                if (next === "release") {
                  document.getElementById("character-workspace-title")?.scrollIntoView({ block: "center" });
                  window.requestAnimationFrame(() => {
                    document.getElementById("character-tab-release")?.focus({ preventScroll: true });
                  });
                }
              }}
              onProjectReload={reloadProject}
            />
          </div>
        ) : tab === "video" ? (
          <CharacterVideoLibrary
            actorId={actorId}
            canPublish={guardedPermissions.publishRelease}
            canArchive={guardedPermissions.archiveAssets}
            canCreate={guardedPermissions.createAssets}
            canImport={
              guardedPermissions.createAssets && guardedPermissions.writeProject
            }
            canRead={permissions.readVideos}
            canReadProduction={permissions.readProduction}
            data={data}
            onCreateImage={() => selectTab("assets")}
            onProjectReload={reloadProject}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "voice" ? (
          <CharacterVoicePanel
            canActivate={guardedPermissions.publishRelease}
            canPreview={permissions.previewVoice}
            canWrite={guardedPermissions.writeProject}
            data={data}
            releaseIdempotencyKey={journal.releaseIdempotencyKey}
            bindVoiceProfile={journal.bindVoiceProfile}
            releaseVoiceProfileKeys={journal.releaseVoiceProfileKeys}
            runCommittedMutation={runCommittedMutation}
            takeIdempotencyKey={journal.takeIdempotencyKey}
          />
        ) : tab === "release" ? (
          <div className="space-y-5">
            <ReleasePanel
              data={data}
              journal={journal}
              permissions={guardedPermissions}
              runCommittedMutation={runCommittedMutation}
              writesLocked={writesLocked}
            />
            <PreviewDiff data={data} />
          </div>
        ) : (
          // SPEC: 「线上」= 表现证据 → 组合决策 → 发布护栏，自上而下就是运营复盘的顺序。
          <div className="space-y-5">
            {/* SPEC: 「发布健康」只回答线上 Release 技术上是否在正常服务（keep / rollback_review…）；
                「经营表现与建议」回答顾客反应与曝光取舍（promote / pause / retire）。两套词表各管一事，
                标题必须让运营一眼分清，免得把两边的建议读成互相矛盾。 */}
            <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" open={characterMonitorNeedsAttention(data)}>
              <summary className="cursor-pointer p-4">
                <span className="font-semibold">{t("Release health")}</span>
                <span className="mt-0.5 block text-xs text-[var(--ad-text-muted)]">
                  {t("Whether the live release is serving correctly. Its suggestions concern the release itself.")}
                </span>
              </summary>
              <div className="border-t border-[var(--ad-border)] p-4">
                <MonitorPanel
                  data={data}
                  onOpenRelease={() => selectTab("release")}
                  onOpenVisual={() => selectTab("visual", "#route-qualification-workbench")}
                  permissions={guardedPermissions}
                  runCommittedMutation={runCommittedMutation}
                />
              </div>
            </details>
            <PerformancePanel data={data} />
          </div>
        )}
      </div>
      </CharacterWorkspaceActionsProvider>
      <CharacterMediaOperationsCard
        canReclaimVoice={guardedPermissions.writeProject}
        onReclaimVoice={reclaimVoiceRequest}
        projection={data.mediaOperations}
        reclaimingVoiceRequestId={reclaimingVoiceRequestId}
      />
    </section>
  );
  return permissions.readContent ? (
    <FeaturedAuthorityProvider>{detailSection}</FeaturedAuthorityProvider>
  ) : detailSection;
}

export function CharacterWorkspace({
  actorId,
  canCreateCharacters = false,
  view,
  permissions: granted,
}: {
  actorId: string;
  canCreateCharacters?: boolean;
  view: AdminSubview;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const permissions = characterWorkspacePermissions(granted, false);
  if (view.kind === "new") {
    return (
      <CharacterCreateWizard
        actorId={actorId}
        canCreate={canCreateCharacters && permissions.writeProject}
        canResumeDraft={permissions.writeProject}
        canTag={granted.has("content.tag.write") && granted.has("content.read")}
        key={actorId}
      />
    );
  }
  return view.kind === "detail" ? (
    <CharacterDetail
      actorId={actorId}
      canCreateCharacters={canCreateCharacters}
      id={view.id}
      key={`${actorId}:${view.id}`}
      permissions={granted}
    />
  ) : (
    <CharacterPortfolio
      actorId={actorId} permissions={granted} canReadUnprepared={permissions.readContent}
      canOpenAssets={permissions.readImages}
      canCreate={canCreateCharacters && permissions.writeProject}
      canOpenProjects={permissions.read}
      canRead={permissions.read}
      mode="studio"
    />
  );
}

export function CharacterPerformanceWorkspace({
  permissions,
}: {
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  // SPEC: 草稿主图的可见性跟着「能不能看素材」这个权限走，不跟着看的是哪个页面走。
  // INTENT: 这里曾经硬编码 false，于是 CharacterPortfolioVisual 的
  //         `canOpenAssets || primaryImageSource !== "draft"` 恒假，主图来源为 draft 的角色
  //         在「角色表现」里一律显示灰色占位——同一个角色在「角色」里却有图。同一个标志还
  //         压着 canOpenNextAction，requiresAssets 的下一步动作被降级成「仅表现数据」。
  //         与图片库使用相同的 operation 权限，避免把不完整的授权当成可用入口。
  return (
    <CharacterPortfolio
      canOpenAssets={adminV2OperationAllowed(
        "GET /api/v2/admin/characters/:id/image-sources",
        permissions,
      )}
      canCreate={false}
      canOpenProjects={adminV2OperationAllowed(
        "GET /api/v2/admin/characters/:id",
        permissions,
      )}
      canRead={permissions.has("character.performance.read")}
      mode="performance" permissions={permissions}
    />
  );
}
