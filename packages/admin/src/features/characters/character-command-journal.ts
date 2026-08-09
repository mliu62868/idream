import {
  adminCommandAcceptedSchema,
  adminCommandStatusSchema,
  type AdminCommandStatus,
} from "@idream/shared/admin";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import { adminV2OperationEndpoint } from "@/lib/admin-v2-operation";

/**
 * SPEC: 角色运营台一条**异步 durable command** 的完整可靠性协议 —— 幂等身份、落盘意图、
 *       发出、把服务端反应翻译成写入锁处置、断线后重放、轮询终态、释放。
 * INTENT: 这套协议原本以 17 个自由函数 + 5 份 React 状态副本的形式摊在 CharacterWorkspace.tsx
 *         里，调用方必须自己按正确顺序踩过 localStorage 键、日志序列化、幂等键回收、代际
 *         作废四个子系统才能完成一次写入，且只能靠断言源码文本来守。这里把它收成一个对象：
 *         调用方只表达「开始一个命令 / 命令回来了 / 能不能重放」，其余全部不可见。
 * INTENT: 与 `lib/durable-mutation-intent` 形状相似（都是浏览器落盘的幂等意图），但**判断不同，
 *         不要合并**（ADR-13 §2.3 / §3.2）：那个模块服务于**同步原子 mutation**，恢复手段是
 *         `POST /mutation-receipts/reconcile` 问一张回执，从不重发原请求；这里服务于**异步
 *         durable command**，恢复手段就是拿同一个 Idempotency-Key **重放原 POST**，因此必须
 *         落盘 endpoint + body，也因此必须盖 actor 与 environment 两枚戳 —— 重放会再发一次特权
 *         写入，用别人的日志或别的环境的日志重放是真实事故，读回执则没有这个风险。
 */

export type PendingCharacterCommand = {
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

export type CharacterMutationNotice =
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

/** 一次命令提交的业务意图。幂等身份与落盘时机不由调用方决定。 */
export type CharacterCommandIntent = {
  readonly action: string;
  readonly signature: string;
  readonly endpoint: string;
  readonly body: unknown;
};

/**
 * SPEC: 首发一条命令之后，写入锁该怎么处置。
 * INTENT: `rejected` 之所以能直接解锁，是因为这是该命令的**第一次** POST —— 服务端明确拒绝
 *         即证明它没生效。重放路径没有这个前提，见 `CharacterCommandReplay`。
 */
export type CharacterCommandSubmission =
  | { readonly kind: "accepted"; readonly command: PendingCharacterCommand }
  /** 服务端说另一条命令还活着；日志已改挂到那一条上。 */
  | {
      readonly kind: "attached";
      readonly command: PendingCharacterCommand;
      readonly cause: unknown;
    }
  /** 服务端明确拒绝了这次提交；日志已丢弃、写入已解锁。 */
  | { readonly kind: "rejected"; readonly cause: unknown }
  /** 受理状态不明；日志保留、写入保持锁定，等恢复循环重放。 */
  | { readonly kind: "unknown"; readonly cause: unknown };

/**
 * SPEC: 重放一条受理状态不明的命令之后，写入锁该怎么处置。
 * INVARIANT: 这里**没有** `rejected` —— 重放被拒绝只证明「这一次」没被受理，证明不了原始那次
 *            没生效，所以任何情况下都不许直接解锁，只能等待或交给服务端对账。
 */
export type CharacterCommandReplay =
  | { readonly kind: "accepted"; readonly command: PendingCharacterCommand }
  | {
      readonly kind: "attached";
      readonly command: PendingCharacterCommand;
      readonly cause: unknown;
    }
  /** 自动重放窗口已过；必须由运营重新确认（`authorizeReplay`）才会再发。 */
  | { readonly kind: "window_expired" }
  /** 日志缺 endpoint / body / 幂等键，无法原样重放；只能与服务端对账。 */
  | { readonly kind: "evidence_incomplete" }
  /** 会话或权限不足；原命令可能已存在，保持锁定并继续等。 */
  | {
      readonly kind: "blocked";
      readonly cause: unknown;
      readonly retryInMs: number;
    }
  /** 重放被明确拒绝，但原始受理状态仍未知；交给服务端权威对账。 */
  | { readonly kind: "reconcile"; readonly cause: unknown }
  | {
      readonly kind: "retry";
      readonly cause: unknown;
      readonly retryInMs: number;
    };

/** 轮询一条已知 commandId 的命令之后，恢复循环该怎么走。 */
export type CharacterCommandStatusOutcome =
  | { readonly kind: "running"; readonly retryInMs: number }
  | {
      readonly kind: "settled";
      readonly status: AdminCommandStatus["status"];
      readonly succeeded: boolean;
    }
  /** 命令证据 404；服务端必须先证明没有命令还活着。 */
  | { readonly kind: "evidence_missing" }
  | {
      readonly kind: "blocked";
      readonly cause: unknown;
      readonly retryInMs: number;
    }
  | {
      readonly kind: "unavailable";
      readonly cause: unknown;
      readonly retryInMs: number;
    };

/** refresh 只关心权威投影里「还有没有命令活着」，不关心投影的其余部分。 */
export type CharacterCommandAuthoritySnapshot = {
  readonly activeCommand: AdminCommandStatus | null;
};

export type CharacterMutationRefreshResult<
  T extends CharacterCommandAuthoritySnapshot,
> =
  | {
      readonly status: "superseded";
      readonly projection?: T;
      readonly error?: unknown;
    }
  | { readonly status: "failed"; readonly error: unknown }
  /** 服务端仍有命令在跑；日志已改挂到它上面，写入保持锁定。 */
  | { readonly status: "kept_locked"; readonly projection: T }
  | {
      readonly status: "cleanup_failed";
      readonly projection: T;
      readonly error: unknown;
    }
  | { readonly status: "unlocked"; readonly projection: T };

export type CharacterCommandJournalSnapshot = {
  readonly command: PendingCharacterCommand | null;
  readonly notice: CharacterMutationNotice | null;
  /**
   * 恢复循环的旁注。
   * INVARIANT: 由 journal 拥有而不是调用方，因为它必须在「换了一条命令」时清零——散在
   *            8 个调用点上时，只要有一个忘了清，运营就会看着一条已经不存在的命令的告警
   *            去处理另一条命令。
   */
  readonly recoveryError: string | null;
  readonly writesLocked: boolean;
};

type CharacterCommandStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION = 1;
const UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS = 5 * 60_000;

// SPEC: 恢复循环的四档节奏。首轮延迟见 `initialRecoveryDelayMs`。
// INTENT: 档位是有意的运营体验设计——刚提交时快速轮询让操作员立刻看到结果，局面稳定
//         （或权限受阻）后放慢。它们跟着协议走而不是跟着组件走：`blocked` 必须返回一个
//         间隔而不是 null，因为「受理状态不明」永远不许放弃。
const COMMAND_STATUS_POLL_MS = 1_000;
const COMMAND_REPLAY_RETRY_MS = 2_000;
const COMMAND_BLOCKED_RETRY_MS = 5_000;
const ACCEPTED_COMMAND_FIRST_POLL_MS = 500;
const UNKNOWN_COMMAND_MIN_FIRST_POLL_MS = 250;
const UNKNOWN_COMMAND_ACCEPTANCE_WINDOW_MS = 1_500;

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

/**
 * SPEC: 落盘的命令日志只对「同一套 schema、同一个人、同一个环境」有效，且 createdAt 必须可信。
 * INVARIANT: createdAt 不可信就整条作废，绝不拿当前时间给它续一个新的重放窗口 —— 那等于
 *            每读一次就续一次命，一个受理状态不明的命令能被无限重放。
 */
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

/**
 * SPEC: 已知 commandId 的命令永远可以继续（它的受理状态是可查的）；受理状态不明的命令
 *       只在自创建起算的窗口内自动重放。
 */
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

export function committedCharacterProjectionWarning(
  action: string,
  cause: unknown,
) {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return `${action} was committed, but the authoritative Character workspace could not be refreshed${detail}. Refresh the authoritative workspace before another write.`;
}

function characterCommandActionLabel(commandType: string) {
  return commandType
    .replace(/^character\./, "")
    .replaceAll(".", " ")
    .replaceAll("_", " ");
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

function isDefinitiveCommandRejection(cause: unknown) {
  return (
    cause instanceof AdminV2RequestError &&
    [400, 401, 403, 404, 409, 422].includes(cause.status)
  );
}

/**
 * SPEC: 重放失败的三种处置。
 * INTENT: 与首发路径的 `isDefinitiveCommandRejection` 覆盖同一批状态码却给出不同答案，这是
 *         有意的：首发被 4xx 拒绝可以解锁（那次 POST 确定没生效），重放被 4xx 拒绝不能解锁
 *         （原始那次的命运仍然未知）。401/403 连「被拒绝」都算不上——那是我们没资格问。
 */
function characterCommandReplayFailureDisposition(
  status: number | null,
): "keep_locked" | "reconcile" | "retry" {
  if (status === 401 || status === 403) return "keep_locked";
  if (status !== null && [400, 404, 409, 422].includes(status)) {
    return "reconcile";
  }
  return "retry";
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

export type CharacterCommandJournal = {
  /** React 订阅接口；与 `getSnapshot` 一起喂 useSyncExternalStore。 */
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => CharacterCommandJournalSnapshot;

  /**
   * 只读地问「有没有一条落盘的待决命令」。
   * INTENT: 首屏要据此直接落在 release 页签上，而首屏渲染期不许有副作用——`restore` 会
   *         上锁并通知订阅者，不能在 useState 初始化里调用。
   */
  readonly hasPersistedCommand: () => boolean;
  /** 挂载或跨标签页写入后，把落盘的待决命令读回来并重新锁定写入。 */
  readonly restore: () => PendingCharacterCommand | null;
  /** 这个 storage 事件是否动了本角色本操作员的待决命令槽。 */
  readonly ownsStorageEvent: (event: StorageEvent) => boolean;

  /** 抢写入锁。已有命令或通知在身时返回 false —— 调用方不得越过它提交。 */
  readonly beginSubmission: (message: string) => boolean;
  /** 还没落盘就失败了：放弃这次抢锁。 */
  readonly abortSubmission: () => void;

  /** 落盘意图 → POST → 归类。落盘一定发生在 POST 之前。 */
  readonly submit: (
    intent: CharacterCommandIntent,
  ) => Promise<CharacterCommandSubmission>;
  /** 拿同一个幂等键重放一条已落盘的命令；先判断能不能重放。 */
  readonly replay: (
    command: PendingCharacterCommand,
  ) => Promise<CharacterCommandReplay>;
  /** 查一条已知 commandId 的命令是否已终结。 */
  readonly pollStatus: (
    command: PendingCharacterCommand,
  ) => Promise<CharacterCommandStatusOutcome>;
  /** 本轮恢复轮询的首轮延迟：受理状态不明时先等满命令的最短受理窗口。 */
  readonly initialRecoveryDelayMs: (
    command: PendingCharacterCommand,
  ) => number;

  /** 服务端权威说这条命令还活着：日志改挂到它上面。 */
  readonly attachAuthorityCommand: (
    active: AdminCommandStatus,
  ) => PendingCharacterCommand;
  /** 运营显式重新授权一条已过期的未知命令，重开重放窗口。 */
  readonly authorizeReplay: () => PendingCharacterCommand | null;
  /** 释放这条命令的日志、幂等键与写入锁。身份对不上时什么都不做并返回 false。 */
  readonly discard: (command: PendingCharacterCommand) => boolean;
  /** 读一份权威投影确认没有命令还活着，据此决定解锁还是继续锁。 */
  readonly refresh: <T extends CharacterCommandAuthoritySnapshot>(input: {
    readonly load: () => Promise<T>;
    readonly onUnlock?: () => void;
    readonly reusePendingCleanup?: boolean;
  }) => Promise<CharacterMutationRefreshResult<T>>;
  /** 当前命令是否仍是它 —— 跨 await 的调用方据此判断自己有没有被取代。 */
  readonly currentCommandIs: (command: PendingCharacterCommand) => boolean;
  readonly getGeneration: () => number;
  readonly isCurrentGeneration: (candidate: number) => boolean;
  readonly setNotice: (notice: CharacterMutationNotice | null) => void;
  readonly setRecoveryError: (message: string | null) => void;
  /**
   * 同一 (操作员, 角色) 下按业务签名稳定的幂等键，跨刷新存活。
   * INTENT: 同步原子 mutation（如 Voice request reclaim）也需要它——它们不落命令日志，
   *         但重试时必须复用同一个键，否则一次网络抖动就变成第二次写入。
   */
  readonly takeIdempotencyKey: (signature: string) => string;
  readonly releaseIdempotencyKey: (signature: string) => void;
};

/**
 * SPEC: 一个 (操作员, 角色) 对应一个 journal。它同时拥有内存代际、落盘日志与幂等键，
 *       因为这三者必须一起推进 —— 分开时调用方要按正确顺序连踩四个子系统才算完成一次写入。
 */
export function createCharacterCommandJournal(options: {
  readonly actorId: string;
  readonly characterId: string;
  readonly storage?: CharacterCommandStorage | null;
  readonly environment?: string;
  readonly now?: () => number;
  readonly createIdempotencyKey?: () => string;
  readonly request?: typeof adminV2Request;
}): CharacterCommandJournal {
  const { actorId, characterId } = options;
  const now = options.now ?? (() => Date.now());
  const createKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
  const request = options.request ?? adminV2Request;
  const environment =
    options.environment ??
    (typeof window === "undefined" ? "" : window.location.origin);
  const openStorage = () =>
    options.storage === undefined
      ? browserCharacterCommandStorage()
      : options.storage;

  const idempotencyStorageKey = `idream:admin:character:${encodeURIComponent(actorId)}:${encodeURIComponent(characterId)}:command-idempotency`;
  const pendingStorageKey = `idream:admin:character:${encodeURIComponent(actorId)}:${encodeURIComponent(characterId)}:pending-command`;

  // INTENT: 浏览器存储不可用（无痕 / 配额满）时仍要保证同一次会话内幂等键稳定，否则
  //         一次重试就会变成第二条命令。
  const memoryIdempotencyKeys: Record<string, string> = {};

  let generation = 0;
  let command: PendingCharacterCommand | null = null;
  let notice: CharacterMutationNotice | null = null;
  let recoveryError: string | null = null;
  let snapshot: CharacterCommandJournalSnapshot = {
    command: null,
    notice: null,
    recoveryError: null,
    writesLocked: false,
  };
  let pendingCleanup: {
    readonly generation: number;
    readonly cleanup: (() => void) | null;
  } | null = null;
  const listeners = new Set<() => void>();

  // INVARIANT: getSnapshot 必须返回稳定引用，只在状态真的变化时换新对象——
  //            useSyncExternalStore 靠引用判等，每次新建会无限重渲染。
  const publish = () => {
    if (
      snapshot.command === command &&
      snapshot.notice === notice &&
      snapshot.recoveryError === recoveryError
    )
      return;
    snapshot = {
      command,
      notice,
      recoveryError,
      writesLocked: command !== null || notice !== null,
    };
    for (const listener of listeners) listener();
  };

  const advanceGeneration = () => {
    generation += 1;
    pendingCleanup = null;
    return generation;
  };

  const noticeForCommand = (
    next: PendingCharacterCommand,
  ): CharacterMutationNotice =>
    next.commandId
      ? {
          kind: "command_pending",
          message: `${next.action} command is pending. Character writes stay locked until the worker records a terminal result and the workspace refreshes.`,
          commandId: next.commandId,
        }
      : {
          kind: "command_submission_unknown",
          message: `${next.action} may already be accepted. The exact command is being replayed with the same idempotency key before any other Character write is allowed.`,
        };

  const persist = (next: PendingCharacterCommand) => {
    const storage = openStorage();
    if (!storage) return;
    try {
      storage.setItem(
        pendingStorageKey,
        JSON.stringify({
          schemaVersion: CHARACTER_COMMAND_JOURNAL_SCHEMA_VERSION,
          actorId,
          environment,
          commandId: next.commandId,
          action: next.action,
          signature: next.signature,
          endpoint: next.endpoint,
          body: next.body,
          idempotencyKey: next.idempotencyKey,
          createdAt: next.createdAt,
          autoReplayUntil:
            next.autoReplayUntil ??
            next.createdAt + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS,
        }),
      );
    } catch {
      // The current page still keeps the command locked and polling.
    }
  };

  const remember = (next: PendingCharacterCommand) => {
    if (!command || !isSamePendingCharacterCommand(command, next)) {
      advanceGeneration();
    }
    command = next;
    notice = noticeForCommand(next);
    recoveryError = null;
    persist(next);
    publish();
    return next;
  };

  const markTerminal = (target: PendingCharacterCommand) => {
    if (!command || !isSamePendingCharacterCommand(command, target)) return;
    command = { ...command, terminal: true };
    publish();
  };

  const takeIdempotencyKey = (signature: string) => {
    const inMemory = memoryIdempotencyKeys[signature];
    const storage = openStorage();
    if (!storage) {
      const key = inMemory ?? createKey();
      memoryIdempotencyKeys[signature] = key;
      return key;
    }
    const identities = readStoredStringRecord(storage, idempotencyStorageKey);
    const existing = identities[signature];
    const key = existing ?? inMemory ?? createKey();
    memoryIdempotencyKeys[signature] = key;
    if (existing) return key;
    try {
      storage.setItem(
        idempotencyStorageKey,
        JSON.stringify({ ...identities, [signature]: key }),
      );
    } catch {
      // The in-memory key still protects the current page.
    }
    return key;
  };

  const releaseIdempotencyKey = (signature: string) => {
    delete memoryIdempotencyKeys[signature];
    const storage = openStorage();
    if (!storage) return;
    const identities = readStoredStringRecord(storage, idempotencyStorageKey);
    if (!Object.hasOwn(identities, signature)) return;
    delete identities[signature];
    try {
      if (Object.keys(identities).length === 0)
        storage.removeItem(idempotencyStorageKey);
      else
        storage.setItem(idempotencyStorageKey, JSON.stringify(identities));
    } catch {
      // A storage failure must not turn a terminal command into a UI failure.
    }
  };

  const readPersisted = () => {
    const storage = openStorage();
    if (!storage) return null;
    try {
      const raw = storage.getItem(pendingStorageKey);
      return raw
        ? parsePendingCharacterCommandJournal(raw, actorId, environment)
        : null;
    } catch {
      return null;
    }
  };

  const clearPersisted = (target: PendingCharacterCommand) => {
    const storage = openStorage();
    if (!storage) return true;
    try {
      const raw = storage.getItem(pendingStorageKey);
      if (raw) {
        const stored = parsePendingCharacterCommandJournal(
          raw,
          actorId,
          environment,
        );
        if (stored && !isSamePendingCharacterCommand(stored, target))
          return false;
      }
      storage.removeItem(pendingStorageKey);
      return true;
    } catch {
      // Terminal state is authoritative even when browser storage is unavailable.
      return true;
    }
  };

  /**
   * SPEC: 发出（或重放）一条**已落盘**的命令，只回答「受理了 / 挂到别人身上了 / 出错了」。
   * INVARIANT: 调用它之前 `submitted` 必须已经写进日志——「先发后记」会在断网时留下一个
   *            既没记录、又可能已生效的写入。
   */
  const sendCommand = async (submitted: PendingCharacterCommand) => {
    try {
      const accepted = await request(submitted.endpoint!, {
        method: "POST",
        idempotencyKey: submitted.idempotencyKey!,
        schema: adminCommandAcceptedSchema,
        body: submitted.body,
      });
      return {
        kind: "accepted" as const,
        command: remember({ ...submitted, commandId: accepted.commandId }),
      };
    } catch (cause) {
      const conflict = activeCommandConflict(cause);
      if (conflict) {
        return {
          kind: "attached" as const,
          command: remember({
            commandId: conflict.commandId,
            action: characterCommandActionLabel(conflict.commandType),
            signature: `authority:${conflict.commandId}`,
            createdAt: now(),
            terminal: false,
          }),
          cause,
        };
      }
      return { kind: "failed" as const, cause };
    }
  };

  const discard = (target: PendingCharacterCommand) => {
    if (!command || !isSamePendingCharacterCommand(command, target))
      return false;
    if (!clearPersisted(target)) return false;
    advanceGeneration();
    command = null;
    notice = null;
    releaseIdempotencyKey(target.signature);
    publish();
    return true;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    hasPersistedCommand: () => readPersisted() !== null,
    restore() {
      const stored = readPersisted();
      return stored ? remember(stored) : null;
    },
    ownsStorageEvent: (event) => event.key === pendingStorageKey,
    beginSubmission(message) {
      if (command || notice) return false;
      advanceGeneration();
      notice = { kind: "mutation_in_flight", message };
      publish();
      return true;
    },
    abortSubmission() {
      if (notice?.kind !== "mutation_in_flight") return;
      advanceGeneration();
      notice = null;
      publish();
    },
    async submit(intent) {
      const submitted = remember({
        commandId: null,
        action: intent.action,
        signature: intent.signature,
        endpoint: intent.endpoint,
        body: intent.body,
        idempotencyKey: takeIdempotencyKey(intent.signature),
        createdAt: now(),
        terminal: false,
      });
      const sent = await sendCommand(submitted);
      if (sent.kind !== "failed") return sent;
      // SPEC: 首发被服务端明确拒绝 = 这条命令确定没生效，可以解锁重来。
      if (isDefinitiveCommandRejection(sent.cause)) {
        discard(submitted);
        return { kind: "rejected", cause: sent.cause };
      }
      return { kind: "unknown", cause: sent.cause };
    },
    async replay(target) {
      if (!characterCommandJournalCanAutoReplay(target, now())) {
        notice = {
          kind: "command_reconfirmation_required",
          message: `${target.action} was saved before acceptance could be proven, but the automatic replay window expired. Review the action and explicitly resume it; no old command will run automatically.`,
        };
        publish();
        return { kind: "window_expired" };
      }
      if (!target.endpoint || target.body === undefined || !target.idempotencyKey) {
        markTerminal(target);
        return { kind: "evidence_incomplete" };
      }
      const sent = await sendCommand(target);
      if (sent.kind !== "failed") return sent;
      const disposition = characterCommandReplayFailureDisposition(
        sent.cause instanceof AdminV2RequestError ? sent.cause.status : null,
      );
      if (disposition === "keep_locked") {
        return {
          kind: "blocked",
          cause: sent.cause,
          retryInMs: COMMAND_BLOCKED_RETRY_MS,
        };
      }
      if (disposition === "reconcile") {
        return { kind: "reconcile", cause: sent.cause };
      }
      return {
        kind: "retry",
        cause: sent.cause,
        retryInMs: COMMAND_REPLAY_RETRY_MS,
      };
    },
    async pollStatus(target) {
      try {
        const status = await request<AdminCommandStatus>(
          adminV2OperationEndpoint("GET /api/v2/admin/commands/:commandId", {
            commandId: target.commandId!,
          }),
          { schema: adminCommandStatusSchema },
        );
        if (!["failed", "cancelled", "succeeded"].includes(status.status)) {
          return { kind: "running", retryInMs: COMMAND_STATUS_POLL_MS };
        }
        markTerminal(target);
        return {
          kind: "settled",
          status: status.status,
          succeeded: status.status === "succeeded",
        };
      } catch (cause) {
        if (cause instanceof AdminV2RequestError && cause.status === 404) {
          markTerminal(target);
          return { kind: "evidence_missing" };
        }
        if (
          cause instanceof AdminV2RequestError &&
          [401, 403].includes(cause.status)
        ) {
          return {
            kind: "blocked",
            cause,
            retryInMs: COMMAND_BLOCKED_RETRY_MS,
          };
        }
        return { kind: "unavailable", cause, retryInMs: COMMAND_STATUS_POLL_MS };
      }
    },
    initialRecoveryDelayMs: (target) =>
      target.commandId
        ? ACCEPTED_COMMAND_FIRST_POLL_MS
        : Math.max(
            UNKNOWN_COMMAND_MIN_FIRST_POLL_MS,
            target.createdAt + UNKNOWN_COMMAND_ACCEPTANCE_WINDOW_MS - now(),
          ),
    attachAuthorityCommand: (active) => remember(pendingCommandFromAuthority(active)),
    authorizeReplay() {
      if (!command || command.commandId) return null;
      const stamp = now();
      advanceGeneration();
      return remember({
        ...command,
        createdAt: stamp,
        autoReplayUntil: stamp + UNKNOWN_COMMAND_AUTO_REPLAY_TTL_MS,
      });
    },
    discard,
    async refresh<T extends CharacterCommandAuthoritySnapshot>(input: {
      readonly load: () => Promise<T>;
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
      if (projection.activeCommand !== null) {
        pendingCleanup = null;
        // SPEC: 服务端还有命令在跑就把日志改挂到它上面，而不是留着调用方自己的那条。
        remember(pendingCommandFromAuthority(projection.activeCommand));
        return { status: "kept_locked", projection };
      }
      const cleanup =
        pendingCleanup?.generation === refreshGeneration
          ? pendingCleanup.cleanup
          : null;
      pendingCleanup = null;
      notice = null;
      publish();
      try {
        cleanup?.();
      } catch (error) {
        return { status: "cleanup_failed", projection, error };
      }
      return { status: "unlocked", projection };
    },
    currentCommandIs: (target) =>
      command !== null && isSamePendingCharacterCommand(command, target),
    getGeneration: () => generation,
    isCurrentGeneration: (candidate) => generation === candidate,
    setNotice(next) {
      notice = next;
      publish();
    },
    setRecoveryError(message) {
      recoveryError = message;
      publish();
    },
    takeIdempotencyKey,
    releaseIdempotencyKey,
  };
}
