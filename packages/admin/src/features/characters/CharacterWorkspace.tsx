"use client";

import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import {
  adminCommandAcceptedSchema,
  adminCommandStatusSchema,
  characterQaAuthorityMatches,
  latestCharacterQaAuthorityRun,
  characterLookArchiveResponseSchema,
  characterReferenceSetPublishResponseSchema,
  generationRouteQualificationEvaluateResponseSchema,
  characterPortfolioResponseSchema,
  characterWorkspaceDetailSchema,
  type AdminCommandStatus,
  type CharacterPortfolioItem,
  type CharacterQaCheckInput,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { ArrowLeft, Clock3, ImageIcon, Plus, RefreshCcw, Rocket, RotateCcw, Save, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import {
  CharacterAssetStudio,
  characterAssetReadinessAction,
} from "@/features/characters/CharacterAssetStudio";
import { CharacterCreateWizard } from "@/features/characters/CharacterCreateWizard";
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
import { AdminV2RequestError, adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
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
};

type ProjectDraft = Pick<CharacterWorkspaceDetail["project"],
  "ownerId" | "audience" | "companionNeed" | "hypothesis" | "differentiation" |
  "targetPlacementKeys" | "successCriteria" | "productionPackage" | "qaPlan" | "plannedLaunchAt">;

type Tab = CharacterWorkspaceTab;

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

type CharacterCommandStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION = 1;
const UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS = 5 * 60_000;

function isSamePendingCharacterCommand(
  left: PendingCharacterCommand,
  right: PendingCharacterCommand,
) {
  if (left.commandId !== null || right.commandId !== null) {
    return left.commandId !== null && left.commandId === right.commandId;
  }
  return left.signature === right.signature &&
    left.idempotencyKey === right.idempotencyKey;
}

type CharacterMutationRefreshResult<T> =
  | { readonly status: "superseded"; readonly projection?: T; readonly error?: unknown }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "kept_locked"; readonly projection: T }
  | { readonly status: "cleanup_failed"; readonly projection: T; readonly error: unknown }
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
      if (!journal || !isSamePendingCharacterCommand(journal, command)) return false;
      advanceGeneration();
      journal = null;
      notice = null;
      return true;
    },
    currentCommandIs(command: PendingCharacterCommand) {
      return journal !== null && isSamePendingCharacterCommand(journal, command);
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
      const cleanup = pendingCleanup?.generation === refreshGeneration
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

export function pendingCommandStorageKey(
  actorId: string,
  characterId: string,
) {
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
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
  const storageKey = commandIdempotencyStorageKey(
    actorId,
    characterId,
  );
  const identities = readStoredStringRecord(storage, storageKey);
  const existing = identities[signature];
  if (existing) return existing;
  const created = createKey();
  try {
    storage.setItem(storageKey, JSON.stringify({
      ...identities,
      [signature]: created,
    }));
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
  const storageKey = commandIdempotencyStorageKey(
    actorId,
    characterId,
  );
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.schemaVersion !== CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION ||
      record.actorId !== actorId ||
      record.environment !== environment
    ) return null;
    if (
      !(record.commandId === null || typeof record.commandId === "string") ||
      typeof record.action !== "string" ||
      typeof record.signature !== "string" ||
      typeof record.createdAt !== "number" ||
      !Number.isFinite(record.createdAt) ||
      record.createdAt <= 0
    ) return null;
    if (
      Object.hasOwn(record, "autoReplayUntil") &&
      (
        typeof record.autoReplayUntil !== "number" ||
        !Number.isFinite(record.autoReplayUntil)
      )
    ) return null;
    if (
      record.commandId === null &&
      (
        typeof record.endpoint !== "string" ||
        typeof record.idempotencyKey !== "string" ||
        !Object.hasOwn(record, "body")
      )
    ) return null;
    return {
      commandId: record.commandId,
      action: record.action,
      signature: record.signature,
      ...(typeof record.endpoint === "string" ? { endpoint: record.endpoint } : {}),
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
    const raw = storage.getItem(
      pendingCommandStorageKey(actorId, characterId),
    );
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
        autoReplayUntil: command.autoReplayUntil
          ?? command.createdAt + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS,
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
    const raw = storage.getItem(
      pendingCommandStorageKey(actorId, characterId),
    );
    if (raw) {
      const stored = parsePendingCharacterCommandJournal(
        raw,
        actorId,
        browserCommandEnvironment(),
      );
      if (stored && !isSamePendingCharacterCommand(stored, command)) return false;
    }
    storage.removeItem(
      pendingCommandStorageKey(actorId, characterId),
    );
    return true;
  } catch {
    // Terminal state is authoritative even when browser storage is unavailable.
    return true;
  }
}

function isDefinitiveCommandRejection(cause: unknown) {
  return cause instanceof AdminV2RequestError &&
    [400, 401, 403, 404, 409, 422].includes(cause.status);
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
  if (!(cause instanceof AdminV2RequestError) || cause.status !== 409) return null;
  if (!cause.details || typeof cause.details !== "object" || Array.isArray(cause.details)) {
    return null;
  }
  const details = cause.details as Record<string, unknown>;
  if (typeof details.activeCommandId !== "string") return null;
  return {
    commandId: details.activeCommandId,
    commandType: typeof details.activeCommandType === "string"
      ? details.activeCommandType
      : "character.command",
  };
}

export function characterCommandJournalCanAutoReplay(
  command: Pick<PendingCharacterCommand, "commandId" | "createdAt" | "autoReplayUntil">,
  now = Date.now(),
) {
  if (command.commandId) return true;
  return now <= (
    command.autoReplayUntil
    ?? command.createdAt + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS
  );
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
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

export function characterMonitorWindows(
  monitors: ReadonlyArray<{ readonly window: string }>,
) {
  return [...new Set([
    "route_qualification",
    "24h",
    "72h",
    ...monitors.map((monitor) => monitor.window),
  ])];
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

export function committedCharacterProjectionWarning(action: string, cause: unknown) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return `${action} was committed, but the authoritative Character workspace could not be refreshed${detail}. Refresh the authoritative workspace before another write.`;
}

function permissionDenied(label: string) {
  return (
    <section aria-labelledby="permission-title" className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8">
      <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
      <h2 className="mt-4 text-lg font-semibold" id="permission-title"><AdminText text="No permission" /></h2>
      <p className="mt-2 text-sm text-[var(--ad-text-muted)]"><AdminText text="Your effective grants do not include" /> {label}<AdminText text=". Ask an administrator for the matching scoped permission." /></p>
    </section>
  );
}

export function CharacterPortfolioVisual({
  canOpenAssets,
  name,
  visualProduction,
}: {
  canOpenAssets: boolean;
  name: string;
  visualProduction: CharacterPortfolioItem["visualProduction"];
}) {
  const { t } = useAdminI18n();
  const draftCount = visualProduction.draftPurposes.length;
  const liveCount = visualProduction.livePurposes.length;
  const canRenderPrimaryImage =
    visualProduction.primaryImageUrl !== null &&
    (canOpenAssets || visualProduction.primaryImageSource !== "draft");
  const content = (
    <>
      <div className="relative h-20 w-20 overflow-hidden rounded-lg bg-black/[0.04]">
        {canRenderPrimaryImage ? (
          <Image
            alt={t("{name} primary role portrait", { name })}
            className="h-full w-full object-cover"
            height={80}
            src={visualProduction.primaryImageUrl as string}
            unoptimized
            width={80}
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-[var(--ad-text-muted)]">
            <ImageIcon aria-hidden="true" className="h-5 w-5" />
            <span className="sr-only">{t("No primary role portrait")}</span>
          </div>
        )}
        {canRenderPrimaryImage && visualProduction.primaryImageSource ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {visualProduction.primaryImageSource === "draft"
              ? t("Draft portrait")
              : t("Live portrait")}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[var(--ad-text-muted)]">

        {t("Draft")} {draftCount}  {t("of 3")}
        <span aria-hidden="true"> · </span>
        <span>{t("Live")} {liveCount}  {t("of 3")}</span>
      </p>
    </>
  );
  const className =
    "block w-24 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]";
  return canOpenAssets
    ? (
        <Link
          aria-label={t("{name}: open role-image assets, Draft {draftCount} of 3, Live {liveCount} of 3", { name, draftCount, liveCount })}
          className={`${className} hover:opacity-90`}
          href={visualProduction.deepLink}
        >
          {content}
        </Link>
      )
    : <div className="w-24">{content}</div>;
}

function PortfolioCard({
  canOpenAssets,
  canOpenProject,
  item,
}: {
  canOpenAssets: boolean;
  canOpenProject: boolean;
  item: CharacterPortfolioItem;
}) {
  const { t } = useAdminI18n();
  const performance = item.performance.find((metric) => metric.window === "28d" && metric.placementId === null)
    ?? item.performance.find((metric) => metric.window === "28d")
    ?? null;
  const nextActionNeedsAssets = [
    "create_primary_portrait",
    "prepare_image_production",
    "continue_asset_pack",
  ].includes(item.nextAction.code);
  const canOpenNextAction =
    canOpenProject && (!nextActionNeedsAssets || canOpenAssets);
  const className = "grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors sm:grid-cols-[96px_1fr_auto]";
  return (
    <article className={className}>
      <CharacterPortfolioVisual
        canOpenAssets={canOpenProject && canOpenAssets}
        name={item.name}
        visualProduction={item.visualProduction}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-semibold text-[var(--ad-ink)]">
            {canOpenProject
              ? (
                  <Link
                    className="hover:underline"
                    href={`/admin/characters/${encodeURIComponent(item.characterId)}`}
                  >
                    {item.name}
                  </Link>
                )
              : item.name}
          </h3>
          <StatusBadge value={item.serving.state} />
          <StatusBadge value={item.readiness} />
        </div>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">{t(item.project.audience)} · {t(item.project.phase.replaceAll("_", " "))}</p>
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
          {characterPortfolioPerformanceLabel(performance)}
        </p>
      </div>
      <div className="self-center text-right text-xs text-[var(--ad-text-muted)]">
        {canOpenNextAction
          ? (
              <Link
                className="inline-block font-semibold text-[var(--ad-ink)] hover:underline"
                href={item.nextAction.deepLink}
              >
                {item.nextAction.label} →
              </Link>
            )
          : <span className="inline-block font-semibold">{t("Performance only")}</span>}
        {item.latestDecision ? (
          <span className="mt-1 block">

            {t("Latest decision:")} {item.latestDecision.decision}
          </span>
        ) : null}
      </div>
    </article>
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
  const [items, setItems] = useState<CharacterPortfolioItem[]>([]);
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState("");
  const [servingState, setServingState] = useState("");
  const [readiness, setReadiness] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState<{ endCursor: string | null; hasNextPage: boolean }>({ endCursor: null, hasNextPage: false });
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const successfulQueryKey = useRef<string | null>(null);

  const load = useCallback(async (next: CharacterPortfolioUrlState, historyMode: "none" | "push" | "replace") => {
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
      const data = await adminV2Request(`/api/v2/admin/characters/portfolio?${query}`, { schema: characterPortfolioResponseSchema });
      if (!request.isCurrent()) return;
      setItems([...data.items]);
      setPageInfo(data.pageInfo);
      setAsOf(data.asOf);
      successfulQueryKey.current = queryKey;
    } catch (reason) {
      if (request.isCurrent()) {
        setError(reason instanceof Error ? reason.message : "Character portfolio could not be loaded");
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    const gate = requestGate.current;
    const restore = (historyMode: "none" | "replace") => {
      const next = parseCharacterPortfolioUrl(window.location.search);
      setSearch(next.search);
      setPhase(next.phase ?? "");
      setServingState(next.servingState ?? "");
      setReadiness(next.readiness ?? "");
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
    void load({
      search,
      phase: phase || undefined,
      servingState: servingState || undefined,
      readiness: readiness || undefined,
      cursor: nextCursor,
    }, "push");
  }

  if (!canRead) return permissionDenied(mode === "performance" ? "character.performance.read" : "character.project.read");
  const performanceMode = mode === "performance";
  return (
    <section aria-labelledby="character-portfolio-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{performanceMode ? t("Growth") : t("Character Studio")}</p>
          <h2 className="mt-1 text-2xl font-semibold" id="character-portfolio-title">{performanceMode ? t("Character Performance") : t("Portfolio & Projects")}</h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">{performanceMode ? t("Compare release-attributed value, maturity, and portfolio decisions without expanding Project authority.") : t("Decide what to promote, improve, pause, or retire from release-attributed evidence.")}</p>
          {!performanceMode && canCreate ? (
            <Link
              className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-[var(--ad-surface)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
              href="/admin/characters/new"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />

              {t("Create Character")}
            </Link>
          ) : null}
        </div>
        <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" onSubmit={(event) => { event.preventDefault(); apply(); }}>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search authority")}<input aria-label={t("Search characters")} className={`${fieldClass} mt-1`} onChange={(event) => setSearch(event.target.value)} placeholder={t("Name, character or project ID")} value={search} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Project phase")}<select aria-label={t("Filter by project phase")} className={`${fieldClass} mt-1`} onChange={(event) => setPhase(event.target.value)} value={phase}><option value="">{t("All phases")}</option>{CHARACTER_PORTFOLIO_PHASES.map((value) => <option key={value} value={value}>{t(value.replaceAll("_", " "))}</option>)}</select></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Serving state")}<select aria-label={t("Filter by serving state")} className={`${fieldClass} mt-1`} onChange={(event) => setServingState(event.target.value)} value={servingState}><option value="">{t("All serving states")}</option>{CHARACTER_PORTFOLIO_SERVING_STATES.map((value) => <option key={value} value={value}>{t(value.replaceAll("_", " "))}</option>)}</select></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Readiness")}<select aria-label={t("Filter by readiness")} className={`${fieldClass} mt-1`} onChange={(event) => setReadiness(event.target.value)} value={readiness}><option value="">{t("All readiness")}</option>{CHARACTER_PORTFOLIO_READINESS_STATES.map((value) => <option key={value} value={value}>{t(value.replaceAll("_", " "))}</option>)}</select></label>
          <WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>
        </form>
      </div>
      {error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load({ search, phase: phase || undefined, servingState: servingState || undefined, readiness: readiness || undefined, cursor }, "none")} type="button">{t("Retry")}</button></div> : null}
      <div className="mt-6">{loading && items.length === 0 ? <LoadingWorkspace label="Loading release-attributed portfolio" /> : items.length === 0 ? error ? null : <EmptyWorkspace filtered={Boolean(search || phase || servingState || readiness)} onClear={() => { setSearch(""); setPhase(""); setServingState(""); setReadiness(""); setCursor(undefined); void load({ search: "" }, "push"); }} /> : <div className="grid gap-3">{items.map((item) => <PortfolioCard canOpenAssets={canOpenAssets} canOpenProject={canOpenProjects} item={item} key={item.characterId} />)}</div>}</div>
      <div className="mt-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--ad-text-muted)]">{asOf ? t("Fresh as of {time}", { time: new Date(asOf).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") }) : t("No successful query yet")}</p><WorkspaceButton disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => apply(pageInfo.endCursor ?? undefined)}>{t("Next page")}</WorkspaceButton></div>
    </section>
  );
}

function ProjectEditor({ data, permissions, onReload, runCommittedMutation }: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  onReload: () => Promise<void>;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const initial = useMemo<ProjectDraft>(() => ({
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
  }), [data]);
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<"Saved" | "Saving" | "Conflict" | "Failed to save">("Saved");
  const [message, setMessage] = useState<string | null>(null);
  const savedKey = useRef(JSON.stringify(initial));

  useEffect(() => {
    const key = JSON.stringify(draft);
    if (!permissions.writeProject || key === savedKey.current) return;
    setState("Saving");
    const timer = window.setTimeout(async () => {
      try {
        await runCommittedMutation({
          action: "Character Project autosave",
          commit: async () => {
            const result = await adminV2Request(`/api/v2/admin/characters/${data.character.id}/project`, {
              method: "PATCH",
              ifMatch: data.project.version,
              body: { ...draft, entityVersion: data.project.version, reason: "Autosave Character Project changes" },
            });
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
          setMessage("A newer server revision exists. Review your local text, then reload the authority before reapplying it.");
        } else {
          setState("Failed to save");
          setMessage(reason instanceof Error ? reason.message : "Project autosave failed");
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [data.character.id, data.project.version, draft, permissions.writeProject, runCommittedMutation]);

  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const disabled = !permissions.writeProject;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
      <fieldset className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:grid-cols-2" disabled={disabled}>
        <legend className="px-2 text-sm font-semibold">{t("Strategy and release intent")}</legend>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Owner ID")}<input className={`${fieldClass} mt-1`} onChange={(event) => set("ownerId", event.target.value || null)} value={draft.ownerId ?? ""} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Audience")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("audience", event.target.value)} value={draft.audience} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Companion need")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("companionNeed", event.target.value)} value={draft.companionNeed} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Hypothesis")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("hypothesis", event.target.value)} value={draft.hypothesis} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Differentiation")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("differentiation", event.target.value)} value={draft.differentiation} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Target placements")}<input className={`${fieldClass} mt-1`} onChange={(event) => set("targetPlacementKeys", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} value={draft.targetPlacementKeys.join(", ")} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Planned launch")}<input className={`${fieldClass} mt-1`} onChange={(event) => set("plannedLaunchAt", event.target.value ? new Date(event.target.value).toISOString() : null)} type="datetime-local" value={draft.plannedLaunchAt?.slice(0, 16) ?? ""} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Success criteria")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("successCriteria", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} value={draft.successCriteria.join("\n")} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Production package")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("productionPackage", event.target.value)} value={draft.productionPackage} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("QA plan")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("qaPlan", event.target.value)} value={draft.qaPlan} /></label>
      </fieldset>
      <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t("Server draft")}</p>
        <div className="mt-4 flex items-center gap-2" role="status"><Save className="h-4 w-4" /><strong>{disabled ? t("Read only") : state}</strong></div>
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Project revision")} {data.project.version}{t(". Autosave uses If-Match; conflicts never overwrite a newer revision.")}</p>
        {message ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] p-3 text-xs text-[var(--ad-yellow-text)]" role={state === "Failed to save" ? "alert" : "status"}>{message}</p> : null}
        {state === "Conflict" ? <div className="mt-3"><WorkspaceButton onClick={() => void onReload().catch(() => undefined)}><RefreshCcw className="h-4 w-4" />  {t("Load server revision")}</WorkspaceButton></div> : null}
      </aside>
      <div className="xl:col-span-2">
        <CollaborationPanel canWrite={permissions.writeProject} targetId={data.project.id} targetType="character_project" targetVersion={data.project.version} />
      </div>
    </div>
  );
}

export type VisualIdentityPanelData = Pick<CharacterWorkspaceDetail, "visual"> & {
  character: Pick<CharacterWorkspaceDetail["character"], "id" | "style" | "imageUrl">;
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
  return !input.hasCurrentCharacterImage && (
    !input.hasActiveIdentity ||
    (input.availableReferenceCount === 0 && !input.hasActiveReferenceSet)
  );
}

export function VisualIdentityPanel({ data, navigateToTab, permissions, runCommittedMutation }: {
  data: VisualIdentityPanelData;
  permissions: Pick<Permissions, "writeVisual" | "evaluateRoute">;
  runCommittedMutation: RunCommittedCharacterMutation;
  navigateToTab?: (tab: CharacterWorkspaceTab) => void;
}) {
  const { t } = useAdminI18n();
  const identity = data.visual.activeIdentity;
  const [identityPrompt, setIdentityPrompt] = useState(identity?.identityPrompt ?? "");
  const [negativeIdentityPrompt, setNegativeIdentityPrompt] = useState(identity?.negativeIdentityPrompt ?? "");
  const [style, setStyle] = useState(identity?.style ?? data.character.style);
  const [defaultSeed, setDefaultSeed] = useState(identity?.defaultSeed ?? "");
  const [identityReason, setIdentityReason] = useState("");
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [batchIds, setBatchIds] = useState("");
  const [matrixKey, setMatrixKey] = useState("");
  const [guardrailEvidence, setGuardrailEvidence] = useState("");
  const [qualificationReason, setQualificationReason] = useState("");
  const referenceCandidates = useMemo(() => uniqueAvailableVisualAssets([
    ...data.visual.anchors,
    ...data.visual.references,
  ]), [data.visual.anchors, data.visual.references]);
  const requiresReviewedBootstrap = requiresReviewedIdentityBootstrap({
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
    () => data.visual.activeReferenceSet?.references
      .map((reference) => reference.mediaAssetId) ?? [],
    [data.visual.activeReferenceSet],
  );
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>(() =>
    data.visual.activeReferenceSet
      ? activeReferenceIds
      : referenceCandidates.map((asset) => asset.mediaAssetId)
  );
  const [referenceReason, setReferenceReason] = useState("");
  const [referenceConfirmed, setReferenceConfirmed] = useState(false);
  const [selectedLookId, setSelectedLookId] = useState<string | null>(null);
  const [lookArchiveReason, setLookArchiveReason] = useState("");
  const [lookArchiveConfirmation, setLookArchiveConfirmation] = useState("");
  const [busy, setBusy] = useState<"identity" | "references" | "qualification" | "look" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef<Record<string, string>>({});
  const removedReferenceIds = referenceIdsRemovedFromPublishedSet(
    activeReferenceIds,
    selectedReferenceIds,
  );
  const readinessActions = useMemo(() => {
    const grouped = new Map<string, {
      readonly deepLink: string;
      readonly messages: string[];
      readonly codes: string[];
    }>();
    for (const blocker of data.visual.readiness.blockers) {
      const action = characterAssetReadinessAction(blocker.code);
      const existing = grouped.get(action);
      grouped.set(action, {
        deepLink: existing?.deepLink ?? blocker.deepLink,
        messages: [...(existing?.messages ?? []), blocker.message],
        codes: [...(existing?.codes ?? []), blocker.code],
      });
    }
    return [...grouped].map(([action, value]) => ({ action, ...value }));
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
      confirmation: identityConfirmed ? `${data.character.id}:visual-profile` : "",
    };
    const requestIdentity = stableIdempotencyKey("visual-profile", body);
    try {
      await runCommittedMutation({
        action: "Visual Identity version",
        commit: () => apiWrite(
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
      setError(cause instanceof Error ? cause.message : "Visual Identity version could not be created");
    } finally {
      setBusy(null);
    }
  };

  const evaluateRoute = async () => {
    setBusy("qualification");
    setError(null);
    const ids = [...new Set(batchIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
    const body = {
      batchIds: ids,
      matrixKey: matrixKey.trim(),
      style: identity?.style ?? style,
      policyVersion: data.visual.readiness.qualificationPolicyVersion,
      costLatencyGuardrail: { status: "passed" as const, evidenceRef: guardrailEvidence.trim() },
      expiresAt: null,
      reason: { code: "route_eval_complete", summary: qualificationReason.trim() },
      confirmation: `QUALIFY ${matrixKey.trim()}`,
    };
    const requestIdentity = stableIdempotencyKey("route-qualification", body);
    try {
      await runCommittedMutation({
        action: "Route qualification",
        commit: () => adminV2Request("/api/v2/admin/characters/route-qualifications/commands/evaluate", {
          method: "POST",
          idempotencyKey: requestIdentity.key,
          schema: generationRouteQualificationEvaluateResponseSchema,
          body,
        }),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setBatchIds("");
          setMatrixKey("");
          setGuardrailEvidence("");
          setQualificationReason("");
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Route qualification could not be evaluated");
    } finally {
      setBusy(null);
    }
  };

  const publishReferenceSet = async () => {
    if (!identity) return;
    setBusy("references");
    setError(null);
    const selected = referenceCandidates.filter((asset) => selectedReferenceIds.includes(asset.mediaAssetId));
    const body = {
      visualProfileId: identity.id,
      expectedActiveReferenceSetRevisionId:
        data.visual.activeReferenceSet?.id ?? null,
      expectedActiveReferenceSetRevision:
        data.visual.activeReferenceSet?.revision ?? 0,
      selectorVersion: "admin-visual-workbench-v1",
      references: selected.map((asset) => ({ mediaAssetId: asset.mediaAssetId, role: asset.role, weight: 1 })),
      reason: { code: "reference_snapshot_publish", summary: referenceReason.trim() },
      confirmation: referenceConfirmed ? `PUBLISH REFERENCES ${data.character.id}` : "",
    };
    const requestIdentity = stableIdempotencyKey("reference-set", body);
    try {
      await runCommittedMutation({
        action: "Reference Set publication",
        commit: () => adminV2Request(`/api/v2/admin/characters/${data.character.id}/reference-sets`, {
          method: "POST",
          idempotencyKey: requestIdentity.key,
          schema: characterReferenceSetPublishResponseSchema,
          body,
        }),
        afterRefresh: () => {
          delete idempotencyKeys.current[requestIdentity.signature];
          setReferenceReason("");
          setReferenceConfirmed(false);
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reference Set could not be published");
    } finally {
      setBusy(null);
    }
  };

  const archiveLook = async () => {
    const look = (data.visual.looks ?? []).find((item) => item.id === selectedLookId);
    if (!look) return;
    setBusy("look");
    setError(null);
    const body = {
      operation: "archive" as const,
      expectedUpdatedAt: look.updatedAt,
      reason: {
        code: "look_retired",
        summary: lookArchiveReason.trim(),
      },
      confirmation: lookArchiveConfirmation.trim(),
    };
    const requestIdentity = stableIdempotencyKey(`archive-look:${look.id}`, body);
    try {
      await runCommittedMutation({
        action: "Character Look archive",
        commit: () => adminV2Request(
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
          setLookArchiveConfirmation("");
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Character Look could not be archived");
    } finally {
      setBusy(null);
    }
  };

  const publishedAssets = [...data.visual.anchors, ...(data.visual.activeReferenceSet?.references ?? [])];
  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
    <div className="space-y-5">
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="visual-authority-title">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold" id="visual-authority-title">{t("Visual Identity authority")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Selection, published references and route qualification are separate evidence.")}</p></div><StatusBadge value={data.visual.readiness.ready ? "visual ready" : "blocked"} /></div>
        {identity ? <><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("Active identity")}</dt><dd className="mt-1 font-semibold">v{identity.version} · {identity.style}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("Anchors available")}</dt><dd className="mt-1 font-semibold">{data.visual.anchors.filter((asset) => asset.available).length}/{data.visual.anchors.length}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("Reference Set")}</dt><dd className="mt-1 font-semibold">{data.visual.activeReferenceSet ? t("revision {version}", { version: data.visual.activeReferenceSet.revision }) : t("Not published")}</dd></div></dl><p className="mt-4 rounded-lg bg-black/[0.03] p-3 text-sm">{identity.identityPrompt}</p></> : <p className="mt-4 text-sm text-[var(--ad-text-muted)]">{t("No active immutable Visual Identity version exists.")}</p>}
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
                      <strong>{item.action}</strong>
                      <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">
                        {item.messages.join(" ")}
                      </span>
                    </span>
                  </span>
                  <Link
                    aria-label={t("Resolve: {action}", { action: t(item.action) })}
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
                  item.codes.map((code) => <li key={code}>{code}</li>)
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

      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="reference-set-title">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold" id="reference-set-title">{t("Anchors & published references")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Select available Identity assets, then seal an immutable Reference Set revision.")}</p></div>{navigateToTab ? <button className="inline-flex min-h-11 items-center rounded-lg border border-[var(--ad-border)] px-3 text-sm font-semibold" onClick={() => navigateToTab("assets")} type="button">{t("Open role image production")}</button> : <Link className="inline-flex min-h-11 items-center rounded-lg border border-[var(--ad-border)] px-3 text-sm font-semibold" href={data.visual.readiness.productionDeepLink}>{t("Open role image production")}</Link>}</div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{publishedAssets.length === 0 ? <p className="text-sm text-[var(--ad-text-muted)]">{t("No anchor or published reference assets.")}</p> : publishedAssets.map((asset, index) => <article className="rounded-lg border border-[var(--ad-border)] p-3" key={`${asset.role}-${asset.mediaAssetId}-${index}`}><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{t(asset.role.replaceAll("_", " "))}</span><StatusBadge value={asset.available ? "available" : "unavailable"} /></div><p className="mt-2 truncate text-xs text-[var(--ad-text-muted)]">{asset.mediaAssetId}</p>{asset.thumbnailUrl ?? asset.url ? <Image alt={t("Visual reference evidence")} className="mt-3 aspect-video w-full rounded-md object-cover" height={180} src={asset.thumbnailUrl ?? asset.url ?? ""} unoptimized width={320} /> : null}</article>)}</div>
        {identity ? <div className="mt-5 border-t border-[var(--ad-border)] pt-4">
          <h4 className="text-sm font-semibold">{t("Publish Reference Set revision")}</h4>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Only checked images become active generation references. Unchecked images leave runtime authority after this revision is published; historical snapshots remain unchanged.")}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">{referenceCandidates.map((asset) => <label className="flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs" key={asset.mediaAssetId}><input checked={selectedReferenceIds.includes(asset.mediaAssetId)} onChange={(event) => setSelectedReferenceIds((current) => event.target.checked ? [...new Set([...current, asset.mediaAssetId])] : current.filter((id) => id !== asset.mediaAssetId))} type="checkbox" /><span className="min-w-0 truncate">{t(asset.role.replaceAll("_", " "))} · {asset.mediaAssetId}</span></label>)}</div>
          {removedReferenceIds.length > 0 ? <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">{t("{count} current references will be removed from active generation.", { count: removedReferenceIds.length })}</p> : null}
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Publication reason")}<input className={`${fieldClass} mt-1`} onChange={(event) => setReferenceReason(event.target.value)} value={referenceReason} /></label>
          <label className="mt-3 flex items-start gap-2 text-xs"><input checked={referenceConfirmed} className="mt-0.5" onChange={(event) => setReferenceConfirmed(event.target.checked)} type="checkbox" /><span>{t("Publish a new immutable reference snapshot and supersede the active revision.")}</span></label>
          <div className="mt-4"><WorkspaceButton disabled={!permissions.writeVisual || busy !== null || selectedReferenceIds.length === 0 || referenceReason.trim().length < 3 || !referenceConfirmed} onClick={() => void publishReferenceSet()} tone="primary">{t("Publish Reference Set")}</WorkspaceButton></div>
        </div> : null}
      </section>

      <section
        className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
        id="character-looks"
        aria-labelledby="character-looks-title"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold" id="character-looks-title">{t("Character Looks using role images")}</h3>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Archive an unused Look before retiring its reference image. Historical generations keep their pinned snapshot.")}</p>
          </div>
          <StatusBadge value={`${(data.visual.looks ?? []).length} active`} />
        </div>
        {(data.visual.looks ?? []).length === 0 ? (
          <p className="mt-4 text-sm text-[var(--ad-text-muted)]">{t("No active or rebase-required Looks depend on this Character.")}</p>
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
                    {look.id}  {t("· reference")} {look.referenceAssetId ?? t("none")}
                  </p>
                </div>
                <WorkspaceButton
                  disabled={!permissions.writeVisual || busy !== null}
                  onClick={() => {
                    setSelectedLookId(look.id);
                    setLookArchiveReason("");
                    setLookArchiveConfirmation("");
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
            <h4 className="text-sm font-semibold">{t("Archive")} {selectedLookId}</h4>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("This removes the active Look dependency. It does not delete the role image.")}</p>
            <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">

              {t("Reason")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) => setLookArchiveReason(event.target.value)}
                value={lookArchiveReason}
              />
            </label>
            <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">

              {t("Type ARCHIVE LOOK")} {selectedLookId}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) => setLookArchiveConfirmation(event.target.value)}
                value={lookArchiveConfirmation}
              />
            </label>
            <div className="mt-4 flex flex-wrap gap-2">
              <WorkspaceButton
                disabled={
                  busy !== null ||
                  lookArchiveReason.trim().length < 3 ||
                  lookArchiveConfirmation.trim() !== `ARCHIVE LOOK ${selectedLookId}`
                }
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
                  setLookArchiveConfirmation("");
                }}
              >

                {t("Cancel")}
              </WorkspaceButton>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="qualification-evidence-title"><h3 className="font-semibold" id="qualification-evidence-title">{t("Route qualification evidence")}</h3>{data.visual.routeQualifications.length === 0 ? <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("No evaluation evidence for the active identity style.")}</p> : <div className="mt-3 overflow-x-auto"><table className="min-w-full text-left text-xs"><thead><tr className="border-b border-[var(--ad-border)] text-[var(--ad-text-muted)]"><th className="py-2 pr-3">{t("Route")}</th><th className="py-2 pr-3">{t("Matrix")}</th><th className="py-2 pr-3">{t("Evidence")}</th><th className="py-2">{t("Result")}</th></tr></thead><tbody>{data.visual.routeQualifications.map((route) => <tr className="border-b border-[var(--ad-border)]" key={route.id}><td className="py-3 pr-3">{route.generationProfileKey} v{route.generationProfileVersion}<span className="block text-[var(--ad-text-muted)]">{route.workflowKey} v{route.workflowVersion}</span></td><td className="py-3 pr-3">{route.matrixKey}<span className="block text-[var(--ad-text-muted)]">{route.policyVersion}</span></td><td className="py-3 pr-3">{route.passCount}/{route.sampleCount} {t("passed")}<span className="block text-[var(--ad-text-muted)]">{percent(route.identityMatch)} {t("identity match")}</span></td><td className="py-3"><StatusBadge value={route.stale ? "stale" : route.result} /></td></tr>)}</tbody></table></div>}</section>
    </div>

    <aside className="space-y-5">
      <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><summary className="cursor-pointer font-semibold">{t("Advanced identity controls")}</summary><section className="mt-4" aria-labelledby="new-identity-title"><h3 className="font-semibold" id="new-identity-title">{t("Create identity version")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Creates a new active immutable version; existing assets are carried forward.")}</p>{requiresReviewedBootstrap ? <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"><p>{t("Establish a reviewed portrait anchor in Character Assets before creating later identity versions.")}</p>{navigateToTab ? <div className="mt-3"><WorkspaceButton onClick={() => navigateToTab("assets")}>{t("Open Character Assets")}</WorkspaceButton></div> : null}</div> : blockedIdentityRepair ? <div className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"><p>{t("This character has earlier visual history but no usable portrait authority. Repair its reviewed image evidence before creating another identity version.")}</p><details className="mt-2 text-xs"><summary className="cursor-pointer font-semibold">{t("Technical identity diagnostics")}</summary><ul className="mt-2 space-y-1">{data.visual.identityBootstrap.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></details></div> : usesCurrentCharacterImageAsAnchor ? <p className="mt-4 rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm text-[var(--ad-blue-text)]">{t("The current Character image is available and will be carried forward as the anchor for this identity version.")}</p> : null}<label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Identity lock")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setIdentityPrompt(event.target.value)} value={identityPrompt} /></label><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Must not change")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setNegativeIdentityPrompt(event.target.value)} value={negativeIdentityPrompt} /></label><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Style")}<select className={`${fieldClass} mt-1`} onChange={(event) => setStyle(event.target.value)} value={style}>{["realistic", "anime", "hybrid", "other"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Seed")}<input className={`${fieldClass} mt-1`} onChange={(event) => setDefaultSeed(event.target.value)} value={defaultSeed} /></label></div><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Change reason")}<input className={`${fieldClass} mt-1`} onChange={(event) => setIdentityReason(event.target.value)} value={identityReason} /></label><label className="mt-3 flex items-start gap-2 text-xs"><input checked={identityConfirmed} className="mt-0.5" onChange={(event) => setIdentityConfirmed(event.target.checked)} type="checkbox" /><span>{t("Activate this as a new identity version.")}</span></label><div className="mt-4"><WorkspaceButton disabled={requiresReviewedBootstrap || blockedIdentityRepair || !permissions.writeVisual || busy !== null || identityReason.trim().length < 3 || !identityConfirmed} onClick={() => void createIdentityVersion()} tone="primary">{t("Create & activate version")}</WorkspaceButton></div>{!permissions.writeVisual ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Read-only: content.official.write is not granted.")}</p> : null}</section></details>
      <details className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><summary className="cursor-pointer font-semibold">{t("Platform route evidence controls")}</summary><section className="mt-4" aria-labelledby="evaluate-route-title"><h3 className="font-semibold" id="evaluate-route-title">{t("Evaluate route evidence")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Production administrators derive qualification from completed model-evaluation batches. Routine character image work does not need these controls.")}</p><Link className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold underline" href={`/admin/ops/profiles?characterId=${encodeURIComponent(data.character.id)}`}>{t("Open Profiles & Rollout")}</Link><label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Batch IDs")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setBatchIds(event.target.value)} placeholder={t("Comma or newline separated")} value={batchIds} /></label><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Matrix key")}<input className={`${fieldClass} mt-1`} onChange={(event) => setMatrixKey(event.target.value)} value={matrixKey} /></label><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Cost/latency evidence reference")}<input className={`${fieldClass} mt-1`} onChange={(event) => setGuardrailEvidence(event.target.value)} value={guardrailEvidence} /></label><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evaluation reason")}<input className={`${fieldClass} mt-1`} onChange={(event) => setQualificationReason(event.target.value)} value={qualificationReason} /></label><p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("Policy:")} {data.visual.readiness.qualificationPolicyVersion}</p><div className="mt-4"><WorkspaceButton disabled={!permissions.evaluateRoute || busy !== null || !batchIds.trim() || !matrixKey.trim() || !guardrailEvidence.trim() || qualificationReason.trim().length < 3 || !identity} onClick={() => void evaluateRoute()} tone="primary">{t("Submit route evaluation")}</WorkspaceButton></div>{!permissions.evaluateRoute ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Read-only: content.production.write is not granted.")}</p> : null}</section></details>
      {error ? <p className="text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
    </aside>
  </div>;
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
  "id" |
  "status" |
  "createdAt" |
  "characterId" |
  "projectId" |
  "projectVersion" |
  "characterContentVersionId" |
  "visualProfileId" |
  "visualProfileVersion" |
  "visualProfileHash" |
  "referenceSetRevisionId" |
  "referenceSetRevision" |
  "referenceSetHash" |
  "draftAssetPackHash"
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
  return data.project.draftAssetRouteAuthority?.qaReady !== false &&
    data.project.draftAssetRouteAuthority?.status !== "stale" &&
    data.project.draftAssetRouteAuthority?.status !== "route_unavailable" &&
    data.preview.draft.assetPackReady !== false &&
    run.status === "passed" &&
    characterQaAuthorityMatches(run, currentWorkspaceQaAuthority(data));
}

export function latestQaRunForCurrentWorkspaceAuthority<
  T extends CharacterWorkspaceQaAuthorityRun,
>(
  runs: readonly T[],
  data: CharacterWorkspaceQaAuthority,
) {
  if (
    data.project.draftAssetRouteAuthority?.qaReady === false ||
    data.project.draftAssetRouteAuthority?.status === "stale" ||
    data.project.draftAssetRouteAuthority?.status === "route_unavailable" ||
    data.preview.draft.assetPackReady === false
  ) return null;
  return latestCharacterQaAuthorityRun(
    runs,
    currentWorkspaceQaAuthority(data),
  );
}

export function releasableQaRunForCurrentWorkspaceAuthority<
  T extends CharacterWorkspaceQaAuthorityRun,
>(
  runs: readonly T[],
  data: CharacterWorkspaceQaAuthority,
) {
  const latest = latestQaRunForCurrentWorkspaceAuthority(runs, data);
  return latest?.status === "passed" ? latest : null;
}

function PreviewDiff({ data, permissions, runCommittedMutation }: { data: CharacterWorkspaceDetail; permissions: Permissions; runCommittedMutation: RunCommittedCharacterMutation }) {
  const { t } = useAdminI18n();
  const snapshots = [data.preview.live, data.preview.draft].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const activeReleaseCandidate = data.releases.find(({ release }) =>
    ["draft", "validating", "in_review", "approved"].includes(release.status)
  );
  const [checks, setChecks] = useState<CharacterQaCheckDraft[]>(() => qaCheckKeys.map((key) => ({
    key,
    result: "",
    evidenceRef: "",
    comment: "",
    fixDeepLink: `/admin/characters/${data.character.id}?tab=preview`,
  })));
  const [reason, setReason] = useState("Record renderer and conversation QA evidence");
  const [busy, setBusy] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const qaIdempotencyKeys = useRef<Record<string, string>>({});
  const draftAssetRouteAllowsQa = data.project.draftAssetRouteAuthority.qaReady;
  const exactDraftAssetPackAllowsQa =
    draftAssetRouteAllowsQa && data.preview.draft.assetPackReady;
  const draftAssetPackIsStale = data.project.draftAssetRouteAuthority.qaBlockers
    .includes("draft_asset_generation_route_stale");
  const updateCheck = (key: CharacterQaCheckInput["key"], patch: Partial<CharacterQaCheckDraft>) => {
    setChecks((current) => current.map((check) => check.key === key ? { ...check, ...patch } : check));
  };
  const recordQa = async () => {
    setBusy(true);
    setQaError(null);
    if (checks.some((check) => !check.result)) {
      setQaError("Choose Passed or Failed for every QA check before recording immutable evidence.");
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
    const idempotencyKey = qaIdempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
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
      setQaError(cause instanceof Error ? cause.message : "Could not record QA evidence");
    } finally {
      setBusy(false);
    }
  };
  const latestAuthorityQaRun = exactDraftAssetPackAllowsQa
    ? latestQaRunForCurrentWorkspaceAuthority(data.qaRuns, data)
    : null;
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" aria-label={t("Changed fields")}>{data.preview.changedFields.map((field) => <StatusBadge key={field} tone="warn" value={`${field} changed`} />)}</div>
      <section aria-labelledby="real-renderer-preview-title">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><h2 className="font-semibold" id="real-renderer-preview-title">{t("Real user-surface renderer")}</h2><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Short-lived signed snapshots render in main without mutating Serving, chats, or assets.")}</p></div>
          <StatusBadge value="read only" />
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {snapshots.map((snapshot) => <article className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" key={`renderer-${snapshot.label}`}>
            <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-4 py-3"><strong className="text-xs uppercase tracking-wide">{t(snapshot.label)}</strong><span className="text-xs text-[var(--ad-text-muted)]">{t("Desktop + responsive mobile layout")}</span></div>
            {snapshot.renderUrl ? <iframe className="h-[760px] w-full bg-[rgb(13,13,13)]" loading="lazy" sandbox="allow-scripts allow-same-origin" src={snapshot.renderUrl} title={t("{label} real frontend renderer", { label: t(snapshot.label) })} /> : <div className="p-6 text-sm text-[var(--ad-text-muted)]">{snapshot.contentVersionId ? t("Renderer unavailable: avatar, hero, and chat must each resolve to their exact operational asset.") : t("Renderer unavailable until an immutable ContentVersion exists.")}</div>}
          </article>)}
        </div>
      </section>
      <h2 className="mb-4 mt-8 font-semibold">{t("Snapshot evidence")}</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {snapshots.map((snapshot) => <article className={cn("overflow-hidden rounded-xl border bg-[var(--ad-surface)]", snapshot.label === "Draft Preview" ? "border-[var(--ad-yellow-text)]" : "border-[var(--ad-border)]")} key={snapshot.label}>
          <div className="border-b border-[var(--ad-border)] px-4 py-3 text-xs font-semibold uppercase tracking-wide">{t(snapshot.label)}</div>
          <div className="p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              {([
                ["character_cover", "Avatar / discovery", "aspect-[4/5]"],
                ["character_hero", "Character hero", "aspect-video"],
                ["character_chat", "Chat image", "aspect-[4/5]"],
              ] as const).map(([purpose, label, aspect]) => {
                const slot = snapshot.assetPack[purpose];
                return <figure className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.04]" key={purpose}>
                  <div className={cn("grid place-items-center overflow-hidden", aspect)}>
                    {slot.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
                      <img alt={t("{name} {slot} {snapshot}", { name: snapshot.name, slot: t(label), snapshot: t(snapshot.label) })} className="h-full w-full object-cover" src={slot.imageUrl} />
                    ) : <span className="px-3 text-center text-xs font-semibold text-[var(--ad-text-muted)]">{slot.status === "missing" ? t("{label} not selected", { label: t(label) }) : t("{label} unavailable", { label: t(label) })}</span>}
                  </div>
                  <figcaption className="border-t border-[var(--ad-border)] px-3 py-2 text-[11px]">
                    <strong>{t(label)}</strong>
                    <span className="mt-0.5 block break-all text-[var(--ad-text-muted)]">{slot.assetId ?? t("No asset ID")}</span>
                  </figcaption>
                </figure>;
              })}
            </div>
            <div className="mt-4"><h3 className="text-lg font-semibold">{snapshot.name}</h3><p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">{snapshot.description}</p><h4 className="mt-5 text-xs font-semibold uppercase tracking-wide">{t("Opening")}</h4><p className="mt-2 text-sm">{String(snapshot.opening.firstMessage ?? t("Unavailable"))}</p><details className="mt-5 text-xs"><summary className="cursor-pointer font-semibold">{t("Immutable evidence")}</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-black/[0.04] p-3">{JSON.stringify({ releaseId: snapshot.releaseId, contentVersionId: snapshot.contentVersionId, assetPack: snapshot.assetPack, persona: snapshot.persona, appearance: snapshot.appearance }, null, 2)}</pre></details></div>
          </div>
        </article>)}
      </div>
      <section aria-labelledby="character-qa-title" className="mt-8 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold" id="character-qa-title">{t("Immutable QA evidence")}</h2><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Every required surface carries a result, evidence, comment, owner and fix path.")}</p></div>
          <StatusBadge value={`${data.qaRuns.length} runs`} />
        </div>
        {activeReleaseCandidate ? (
          <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">

            {t("Release")} {activeReleaseCandidate.release.id}  {t("is")} {activeReleaseCandidate.release.status}{t(". Request changes to withdraw it before recording another QA Run.")}
          </p>
        ) : null}
        {!exactDraftAssetPackAllowsQa ? (
          <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">
            {!data.preview.draft.assetPackReady && draftAssetRouteAllowsQa
              ? t("The selected image pack contains a missing or unavailable exact asset.")
              : draftAssetPackIsStale
              ? t("The selected image pack was generated under an older route.")
              : t("QA requires a complete cover, hero, and chat image pack under the current effective route.")}{" "}
            <Link className="font-semibold underline" href={`/admin/characters/${data.character.id}?tab=assets`}>
              {draftAssetPackIsStale ? t("Regenerate under current route") : t("Complete Character Assets")}
            </Link>{" "}

            {t("before recording QA.")}
          </p>
        ) : null}
        <div className="mt-4 grid gap-3">
          {checks.map((check) => <fieldset className="grid gap-2 rounded-lg border border-[var(--ad-border)] p-3 sm:grid-cols-[190px_120px_1fr]" disabled={!permissions.reviewRelease || busy || Boolean(activeReleaseCandidate) || !exactDraftAssetPackAllowsQa} key={check.key}>
            <legend className="sr-only">{check.key}</legend>
            <div className="text-xs font-semibold">{t(check.key.replaceAll("_", " "))}</div>
            <select aria-label={t("{check} result", { check: t(check.key.replaceAll("_", " ")) })} className={fieldClass} onChange={(event) => updateCheck(check.key, { result: event.target.value as CharacterQaCheckDraft["result"] })} value={check.result}><option value="">{t("Not run")}</option><option value="failed">{t("Failed")}</option><option value="passed">{t("Passed")}</option></select>
            <input aria-label={t("{check} evidence reference", { check: t(check.key.replaceAll("_", " ")) })} className={fieldClass} onChange={(event) => updateCheck(check.key, { evidenceRef: event.target.value })} placeholder={t("Evidence URL or durable reference")} value={check.evidenceRef} />
            <textarea aria-label={t("{check} comment", { check: t(check.key.replaceAll("_", " ")) })} className={`${textAreaClass} sm:col-span-3`} onChange={(event) => updateCheck(check.key, { comment: event.target.value })} value={check.comment} />
          </fieldset>)}
        </div>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("QA reason")}<input className={`${fieldClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} /></label>
        {qaError ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{qaError}</p> : null}
        <div className="mt-4"><WorkspaceButton disabled={!permissions.reviewRelease || busy || Boolean(activeReleaseCandidate) || !exactDraftAssetPackAllowsQa || checks.some((check) => !check.result || !check.evidenceRef.trim() || check.comment.trim().length < 3)} onClick={() => void recordQa()} tone="primary">{t("Record immutable QA Run")}</WorkspaceButton></div>
        <div className="mt-5 grid gap-2">
          {data.qaRuns.map((run) => {
            const authorityMatches = exactDraftAssetPackAllowsQa && characterQaAuthorityMatches(
              run,
              currentWorkspaceQaAuthority(data),
            );
            const authorityLabel = latestAuthorityQaRun?.id === run.id
              ? "current authority"
              : authorityMatches
                ? "superseded"
                : "stale";
            return <article className="rounded-lg bg-black/[0.04] p-3 text-xs" key={run.id}><div className="flex flex-wrap items-center gap-2"><StatusBadge value={run.status} /><StatusBadge tone={authorityLabel === "current authority" && run.status === "passed" ? "good" : "warn"} value={authorityLabel} /><strong>{run.id}</strong><span className="text-[var(--ad-text-muted)]">{t("owner")} {run.ownerId}  {t("· ContentVersion")} {run.characterContentVersionId}</span></div><p className="mt-2 text-[var(--ad-text-muted)]">{t("Identity v")}{run.visualProfileVersion ?? t("legacy")}  {t("· Reference r")}{run.referenceSetRevision ?? t("legacy")}  {t("· Asset pack")} {run.draftAssetPackHash?.slice(0, 12) ?? t("legacy")}</p><p className="mt-2 break-all text-[var(--ad-text-muted)]">{t("Evidence hash")} {run.evidenceHash}</p><details className="mt-3 border-t border-black/10 pt-3"><summary className="cursor-pointer font-semibold">{t("Checks, evidence, and repair paths")}</summary><div className="mt-2 grid gap-2">{run.checks.map((check) => <div className="rounded-md bg-white/60 p-2" key={check.key}><div className="flex flex-wrap items-center justify-between gap-2"><strong>{t(check.key.replaceAll("_", " "))}</strong><StatusBadge value={check.result} /></div><p className="mt-1 text-[var(--ad-text-muted)]">{check.comment}</p><p className="mt-1 break-all">{t("Evidence:")} {check.evidenceRef}</p><Link className="mt-1 inline-block font-semibold underline" href={check.fixDeepLink}>{t("Open fix path")}</Link></div>)}</div></details></article>;
          })}
        </div>
      </section>
    </div>
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
  const candidate = data.releases.find(({ release }) => !["published", "superseded", "withdrawn"].includes(release.status));
  const current = data.releases.find(({ release }) => release.id === data.serving?.currentReleaseId);
  const rollbackSources = data.releases.filter(({ release }) =>
    release.id !== current?.release.id && release.status === "superseded",
  );
  const [reason, setReason] = useState("Operator verified release evidence");
  const [selectedQaRunId, setSelectedQaRunId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [selectedRollbackSourceId, setSelectedRollbackSourceId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposalIdempotencyKeys = useRef<Record<string, string>>({});
  const validationIdempotencyKeys = useRef<Record<string, string>>({});
  const releaseReviewIdempotencyKeys = useRef<Record<string, string>>({});

  const command = async (kind: "publish" | "schedule" | "rollback", releaseId: string, version: number) => {
    if (pendingCommand || mutationNotice) return;
    const expectedConfirmation = `${data.character.id}:${releaseId}:${kind}`;
    if (confirmation.trim() !== expectedConfirmation) {
      setError(`Type ${expectedConfirmation} to confirm this high-risk action.`);
      return;
    }
    const scheduledDate = kind === "schedule" ? new Date(scheduledAt) : null;
    if (scheduledDate && Number.isNaN(scheduledDate.getTime())) {
      setError("Choose a valid schedule date and time.");
      return;
    }
    setBusy(kind);
    setError(null);
    if (!beginCommandSubmission(
      `Submitting Release ${kind}. Character writes stay locked until command acceptance is known.`,
    )) {
      setBusy(null);
      return;
    }
    let submission: PendingCharacterCommand | null = null;
    try {
      const body = {
        entityVersion: version,
        reason: { code: `operator_${kind}`, summary: reason },
        confirmation: confirmation.trim(),
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
      setConfirmation("");
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
      setError(conflict
        ? `${characterCommandActionLabel(conflict.commandType)} is already active. This workspace attached to that command instead of accepting another one.`
        : cause instanceof Error
        ? cause.message
        : submission
          ? `Release ${kind} acceptance is unknown. The same command will be replayed safely.`
          : `Could not ${kind} release`);
    } finally {
      setBusy(null);
    }
  };
  const rollbackSourceId = rollbackSources.some(({ release }) => release.id === selectedRollbackSourceId)
    ? selectedRollbackSourceId
    : rollbackSources[0]?.release.id ?? "";
  const rollbackSource = rollbackSources.find(({ release }) => release.id === rollbackSourceId);
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
    : eligibleQaRuns[0]?.id ?? "";
  const propose = async () => {
    setBusy("propose");
    setError(null);
    const requestSignature = JSON.stringify({
      characterId: data.character.id,
      entityVersion: data.project.version,
      qaRunId,
      reason,
      confirmation: confirmation.trim(),
    });
    const idempotencyKey = proposalIdempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    proposalIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      const mutation = characterReleaseProposalMutation(
        data.character.id,
        data.project.version,
        qaRunId,
        reason,
        confirmation.trim(),
        idempotencyKey,
      );
      await runCommittedMutation({
        action: "Release proposal",
        commit: () => adminV2Request(mutation.path, mutation.options),
        afterRefresh: () => {
          delete proposalIdempotencyKeys.current[requestSignature];
          setConfirmation("");
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not propose Release");
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
      confirmation: confirmation.trim(),
    });
    const idempotencyKey = releaseReviewIdempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    releaseReviewIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      const mutation = characterReleaseReviewMutation(
        data.character.id,
        candidate.release.id,
        candidate.release.version,
        decision,
        reason,
        confirmation.trim(),
        idempotencyKey,
      );
      await runCommittedMutation({
        action: "Release review",
        commit: () => adminV2Request(mutation.path, mutation.options),
        afterRefresh: () => {
          delete releaseReviewIdempotencyKeys.current[requestSignature];
          setConfirmation("");
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not review Release");
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
      confirmation: confirmation.trim(),
    });
    const idempotencyKey = validationIdempotencyKeys.current[requestSignature] ?? crypto.randomUUID();
    validationIdempotencyKeys.current[requestSignature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: "Release validation",
        commit: () => adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases/${candidate.release.id}/validation`, {
          method: "POST",
          idempotencyKey,
          body: {
            entityVersion: candidate.release.version,
            confirmation: confirmation.trim(),
          },
        }),
        afterRefresh: () => {
          delete validationIdempotencyKeys.current[requestSignature];
          setConfirmation("");
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not validate Release");
    } finally {
      setBusy(null);
    }
  };
  const servingCommand = async (action: "pause" | "resume" | "retire") => {
    if (!data.serving || pendingCommand || mutationNotice) return;
    setBusy(action); setError(null);
    if (!beginCommandSubmission(
      `Submitting Serving ${action}. Character writes stay locked until command acceptance is known.`,
    )) {
      setBusy(null);
      return;
    }
    let submission: PendingCharacterCommand | null = null;
    try {
      const body = {
        entityVersion: data.serving.version,
        reason: { code: `operator_${action}`, summary: reason },
        confirmation: confirmation.trim(),
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
      setConfirmation("");
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
      setError(conflict
        ? `${characterCommandActionLabel(conflict.commandType)} is already active. This workspace attached to that command instead of accepting another one.`
        : cause instanceof Error
        ? cause.message
        : submission
          ? `Serving ${action} acceptance is unknown. The same command will be replayed safely.`
          : `Could not ${action} Character`);
    }
    finally { setBusy(null); }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {data.releases.length === 0
          ? <EmptyWorkspace filtered={false} onClear={() => undefined} />
          : data.releases.map(({ release, checks }) => (
            <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={release.id}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono text-xs">{release.id}</strong>
                <StatusBadge value={release.status} />
                <StatusBadge value={release.readiness} />
                {release.id === data.serving?.currentReleaseId ? <StatusBadge tone="good" value="serving now" /> : null}
              </div>
              <p className="mt-3 text-xs text-[var(--ad-text-muted)]">

                {t("Snapshot")} {release.snapshotHash.slice(0, 16)}  {t("· release v")}{release.version}  {t("· content")} {release.characterContentVersionId}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {checks.map((check) => (
                  <div className="flex items-center justify-between rounded bg-black/[0.03] px-3 py-2 text-xs" key={check.checkKey}>
                    <span>{check.checkKey}</span>
                    <StatusBadge value={check.result} />
                  </div>
                ))}
              </div>
              <details className="mt-3 border-t border-[var(--ad-border)] pt-3">
                <summary className="cursor-pointer text-xs font-semibold">{t("Pinned assets, generation, and review lineage")}</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.035] p-3 text-[11px] leading-5">{JSON.stringify({
                  releasePlacementManifest: release.releasePlacementManifest,
                  generationProvenance: release.generationProvenance,
                }, null, 2)}</pre>
              </details>
            </article>
          ))}
      </div>
      <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h3 className="font-semibold">{t("Release action")}</h3>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Reason")}
          <textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Schedule at")}
          <input className={`${fieldClass} mt-1`} onChange={(event) => setScheduledAt(event.target.value)} type="datetime-local" value={scheduledAt} />
        </label>
        {!candidate ? (
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">

            {t("Passed QA Run for this draft")}
            <select className={`${fieldClass} mt-1`} onChange={(event) => setSelectedQaRunId(event.target.value)} value={qaRunId}>
              <option value="">{t("Record QA for the current project version")}</option>
              {eligibleQaRuns.map((run) => <option key={run.id} value={run.id}>{run.id} · {run.characterContentVersionId}</option>)}
            </select>
            {latestAuthorityQaRun?.status === "failed"
              ? <span className="mt-2 block font-normal text-[var(--ad-amber-text)]">{t("The latest QA Run for this snapshot failed. Earlier passed runs cannot authorize release.")}</span>
              : data.qaRuns.some((run) => run.status === "passed") && eligibleQaRuns.length === 0
                ? <span className="mt-2 block font-normal text-[var(--ad-amber-text)]">{t("Earlier QA evidence is stale after the latest draft or release review change.")}</span>
              : null}
          </label>
        ) : null}
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Historical rollback source")}
          <select className={`${fieldClass} mt-1`} onChange={(event) => setSelectedRollbackSourceId(event.target.value)} value={rollbackSourceId}>
            <option value="">{t("No superseded release available")}</option>
            {rollbackSources.map(({ release }) => <option key={release.id} value={release.id}>{release.id}</option>)}
          </select>
        </label>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Exact confirmation")}
          <input className={`${fieldClass} mt-1`} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
        </label>
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">

          {t("Use the exact target, for example")} {t("Confirmation target: {target}", { target: candidate ? `${data.character.id}:${candidate.release.id}:${candidate.release.status === "in_review" ? "approved" : "publish"}` : `${data.character.id}:propose-release` })}.
        </p>
        {error ? <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        {data.serving?.state === "live" && data.serving.scheduledReleaseId ? (
          <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs text-[var(--ad-yellow-text)]">

            {t("Retiring this Character also cancels scheduled Release")} {data.serving.scheduledReleaseId}{t(". The cancellation is recorded with the retirement command.")}
          </p>
        ) : null}
        <div className="mt-4 grid gap-2">
          {!candidate ? <WorkspaceButton disabled={!permissions.proposeRelease || !qaRunId || confirmation !== `${data.character.id}:propose-release` || Boolean(busy)} onClick={() => void propose()}><Rocket className="h-4 w-4" />  {t("Propose immutable Release")}</WorkspaceButton> : null}
          {candidate?.release.status === "in_review" ? <><WorkspaceButton disabled={!permissions.reviewRelease || confirmation !== `${data.character.id}:${candidate.release.id}:approved` || Boolean(busy)} onClick={() => void review("approved")} tone="primary">{t("Approve candidate")}</WorkspaceButton><WorkspaceButton disabled={!permissions.reviewRelease || confirmation !== `${data.character.id}:${candidate.release.id}:changes_requested` || Boolean(busy)} onClick={() => void review("changes_requested")}>{t("Request changes")}</WorkspaceButton></> : null}
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || candidate.release.status !== "approved" || confirmation !== `${data.character.id}:${candidate.release.id}:validate` || Boolean(busy)} onClick={() => void validate()}>

            {t("Validate pinned snapshot")}
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || candidate.release.status !== "approved" || candidate.release.readiness !== "ready" || Boolean(busy)} onClick={() => candidate && void command("publish", candidate.release.id, candidate.release.version)} tone="primary">
            <Rocket className="h-4 w-4" />  {t("Publish candidate")}
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || candidate.release.status !== "approved" || candidate.release.readiness !== "ready" || !scheduledAt || Boolean(busy)} onClick={() => candidate && void command("schedule", candidate.release.id, candidate.release.version)}>
            <Clock3 className="h-4 w-4" />  {t("Schedule")}
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !rollbackSource || Boolean(busy)} onClick={() => rollbackSource && void command("rollback", rollbackSource.release.id, data.serving?.version ?? 0)} tone="danger">
            <RotateCcw className="h-4 w-4" />  {t("Roll back to selected snapshot")}
          </WorkspaceButton>
          {data.serving?.state === "live" ? <><WorkspaceButton disabled={!permissions.publishRelease || confirmation !== `${data.character.id}:pause` || Boolean(busy)} onClick={() => void servingCommand("pause")}>{t("Pause serving")}</WorkspaceButton><WorkspaceButton disabled={!permissions.publishRelease || confirmation !== `${data.character.id}:retire` || Boolean(busy)} onClick={() => void servingCommand("retire")} tone="danger">{t("Retire Character")}</WorkspaceButton></> : null}
          {data.serving?.state === "paused" ? <WorkspaceButton disabled={!permissions.publishRelease || confirmation !== `${data.character.id}:resume` || Boolean(busy)} onClick={() => void servingCommand("resume")}>{t("Resume serving")}</WorkspaceButton> : null}
        </div>
        {!permissions.publishRelease ? <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("Read-only: character.release.publish is not granted.")}</p> : null}
      </aside>
    </div>
  );
}

function MonitorPanel({
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
  const current = data.releases.find(({ release }) => release.id === data.serving?.currentReleaseId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshIdempotencyKeys = useRef<Record<string, string>>({});
  const refresh = async (window: "24h" | "72h") => {
    if (!current) return; setBusy(true); setError(null);
    const signature = `${current.release.id}:${current.release.version}:${window}`;
    const idempotencyKey = refreshIdempotencyKeys.current[signature] ?? crypto.randomUUID();
    refreshIdempotencyKeys.current[signature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: `${window} Release monitor refresh`,
        commit: () => adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases/${current.release.id}/monitors/${window}/refresh`, { method: "POST", idempotencyKey, body: { entityVersion: current.release.version } }),
        afterRefresh: () => {
          delete refreshIdempotencyKeys.current[signature];
        },
      });
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Monitor refresh failed"); }
    finally { setBusy(false); }
  };
  if (!current) return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  const windows = characterMonitorWindows(current.monitors);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <WorkspaceButton disabled={busy || !permissions.reviewRelease} onClick={() => void refresh("24h")}>
          <RefreshCcw className="h-4 w-4" />  {t("Refresh 24h")}
        </WorkspaceButton>
        <WorkspaceButton disabled={busy || !permissions.reviewRelease} onClick={() => void refresh("72h")}>
          <RefreshCcw className="h-4 w-4" />  {t("Refresh 72h")}
        </WorkspaceButton>
      </div>
      {!permissions.reviewRelease ? <p className="mb-4 text-xs text-[var(--ad-text-muted)]">{t("Read-only: character.release.review is not granted.")}</p> : null}
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {windows.map((window) => {
          const monitor = current.monitors.find((item) => item.window === window);
          const emptyStatus = window === "route_qualification" ? "not_required" : "pending";
          return (
            <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={window}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t(window.replaceAll("_", " "))}  {t("guardrail")}</h3>
                <StatusBadge value={monitor?.status ?? emptyStatus} />
              </div>
              {monitor ? (
                <>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    {Object.entries(monitor.observed).map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-[var(--ad-text-muted)]">{key}</dt>
                        <dd className="mt-1 font-semibold">{String(value ?? t("Unavailable"))}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 text-xs text-[var(--ad-text-muted)]">

                    {t("Recommendation:")} {String(monitor.verification.recommendation ?? (
                      window === "route_qualification" && monitor.status === "action_required"
                        ? "refresh route qualification before the next Release"
                        : "continue_monitoring"
                    ))}
                  </p>
                  {window === "route_qualification" && monitor.status === "action_required" ? (
                    <button
                      className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold underline"
                      onClick={onOpenVisual}
                      type="button"
                    >

                      {t("Open route qualification")}
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {window === "route_qualification"
                    ? t("No route qualification action is currently required.")
                    : t("No observation yet. Refresh once the release is published.")}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PerformancePanel({ data, permissions, runCommittedMutation }: { data: CharacterWorkspaceDetail; permissions: Permissions; runCommittedMutation: RunCommittedCharacterMutation }) {
  const { t } = useAdminI18n();
  const releaseId = data.serving?.currentReleaseId ?? data.releases[0]?.release.id ?? "";
  const [decision, setDecision] = useState<"Promote" | "Maintain" | "Improve" | "Pause" | "Retire">("Maintain");
  const [question, setQuestion] = useState("What should we do with this Character based on current release evidence?");
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [evidenceLevel, setEvidenceLevel] = useState<"observational" | "attribution" | "causal">("observational");
  const [confidence, setConfidence] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("Review the selected action at the next portfolio window");
  const [guardrails, setGuardrails] = useState("Do not regress qualified conversation or Same-character D7");
  const [reviewAt, setReviewAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionIdempotencyKeys = useRef<Record<string, string>>({});
  const recordDecision = async () => {
    setBusy(true); setError(null);
    const body = {
      releaseId,
      decision,
      question,
      evidenceRefs: evidenceRefs.split(",").map((value) => value.trim()).filter(Boolean),
      evidenceLevel,
      confidence: confidence ? Number(confidence) : null,
      successCriteria: successCriteria.split("\n").map((value) => value.trim()).filter(Boolean),
      guardrails: guardrails.split("\n").map((value) => value.trim()).filter(Boolean),
      reviewAt: reviewAt ? new Date(reviewAt).toISOString() : null,
    };
    const signature = JSON.stringify(body);
    const idempotencyKey = decisionIdempotencyKeys.current[signature] ?? crypto.randomUUID();
    decisionIdempotencyKeys.current[signature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: "Portfolio decision",
        commit: () => adminV2Request(`/api/v2/admin/characters/${data.character.id}/portfolio-decisions`, {
          method: "POST",
          idempotencyKey,
          body,
        }),
        afterRefresh: () => {
          delete decisionIdempotencyKeys.current[signature];
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record portfolio decision");
    } finally {
      setBusy(false);
    }
  };
  const latest = data.portfolio.latestDecision;
  return <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
    <div>
      <div className="grid gap-4 lg:grid-cols-2">{data.performance.length === 0 ? <EmptyWorkspace filtered={false} onClear={() => undefined} /> : data.performance.map((metric) => <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={`${metric.window}-${metric.placementId ?? "all"}`}><div className="flex items-center justify-between"><h3 className="font-semibold">{metric.window} · {metric.placementId ?? t("all placements")}</h3><StatusBadge value={metric.maturity} /></div><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("QCE")}</dt><dd className="mt-1 font-semibold">{percent(metric.qceRate)}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("Same-character D7")}</dt><dd className="mt-1 font-semibold">{percent(metric.sameCharacterD7)}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("Sample")}</dt><dd className="mt-1 font-semibold">{metric.sampleSize}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">{t("Margin")}</dt><dd className="mt-1 font-semibold">{metric.contributionMargin.valueMicros === null ? t("Unavailable") : metric.contributionMargin.valueMicros.toLocaleString()}</dd></div></dl><p className="mt-4 text-xs text-[var(--ad-text-muted)]">{t(metric.qualityState)} · {t(metric.coverageState)}  {t("· release")} {metric.characterReleaseId}</p></article>)}</div>
      <section className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="latest-portfolio-decision-title"><h3 className="font-semibold" id="latest-portfolio-decision-title">{t("Latest Decision Record")}</h3>{latest ? <div className="mt-3 text-sm"><div className="flex flex-wrap gap-2"><StatusBadge value={latest.decision} /><StatusBadge value={latest.evidenceLevel} /></div><p className="mt-3">{latest.question}</p><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Owner")} {latest.ownerId}  {t("· review")} {latest.reviewAt ?? t("not scheduled")}  {t("· confidence")} {latest.confidence ?? t("unavailable")}</p></div> : <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("No portfolio decision has been recorded.")}</p>}</section>
    </div>
    <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="font-semibold">{t("Record portfolio decision")}</h3>
      <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Action")}<select className={`${fieldClass} mt-1`} onChange={(event) => setDecision(event.target.value as typeof decision)} value={decision}>{["Promote", "Maintain", "Improve", "Pause", "Retire"].map((value) => <option key={value}>{t(value)}</option>)}</select></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Decision question")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setQuestion(event.target.value)} value={question} /></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evidence references")}<input className={`${fieldClass} mt-1`} onChange={(event) => setEvidenceRefs(event.target.value)} placeholder={t("metric:, release:, qa: (comma separated)")} value={evidenceRefs} /></label>
      <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evidence level")}<select className={`${fieldClass} mt-1`} onChange={(event) => setEvidenceLevel(event.target.value as typeof evidenceLevel)} value={evidenceLevel}><option value="observational">{t("Observational")}</option><option value="attribution">{t("Attribution")}</option><option value="causal">{t("Causal")}</option></select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Confidence")}<input className={`${fieldClass} mt-1`} max="1" min="0" onChange={(event) => setConfidence(event.target.value)} step="0.01" type="number" value={confidence} /></label></div>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Success criteria")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setSuccessCriteria(event.target.value)} value={successCriteria} /></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Guardrails")}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setGuardrails(event.target.value)} value={guardrails} /></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">{t("Review at")}<input className={`${fieldClass} mt-1`} onChange={(event) => setReviewAt(event.target.value)} type="datetime-local" value={reviewAt} /></label>
      {error ? <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      <div className="mt-4"><WorkspaceButton disabled={!permissions.writeProject || busy || !releaseId || question.trim().length < 3 || !evidenceRefs.trim() || !successCriteria.trim()} onClick={() => void recordDecision()} tone="primary">{t("Record Decision")}</WorkspaceButton></div>
    </aside>
  </div>;
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
  const { t } = useAdminI18n();
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commandRecoveryError, setCommandRecoveryError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCharacterCommand | null>(null);
  const [mutationNotice, setMutationNotice] = useState<CharacterMutationNotice | null>(null);
  const mutationNoticeRef = useRef<CharacterMutationNotice | null>(mutationNotice);
  const pendingCommandRef = useRef<PendingCharacterCommand | null>(pendingCommand);
  const mutationAuthority = useRef(createCharacterMutationAuthorityCoordinator());
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
      const next = await adminV2Request(`/api/v2/admin/characters/${id}`, { schema: characterWorkspaceDetailSchema });
      if (request.isCurrent()) setData(next);
    } catch (cause) {
      if (request.isCurrent()) {
        setError(cause instanceof Error ? cause.message : "Character workspace could not be loaded");
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
      setError(cause instanceof Error ? cause.message : "Character workspace could not be loaded");
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [id]);
  const updateMutationNotice = useCallback((notice: CharacterMutationNotice | null) => {
    mutationAuthority.current.setNotice(notice);
    mutationNoticeRef.current = notice;
    setMutationNotice(notice);
  }, []);
  const getDurableCommandIdempotencyKey = useCallback((signature: string) => {
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
  }, [actorId, id]);
  const releaseDurableCommandIdempotencyKey = useCallback((signature: string) => {
    delete durableCommandIdempotencyKeys.current[signature];
    const storage = browserCharacterCommandStorage();
    if (storage) {
      releaseCharacterCommandIdempotencyKey(
        storage,
        actorId,
        id,
        signature,
      );
    }
  }, [actorId, id]);
  const rememberPendingCommand = useCallback((command: PendingCharacterCommand) => {
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
  }, [actorId, id, updateMutationNotice]);
  const refreshCommittedProjection = useCallback(async (
    action: string,
    commandId?: string,
    afterRefresh?: () => void,
  ) => {
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
        rememberPendingCommand(pendingCommandFromAuthority(result.projection.activeCommand));
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
  const runCommittedMutation = useCallback(async <T,>(input: {
    readonly action: string;
    readonly commit: () => Promise<T>;
    readonly afterRefresh?: () => void;
  }) => {
    if (mutationNoticeRef.current || pendingCommandRef.current) {
      throw new Error("Refresh the authoritative Character workspace before another write.");
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
  }, [refreshCommittedProjection, updateMutationNotice]);
  const discardPendingCommand = useCallback((command: PendingCharacterCommand) => {
    const current = pendingCommandRef.current;
    if (!current || !isSamePendingCharacterCommand(current, command)) return false;
    if (!mutationAuthority.current.currentCommandIs(command)) return false;
    if (!clearPendingCharacterCommand(id, actorId, command)) return false;
    if (!mutationAuthority.current.clearCommand(command)) return false;
    releaseDurableCommandIdempotencyKey(command.signature);
    pendingCommandRef.current = null;
    setPendingCommand(null);
    updateMutationNotice(null);
    return true;
  }, [actorId, id, releaseDurableCommandIdempotencyKey, updateMutationNotice]);
  const beginCommandSubmission = useCallback((message: string) => {
    if (mutationNoticeRef.current || pendingCommandRef.current) return false;
    mutationAuthority.current.advanceGeneration();
    updateMutationNotice({ kind: "mutation_in_flight", message });
    return true;
  }, [updateMutationNotice]);
  const abortCommandSubmission = useCallback(() => {
    if (mutationNoticeRef.current?.kind === "mutation_in_flight") {
      mutationAuthority.current.advanceGeneration();
      updateMutationNotice(null);
    }
  }, [updateMutationNotice]);
  const settlePendingCommand = useCallback((
    action: string,
    commandId: string | undefined,
    afterRefresh?: () => void,
  ) => refreshCommittedProjection(action, commandId, afterRefresh), [refreshCommittedProjection]);
  const refreshAuthoritativeWorkspace = useCallback(async () => {
    if (
      mutationNoticeRef.current?.kind === "command_pending" ||
      mutationNoticeRef.current?.kind === "command_submission_unknown" ||
      mutationNoticeRef.current?.kind === "command_reconfirmation_required"
    ) return false;
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
        message: current?.kind === "refresh_required"
          ? current.message
          : committedCharacterProjectionWarning("Character mutation", result.error),
        ...(current?.kind === "refresh_required" && current.commandId
          ? { commandId: current.commandId }
          : {}),
      });
      return false;
    }
    if (result.status === "kept_locked") {
      if (result.projection.activeCommand) {
        rememberPendingCommand(pendingCommandFromAuthority(result.projection.activeCommand));
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
  const reconcilePendingCommandAuthority = useCallback(async (
    command: PendingCharacterCommand,
    message: string,
  ) => {
    const current = pendingCommandRef.current;
    if (!current || !isSamePendingCharacterCommand(current, command)) return false;
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
      ) return false;
      if (authoritative.activeCommand) {
        const active = pendingCommandFromAuthority(authoritative.activeCommand);
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
      ) return false;
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
  }, [
    discardPendingCommand,
    loadAuthoritative,
    rememberPendingCommand,
    updateMutationNotice,
  ]);
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
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
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
      setWorkspaceUrl(new URLSearchParams({ tab: "release" }), { mode: "replace" });
    };
    const timer = window.setTimeout(restore, 0);
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== pendingCommandStorageKey(actorId, id)
      ) return;
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
  }, [
    actorId,
    id,
    reconcilePendingCommandAuthority,
    rememberPendingCommand,
  ]);
  useEffect(() => {
    const active = data?.activeCommand;
    if (!active || pendingCommandRef.current?.commandId === active.commandId) return;
    rememberPendingCommand(pendingCommandFromAuthority(active));
    setTab("release");
    setWorkspaceUrl(new URLSearchParams({ tab: "release" }), { mode: "replace" });
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
          setPendingCommand((current) => current ? { ...current, terminal: true } : current);
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
          setPendingCommand((current) => current ? { ...current, terminal: true } : current);
          const failed = status.status !== "succeeded";
          await settlePendingCommand(
            failed
              ? `${pendingCommand.action} ${status.status}`
              : pendingCommand.action,
            pendingCommand.commandId,
            () => discardPendingCommand(pendingCommand),
          );
          setCommandRecoveryError(failed
            ? `${pendingCommand.action} command ${status.status}. Open command evidence for the authoritative result.`
            : null);
          return;
        }
        setCommandRecoveryError(null);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof AdminV2RequestError && cause.status === 404) {
          setPendingCommand((current) => current ? { ...current, terminal: true } : current);
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
    const restoreTab = () => {
      if (mutationNoticeRef.current || pendingCommandRef.current || data?.activeCommand) {
        setWorkspaceUrl(new URLSearchParams({ tab: tabRef.current }), { mode: "replace" });
        return;
      }
      setTab(characterWorkspaceTabFromSearch(window.location.search));
    };
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, [data?.activeCommand, id]);
  if (!permissions.read) return permissionDenied("character.project.read");
  if (loading && !data && !pendingCommand) {
    return <LoadingWorkspace label="Loading Character Project, Release and Monitor evidence" />;
  }
  if (!data) {
    return (
      <section className="space-y-3">
        {mutationNotice ? (
          <div className="rounded-xl bg-[var(--ad-blue-bg)] p-4 text-sm text-[var(--ad-blue-text)]" role="status">
            <p>{mutationNotice.message}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              {mutationNotice.kind === "refresh_required" ? (
                <button className="font-semibold underline" onClick={() => void refreshAuthoritativeWorkspace()} type="button">

                  {t("Retry authoritative workspace")}
                </button>
              ) : null}
              {mutationNotice.kind === "command_reconfirmation_required" && pendingCommand ? (
                <button className="font-semibold underline" onClick={authorizePendingCommandReplay} type="button">

                  {t("Review and resume saved command")}
                </button>
              ) : null}
              {"commandId" in mutationNotice && mutationNotice.commandId ? (
                <Link className="font-semibold underline" href={`/admin/system/audit?commandId=${encodeURIComponent(mutationNotice.commandId)}`}>

                  {t("Open command evidence")}
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        {commandRecoveryError ? (
          <p className="rounded-xl bg-[var(--ad-yellow-bg)] p-4 text-sm text-[var(--ad-yellow-text)]" role="alert">
            {commandRecoveryError}
          </p>
        ) : null}
        <div className="rounded-xl bg-[var(--ad-red-bg)] p-5 text-sm text-[var(--ad-red-text)]" role="alert">
          {error ?? (loading ? t("Loading the authoritative Character workspace…") : t("Character not found"))}
          <button className="ml-2 font-semibold underline" onClick={() => void load().catch(() => undefined)} type="button">

            {t("Retry workspace")}
          </button>
        </div>
      </section>
    );
  }
  const selectTab = (next: Tab) => {
    if (
      (mutationNoticeRef.current || pendingCommandRef.current || data.activeCommand) &&
      next !== tab
    ) return;
    setTab(next);
    setWorkspaceUrl(new URLSearchParams({ tab: next }), { mode: "push" });
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (mutationNotice || pendingCommand || data.activeCommand) return;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? characterWorkspaceTabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + characterWorkspaceTabs.length) % characterWorkspaceTabs.length;
    const next = characterWorkspaceTabs[nextIndex];
    selectTab(next);
    document.getElementById(`character-tab-${next}`)?.focus();
  };
  const workspaceName = data.preview.draft?.name ?? data.preview.live?.name ?? data.character.name;
  const writesLocked = mutationNotice !== null ||
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
      <Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/characters">
        <ArrowLeft className="h-4 w-4" />  {t("Portfolio")}
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Character Project ·")} {data.project.id}</p>
          <h2 className="mt-1 text-2xl font-semibold" id="character-workspace-title">{workspaceName}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusBadge value={data.project.phase} />
            <StatusBadge value={data.serving?.state ?? "inactive"} />
            <StatusBadge value={data.character.visibility} />
          </div>
        </div>
        <p className="text-xs text-[var(--ad-text-muted)]">{t("Project v")}{data.project.version}  {t("· Serving v")}{data.serving?.version ?? 0}</p>
      </div>
      {error ? (
        <p className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
          {error} <button className="ml-2 underline" onClick={() => void load().catch(() => undefined)} type="button">{t("Retry workspace")}</button>
        </p>
      ) : null}
      {commandRecoveryError ? (
        <p className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" role="alert">
          {commandRecoveryError}
        </p>
      ) : null}
      {mutationNotice ? (
        <div
          className={cn(
            "mt-4 rounded-lg p-3 text-sm",
            ["command_pending", "command_submission_unknown", "mutation_in_flight"].includes(mutationNotice.kind)
              ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
              : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
          )}
          role="status"
        >
          <p>{mutationNotice.message}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {mutationNotice.kind === "refresh_required" ? (
              <button className="font-semibold underline" onClick={() => void refreshAuthoritativeWorkspace()} type="button">

                {t("Refresh authoritative workspace")}
              </button>
            ) : null}
            {mutationNotice.kind === "command_reconfirmation_required" && pendingCommand ? (
              <button className="font-semibold underline" onClick={authorizePendingCommandReplay} type="button">

                {t("Review and resume saved command")}
              </button>
            ) : null}
            {"commandId" in mutationNotice && mutationNotice.commandId ? (
              <Link className="font-semibold underline" href={`/admin/system/audit?commandId=${encodeURIComponent(mutationNotice.commandId)}`}>

                {t("Open command evidence")}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--ad-border)]" role="tablist" aria-label={t("Character workspace")}>
        {characterWorkspaceTabs.map((item, index) => (
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
            {item}
          </button>
        ))}
      </div>
      <div className="mt-5" id={`character-panel-${tab}`} role="tabpanel" aria-labelledby={`character-tab-${tab}`}>
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
        ) : tab === "preview" ? (
          <PreviewDiff data={data} permissions={guardedPermissions} runCommittedMutation={runCommittedMutation} />
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
        ) : tab === "monitor" ? (
          <MonitorPanel
            data={data}
            onOpenVisual={() => selectTab("visual")}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : (
          <PerformancePanel data={data} permissions={guardedPermissions} runCommittedMutation={runCommittedMutation} />
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
  return view.kind === "detail"
    ? <CharacterDetail actorId={actorId} id={view.id} key={`${actorId}:${view.id}`} permissions={permissions} />
    : (
        <CharacterPortfolio
          canOpenAssets={permissions.readAssets}
          canCreate={permissions.writeProject}
          canOpenProjects={permissions.read}
          canRead={permissions.read}
          mode="studio"
        />
      );
}

export function CharacterPerformanceWorkspace({ canOpenProjects, canRead }: { canOpenProjects: boolean; canRead: boolean }) {
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
