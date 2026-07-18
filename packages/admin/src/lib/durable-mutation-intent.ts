export type DurableMutationIntentStatus =
  | "submitting"
  | "outcome_unknown"
  | "committed_projection_pending"
  | "reconciliation_required";

export type DurableMutationIntent = {
  readonly version: 1;
  readonly scope: string;
  readonly signature: string;
  readonly idempotencyKey: string;
  readonly status: DurableMutationIntentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly committedTargetId?: string;
  readonly requestSnapshot?: unknown;
};

type MutationIntentStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type MutationIntentLockManager = {
  request<T>(
    name: string,
    callback: () => Promise<T> | T,
  ): Promise<T>;
};

export type DurableMutationIntentClaim = {
  readonly intent: DurableMutationIntent;
  readonly created: boolean;
};

const mutationIntentPrefix = "idream:admin:mutation-intent:v1";
const activeMutationIntentPrefix =
  "idream:admin:mutation-intent-active:v1";
const mutationIntentLifetimeMs = 24 * 60 * 60 * 1_000;

function browserStorage(): MutationIntentStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function durableMutationIntentStorageKey(
  scope: string,
  signature: string,
) {
  return `${mutationIntentPrefix}:${encodeURIComponent(scope)}:${encodeURIComponent(signature)}`;
}

export function activeDurableMutationIntentStorageKey(scope: string) {
  return `${activeMutationIntentPrefix}:${encodeURIComponent(scope)}`;
}

function isJsonSnapshot(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 256 &&
      value.every((item) => isJsonSnapshot(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 256 &&
    entries.every(
      ([key, item]) =>
        key.length <= 256 && isJsonSnapshot(item, depth + 1),
    );
}

function parseDurableMutationIntent(
  raw: string,
  expected: {
    readonly scope: string;
    readonly signature: string;
    readonly now: number;
  },
): DurableMutationIntent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.scope !== expected.scope ||
      value.signature !== expected.signature ||
      typeof value.idempotencyKey !== "string" ||
      value.idempotencyKey.length < 8 ||
      ![
        "submitting",
        "outcome_unknown",
        "committed_projection_pending",
        "reconciliation_required",
      ].includes(String(value.status)) ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt) ||
      value.createdAt - expected.now > 60_000 ||
      (
        value.committedTargetId !== undefined &&
        typeof value.committedTargetId !== "string"
      )
    ) {
      return null;
    }
    const snapshotIsUsable =
      value.requestSnapshot === undefined ||
      isJsonSnapshot(value.requestSnapshot);
    const status =
      (
        expected.now - value.createdAt > mutationIntentLifetimeMs ||
        !snapshotIsUsable
      )
        ? "reconciliation_required"
        : value.status as DurableMutationIntentStatus;
    return {
      version: 1,
      scope: value.scope,
      signature: value.signature,
      idempotencyKey: value.idempotencyKey,
      status,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(typeof value.committedTargetId === "string"
        ? { committedTargetId: value.committedTargetId }
        : {}),
      ...(value.requestSnapshot === undefined || !snapshotIsUsable
        ? {}
        : { requestSnapshot: value.requestSnapshot }),
    };
  } catch {
    return null;
  }
}

export function readDurableMutationIntent(input: {
  readonly scope: string;
  readonly signature: string;
  readonly storage?: MutationIntentStorage | null;
  readonly now?: number;
}) {
  const storage = input.storage ?? browserStorage();
  if (!storage) return null;
  const key = durableMutationIntentStorageKey(
    input.scope,
    input.signature,
  );
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = parseDurableMutationIntent(raw, {
      scope: input.scope,
      signature: input.signature,
      now: input.now ?? Date.now(),
    });
    if (!parsed) storage.removeItem(key);
    return parsed;
  } catch {
    return null;
  }
}

export function readActiveDurableMutationIntent(input: {
  readonly scope: string;
  readonly storage?: MutationIntentStorage | null;
  readonly now?: number;
}) {
  const storage = input.storage ?? browserStorage();
  if (!storage) return null;
  const activeKey = activeDurableMutationIntentStorageKey(input.scope);
  try {
    const raw = storage.getItem(activeKey);
    if (!raw) return null;
    const pointer = JSON.parse(raw) as Record<string, unknown>;
    if (
      pointer.version !== 1 ||
      pointer.scope !== input.scope ||
      typeof pointer.signature !== "string" ||
      typeof pointer.idempotencyKey !== "string"
    ) {
      storage.removeItem(activeKey);
      return null;
    }
    const intent = readDurableMutationIntent({
      scope: input.scope,
      signature: pointer.signature,
      storage,
      now: input.now,
    });
    if (
      !intent ||
      intent.idempotencyKey !== pointer.idempotencyKey
    ) {
      storage.removeItem(activeKey);
      return null;
    }
    return intent;
  } catch {
    try {
      storage.removeItem(activeKey);
    } catch {
      // Ignore inaccessible browser storage.
    }
    return null;
  }
}

export function beginDurableMutationIntent(input: {
  readonly scope: string;
  readonly signature: string;
  readonly storage?: MutationIntentStorage | null;
  readonly now?: number;
  readonly createIdempotencyKey?: () => string;
  readonly requestSnapshot?: unknown;
}) {
  const storage = input.storage ?? browserStorage();
  const existing = readDurableMutationIntent({
    scope: input.scope,
    signature: input.signature,
    storage,
    now: input.now,
  });
  const now = input.now ?? Date.now();
  const intent: DurableMutationIntent = existing
    ? {
        ...existing,
        status:
          existing.status === "reconciliation_required"
            ? existing.status
            : "submitting",
        updatedAt: now,
        ...(input.requestSnapshot === undefined
          ? {}
          : { requestSnapshot: input.requestSnapshot }),
      }
    : {
        version: 1,
        scope: input.scope,
        signature: input.signature,
        idempotencyKey:
          input.createIdempotencyKey?.() ?? crypto.randomUUID(),
        status: "submitting",
        createdAt: now,
        updatedAt: now,
        ...(input.requestSnapshot === undefined
          ? {}
          : { requestSnapshot: input.requestSnapshot }),
      };
  if (storage) {
    try {
      if (
        intent.requestSnapshot !== undefined &&
        !isJsonSnapshot(intent.requestSnapshot)
      ) {
        throw new Error("Durable mutation snapshot must be JSON data");
      }
      storage.setItem(
        durableMutationIntentStorageKey(
          input.scope,
          input.signature,
        ),
        JSON.stringify(intent),
      );
      storage.setItem(
        activeDurableMutationIntentStorageKey(input.scope),
        JSON.stringify({
          version: 1,
          scope: input.scope,
          signature: input.signature,
          idempotencyKey: intent.idempotencyKey,
        }),
      );
    } catch {
      // The request can still use the in-memory key for this page lifetime.
    }
  }
  return intent;
}

export async function claimDurableMutationIntent(input: {
  readonly scope: string;
  readonly signature: string;
  readonly storage?: MutationIntentStorage | null;
  readonly now?: number;
  readonly createIdempotencyKey?: () => string;
  readonly requestSnapshot?: unknown;
  readonly lockManager?: MutationIntentLockManager | null;
}): Promise<DurableMutationIntentClaim> {
  const storage = input.storage ?? browserStorage();
  const claim = () => {
    const active = readActiveDurableMutationIntent({
      scope: input.scope,
      storage,
      now: input.now,
    });
    if (active) {
      if (
        active.signature === input.signature &&
        ![
          "committed_projection_pending",
          "reconciliation_required",
        ].includes(active.status)
      ) {
        return {
          intent: beginDurableMutationIntent({
            scope: input.scope,
            signature: input.signature,
            storage,
            now: input.now,
            createIdempotencyKey: input.createIdempotencyKey,
            requestSnapshot:
              active.requestSnapshot ?? input.requestSnapshot,
          }),
          created: false,
        };
      }
      return { intent: active, created: false };
    }
    return {
      intent: beginDurableMutationIntent({
        scope: input.scope,
        signature: input.signature,
        storage,
        now: input.now,
        createIdempotencyKey: input.createIdempotencyKey,
        requestSnapshot: input.requestSnapshot,
      }),
      created: true,
    };
  };
  const browserLocks =
    typeof navigator === "undefined"
      ? null
      : (
          navigator as Navigator & {
            readonly locks?: MutationIntentLockManager;
          }
        ).locks ?? null;
  const lockManager =
    input.lockManager === undefined
      ? browserLocks
      : input.lockManager;
  if (!lockManager) return claim();
  return lockManager.request(
    `${mutationIntentPrefix}:claim:${encodeURIComponent(input.scope)}`,
    claim,
  );
}

export function updateDurableMutationIntent(
  intent: DurableMutationIntent,
  update: {
    readonly status: DurableMutationIntentStatus;
    readonly committedTargetId?: string;
    readonly requestSnapshot?: unknown;
    readonly storage?: MutationIntentStorage | null;
    readonly now?: number;
  },
) {
  const storage = update.storage ?? browserStorage();
  const next: DurableMutationIntent = {
    ...intent,
    status: update.status,
    updatedAt: update.now ?? Date.now(),
    ...(update.committedTargetId === undefined
      ? {}
      : { committedTargetId: update.committedTargetId }),
    ...(update.requestSnapshot === undefined
      ? {}
      : { requestSnapshot: update.requestSnapshot }),
  };
  if (storage) {
    try {
      if (
        next.requestSnapshot !== undefined &&
        !isJsonSnapshot(next.requestSnapshot)
      ) {
        throw new Error("Durable mutation snapshot must be JSON data");
      }
      storage.setItem(
        durableMutationIntentStorageKey(
          intent.scope,
          intent.signature,
        ),
        JSON.stringify(next),
      );
    } catch {
      // Keep the current page usable even when browser storage is unavailable.
    }
  }
  return next;
}

export function clearDurableMutationIntent(
  intent: DurableMutationIntent,
  storage: MutationIntentStorage | null = browserStorage(),
) {
  if (!storage) return;
  const key = durableMutationIntentStorageKey(
    intent.scope,
    intent.signature,
  );
  try {
    const current = storage.getItem(key);
    if (!current) return;
    const parsed = parseDurableMutationIntent(current, {
      scope: intent.scope,
      signature: intent.signature,
      now: Date.now(),
    });
    if (
      parsed &&
      parsed.idempotencyKey !== intent.idempotencyKey
    ) {
      return;
    }
    storage.removeItem(key);
    const activeKey = activeDurableMutationIntentStorageKey(
      intent.scope,
    );
    const activeRaw = storage.getItem(activeKey);
    if (activeRaw) {
      const pointer = JSON.parse(activeRaw) as Record<string, unknown>;
      if (
        pointer.signature === intent.signature &&
        pointer.idempotencyKey === intent.idempotencyKey
      ) {
        storage.removeItem(activeKey);
      }
    }
  } catch {
    // A committed server mutation remains authoritative if storage cleanup fails.
  }
}
