"use client";

import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import Link from "next/link";
import Image from "next/image";
import {
  type AdminPermissionKey,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { ImageIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { CharacterAssetStudio } from "@/features/characters/CharacterAssetStudio";
import { CharacterVideoStudio } from "@/features/characters/CharacterVideoStudio";
import { CharacterCreateWizard } from "@/features/characters/CharacterCreateWizard";
import { CharacterVoicePanel } from "@/features/characters/CharacterVoicePanel";
import { CharacterSoulPanel } from "@/features/characters/CharacterSoulPanel";
import {
  characterWorkspaceTabFromSearch,
  characterWorkspaceTabs,
  type CharacterWorkspaceTab,
} from "@/features/image-workflow-transport";
import { LoadingWorkspace, fieldClass } from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError, setWorkspaceUrl } from "@/lib/admin-v2-api";
import {
  adminV2Operation,
  adminV2OperationAllowed,
} from "@/lib/admin-v2-operation";
import {
  usePollingTask,
  type PollDecision,
  type PollingTask,
} from "@/lib/authority-resource";
import { createLatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";
import { characterWorkspacePermissions } from "./character-workspace-permissions";
import { permissionDenied } from "./character-permission-denied";
import { CharacterJourneyRail } from "./CharacterJourneyRail";
import { CharacterPortfolio } from "./CharacterPortfolio";
import { ProjectEditor } from "./ProjectEditor";
import { VisualIdentityPanel } from "./VisualIdentityPanel";
import { PreviewDiff } from "./PreviewDiff";
import { ReleasePanel } from "./ReleasePanel";
import { MonitorPanel } from "./MonitorPanel";
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

type Tab = CharacterWorkspaceTab;

const characterWorkspaceTabLabels: Record<Tab, string> = {
  project: "Details",
  soul: "Soul",
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

type CustomerPublicationPrepRecovery = {
  characterId: string;
  submissionId: string;
};

type PendingPublicationPrep = CustomerPublicationPrepRecovery & {
  idempotencyKey: string;
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
  ) return null;
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
    ? `The authoritative workspace refreshed, but local cleanup needs attention: ${cause.message}`
    : "The authoritative workspace refreshed, but local cleanup needs attention.";
}

/**
 * SPEC: 恢复回路每一种处置对应的一句运营文案。
 * INTENT: 处置本身（能不能重放、该不该解锁、等多久）全在 journal 里，所以这张表改错也改不动
 *         安全语义；反过来，任何一支漏了措辞都会立刻表现为"运营看不到发生了什么"。
 */
const characterCommandRecoveryCopy: CharacterCommandRecoveryCopy = {
  attached: ({ action }) =>
    `${action} is already active according to server authority. The workspace attached to that command instead of submitting a second one.`,
  windowExpired: ({ action }) =>
    `${action} requires fresh operator confirmation before the saved request can be replayed.`,
  evidenceIncomplete: ({ action }) =>
    `${action} recovery journal is incomplete. The authoritative workspace must be reconciled before writes resume.`,
  replayBlocked: ({ action }) =>
    `${action} acceptance cannot be proven with the current session or permissions. The original command may already exist, so Character writes remain locked while the exact idempotent request waits to retry.`,
  replayUnreconciled: ({ action }) =>
    `${action} replay was rejected, but the original acceptance is still unknown. Server-side Character authority must reconcile the active command before writes resume.`,
  replayReconciled: ({ action, cause }) =>
    cause instanceof Error
      ? `${action} replay was rejected, and server-side Character authority confirmed that no active command remains: ${cause.message}`
      : `${action} replay was rejected, and server-side Character authority confirmed that no active command remains.`,
  replayRetrying: ({ action, cause }) =>
    cause instanceof Error
      ? `${action} acceptance is still unknown: ${cause.message}. Retrying the exact command safely.`
      : `${action} acceptance is still unknown. Retrying the exact command safely.`,
  commandFailed: ({ action, status }) =>
    `${action} command ${status}. Open command evidence for the authoritative result.`,
  evidenceMissingCleared: ({ action }) =>
    `${action} command evidence was unavailable, and server-side Character authority confirmed that no command remains active.`,
  evidenceMissingLocked: ({ action }) =>
    `${action} command evidence is unavailable. Character writes remain locked until server authority can be reconciled.`,
  statusBlocked: ({ action }) =>
    `${action} command evidence cannot be read with the current session or permissions. The command may still be running, so Character writes remain locked.`,
  statusUnavailable: ({ action, cause }) =>
    cause instanceof Error
      ? `${action} status could not be refreshed: ${cause.message}`
      : `${action} status could not be refreshed.`,
  reconcileNotice: ({ action, reason }) => {
    if (reason === "evidence_incomplete") {
      return `${action} recovery evidence is incomplete. Server authority must be reconciled before writes resume.`;
    }
    if (reason === "replay_rejected") {
      return `${action} replay was rejected after its original response was lost. Server-side Character authority must prove that no command remains active before writes resume.`;
    }
    if (reason === "evidence_missing") {
      return `${action} command evidence returned 404. Server-side Character authority must prove that no command remains active before writes resume.`;
    }
    return `${action} was completed or cleared in another tab. This tab must refresh server authority before writes resume.`;
  },
  reconcileStillActive: ({ action }) =>
    `${action} is still active according to server authority. Character writes remain locked.`,
  reconcileFailed: ({ action, cause }) =>
    committedCharacterProjectionWarning(`${action} command reconciliation`, cause),
};

function CharacterDetail({
  actorId,
  id,
  permissions: granted,
}: {
  actorId: string;
  id: string;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const permissions = useMemo(
    () => characterWorkspacePermissions(granted, false),
    [granted],
  );
  const { locale, t } = useAdminI18n();
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publicationPrepRecovery, setPublicationPrepRecovery] = useState<CustomerPublicationPrepRecovery | null>(null);
  const [pendingPublicationPrep, setPendingPublicationPrep] = useState<PendingPublicationPrep | null>(null);
  const publicationPrepIdempotencyKey = useRef<string | null>(null);
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
    writesLocked: commandWritesLocked,
  } = useSyncExternalStore(
    journal.subscribe,
    journal.getSnapshot,
    journal.getSnapshot,
  );
  const requestGate = useRef(createLatestRequestGate());
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "project";
    if (journal.hasPersistedCommand()) return "release";
    return characterWorkspaceTabFromSearch(window.location.search);
  });
  const tabRef = useRef(tab);
  const load = useCallback(async () => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    setPublicationPrepRecovery(null);
    try {
      const next = await adminV2Operation("GET /api/v2/admin/characters/:id", {
        path: { id },
      });
      if (request.isCurrent()) setData(next);
    } catch (cause) {
      if (request.isCurrent()) {
        const recovery = customerPublicationPrepRecoveryFromError(cause, id);
        setPublicationPrepRecovery(recovery);
        setError(recovery
          ? null
          : cause instanceof Error
            ? cause.message
            : "Character workspace could not be loaded");
      }
      throw cause;
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [id]);
  const preparePublicationWorkspace = useCallback(async (
    pending: PendingPublicationPrep,
    reason: string,
  ) => {
    setError(null);
    try {
      await adminV2Operation("POST /api/v2/admin/characters/:id/project", {
        path: { id },
        idempotencyKey: pending.idempotencyKey,
        body: {
          submissionId: pending.submissionId,
          reason,
          confirmation: `PREPARE PUBLICATION ${id}`,
        },
      });
    } catch (cause) {
      const failure = cause instanceof Error
        ? cause
        : new Error("Publication workspace could not be prepared");
      setError(failure.message);
      throw failure;
    }
    publicationPrepIdempotencyKey.current = null;
    setPendingPublicationPrep(null);
    setTab("assets");
    setWorkspaceUrl(new URLSearchParams({ tab: "assets" }), {
      mode: "replace",
    });
    await load().catch(() => undefined);
  }, [id, load]);
  const loadAuthoritative = useCallback(async () => {
    requestGate.current.invalidate();
    setLoading(true);
    setError(null);
    try {
      const next = await adminV2Operation("GET /api/v2/admin/characters/:id", {
        path: { id },
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
  const refreshCommittedProjection = useCallback(
    async (action: string, commandId?: string, afterRefresh?: () => void) => {
      const result = await journal.refresh({
        load: loadAuthoritative,
        onUnlock: () => {
          journal.setNotice(null);
          afterRefresh?.();
        },
      });
      if (result.status === "superseded") {
        return !("error" in result);
      }
      if (result.status === "failed") {
        setError(null);
        journal.setNotice({
          kind: "refresh_required",
          message: committedCharacterProjectionWarning(action, result.error),
          ...(commandId ? { commandId } : {}),
        });
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
    [journal, loadAuthoritative],
  );
  const runCommittedMutation = useCallback(
    async <T,>(input: {
      readonly action: string;
      readonly commit: () => Promise<T>;
      readonly afterRefresh?: () => void;
    }) => {
      if (
        !journal.beginSubmission(
          `${input.action} is being committed. Character writes stay locked until the authoritative workspace refreshes.`,
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
                idempotencyKey,
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
      current?.kind === "command_pending" ||
      current?.kind === "command_submission_unknown" ||
      current?.kind === "command_reconfirmation_required"
    )
      return false;
    const result = await journal.refresh({
      load: loadAuthoritative,
      reusePendingCleanup: true,
    });
    if (result.status === "superseded") {
      return !("error" in result);
    }
    if (result.status === "failed") {
      setError(null);
      journal.setNotice({
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
    if (result.status === "kept_locked") return true;
    setError(null);
    if (result.status === "cleanup_failed") {
      journal.setRecoveryError(localCleanupWarning(result.error));
    }
    return true;
  }, [journal, loadAuthoritative]);
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
      if (!journal.restore()) return;
      setTab("release");
      setWorkspaceUrl(new URLSearchParams({ tab: "release" }), {
        mode: "replace",
      });
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
  }, [journal, loadAuthoritative]);
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
      setTab("release");
      setWorkspaceUrl(new URLSearchParams({ tab: "release" }), {
        mode: "replace",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data?.activeCommand, journal]);
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
      if (journal.getSnapshot().writesLocked || data?.activeCommand) {
        setWorkspaceUrl(new URLSearchParams({ tab: tabRef.current }), {
          mode: "replace",
        });
        return;
      }
      setTab(characterWorkspaceTabFromSearch(window.location.search));
    };
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, [data?.activeCommand, id, journal]);
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
                  {t("Retry")}
                </button>
              ) : null}
              {mutationNotice.kind === "command_reconfirmation_required" &&
              pendingCommand ? (
                <button
                  className="font-semibold underline"
                  onClick={() => journal.authorizeReplay()}
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
        {publicationPrepRecovery && permissions.writeProject ? (
          <div
            className="rounded-xl bg-[var(--ad-yellow-bg)] p-5 text-sm text-[var(--ad-yellow-text)]"
            role="status"
          >
            <p className="font-semibold">{t("Approved · awaiting publication preparation")}</p>
            <p className="mt-2">
              {t("Prepare the Project, immutable Revision, and inactive Serving workspace. This does not publish a Release or make the Character public.")}
            </p>
            {error ? <p className="mt-2" role="alert">{error}</p> : null}
            <button
              className="mt-3 font-semibold underline"
              onClick={() => {
                publicationPrepIdempotencyKey.current ??= crypto.randomUUID();
                setPendingPublicationPrep({
                  ...publicationPrepRecovery,
                  idempotencyKey: publicationPrepIdempotencyKey.current,
                });
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
            {error ??
              (loading
                ? t("Loading characters…")
                : t("Character not found"))}
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
            onClose={() => setPendingPublicationPrep(null)}
            spec={{
              title: t("Prepare publication workspace"),
              summary: (
                <div className="space-y-2">
                  <p>
                    {t("This creates the Character Project, immutable Revision, and inactive Serving workspace.")}
                  </p>
                  <p>
                    {t("It does not create or publish a Release and does not make the Character visible in Explore or Community.")}
                  </p>
                </div>
              ),
              destructive: {
                expectedName: `PREPARE PUBLICATION ${id}`,
                inputLabel: t("Type the publication preparation confirmation"),
              },
              reasonLabel: t("Operational reason (≥3)"),
              submitLabel: t("Prepare publication workspace"),
              onSubmit: (reason) => preparePublicationWorkspace(
                pendingPublicationPrep,
                reason,
              ),
            }}
          />
        ) : null}
      </section>
    );
  }
  const selectTab = (next: Tab) => {
    if (
      (journal.getSnapshot().writesLocked || data.activeCommand) &&
      next !== tab
    )
      return;
    setTab(next);
    setWorkspaceUrl(new URLSearchParams({ tab: next }), {
      mode: "push",
    });
  };
  // SPEC: 把服务端 journey 深链（/admin/characters/:id?tab=x#anchor）落到同页导航。
  // INTENT: tab 是 React state，next/link 跳同一条路由只会改地址栏、不换面板；而整页
  //         跳转会丢掉正在恢复的命令上下文。所以这里手工解析后走 selectTab + 滚锚点。
  const openDeepLink = (deepLink: string) => {
    const target = new URL(deepLink, window.location.origin);
    const nextTab = characterWorkspaceTabFromSearch(target.search);
    selectTab(nextTab);
    const anchor = target.hash.slice(1);
    if (!anchor) return;
    window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "start" });
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
  const writesLocked = commandWritesLocked || data.activeCommand !== null;
  const guardedPermissions = characterWorkspacePermissions(granted, writesLocked);
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
                {t("Refresh")}
              </button>
            ) : null}
            {mutationNotice.kind === "command_reconfirmation_required" &&
            pendingCommand ? (
              <button
                className="font-semibold underline"
                onClick={() => journal.authorizeReplay()}
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
      <CharacterJourneyRail journey={data.journey} onOpenDeepLink={openDeepLink} />
      <CharacterMediaOperationsCard
        canReclaimVoice={guardedPermissions.writeProject}
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
        ) : tab === "soul" ? (
          <CharacterSoulPanel
            canWrite={guardedPermissions.writeProject}
            data={data}
            key={data.soul.current.contentVersionId}
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
            canManageDefaults={guardedPermissions.manageVoiceDefaults}
            canWrite={guardedPermissions.writeProject}
            data={data}
            releaseIdempotencyKey={journal.releaseIdempotencyKey}
            runCommittedMutation={runCommittedMutation}
            takeIdempotencyKey={journal.takeIdempotencyKey}
          />
        ) : tab === "preview" ? (
          <PreviewDiff
            data={data}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "release" ? (
          <ReleasePanel
            data={data}
            journal={journal}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
            writesLocked={writesLocked}
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
  permissions: granted,
}: {
  actorId: string;
  view: AdminSubview;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const permissions = characterWorkspacePermissions(granted, false);
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
      permissions={granted}
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
  permissions,
}: {
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  return (
    <CharacterPortfolio
      canOpenAssets={false}
      canCreate={false}
      canOpenProjects={adminV2OperationAllowed(
        "GET /api/v2/admin/characters/:id",
        permissions,
      )}
      canRead={permissions.has("character.performance.read")}
      mode="performance"
    />
  );
}
