import { describe, expect, it } from "vitest";
import {
  beginDurableMutationIntent,
  claimDurableMutationIntent,
  clearDurableMutationIntent,
  durableMutationIntentStorageKey,
  readActiveDurableMutationIntent,
  readDurableMutationIntent,
  updateDurableMutationIntent,
} from "./durable-mutation-intent";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("durable mutation intent journal", () => {
  it("persists before submission and reuses the same key after an unknown outcome", () => {
    const storage = memoryStorage();
    const first = beginDurableMutationIntent({
      scope: "creative-run:create",
      signature: '{"brief":"portrait"}',
      storage,
      now: 100,
      createIdempotencyKey: () => "intent-key-123",
      requestSnapshot: { brief: "portrait", count: 4 },
    });
    expect(JSON.parse(
      storage.getItem(durableMutationIntentStorageKey(
        first.scope,
        first.signature,
      )) ?? "",
    )).toMatchObject({
      status: "submitting",
      idempotencyKey: "intent-key-123",
    });
    updateDurableMutationIntent(first, {
      status: "outcome_unknown",
      storage,
      now: 200,
    });

    const replay = beginDurableMutationIntent({
      scope: first.scope,
      signature: first.signature,
      storage,
      now: 300,
      createIdempotencyKey: () => "must-not-rotate",
    });
    expect(replay.idempotencyKey).toBe("intent-key-123");
    expect(replay.status).toBe("submitting");
    expect(readActiveDurableMutationIntent({
      scope: first.scope,
      storage,
      now: 300,
    })).toMatchObject({
      idempotencyKey: "intent-key-123",
      requestSnapshot: { brief: "portrait", count: 4 },
    });
  });

  it("keeps a committed receipt until projection success and then rotates", () => {
    const storage = memoryStorage();
    const first = beginDurableMutationIntent({
      scope: "character:one:create",
      signature: "cover-v1",
      storage,
      now: 100,
      createIdempotencyKey: () => "intent-key-456",
    });
    const committed = updateDurableMutationIntent(first, {
      status: "committed_projection_pending",
      committedTargetId: "run-1",
      storage,
      now: 200,
    });
    expect(readDurableMutationIntent({
      scope: first.scope,
      signature: first.signature,
      storage,
      now: 300,
    })).toEqual(committed);

    clearDurableMutationIntent(committed, storage);
    expect(readActiveDurableMutationIntent({
      scope: first.scope,
      storage,
      now: 350,
    })).toBeNull();
    const next = beginDurableMutationIntent({
      scope: first.scope,
      signature: first.signature,
      storage,
      now: 400,
      createIdempotencyKey: () => "intent-key-789",
    });
    expect(next.idempotencyKey).toBe("intent-key-789");
  });

  it("rejects malformed entries but retains expired receipts for server reconciliation", () => {
    const storage = memoryStorage();
    const scope = "creative-run:create";
    const signature = "brief-v1";
    const key = durableMutationIntentStorageKey(scope, signature);
    storage.setItem(key, JSON.stringify({
      version: 1,
      scope,
      signature: "different",
      idempotencyKey: "intent-key-123",
      status: "submitting",
      createdAt: 100,
      updatedAt: 100,
    }));
    expect(readDurableMutationIntent({
      scope,
      signature,
      storage,
      now: 200,
    })).toBeNull();
    expect(storage.getItem(key)).toBeNull();

    const expired = beginDurableMutationIntent({
      scope,
      signature,
      storage,
      now: 100,
      createIdempotencyKey: () => "intent-key-expired",
    });
    expect(readDurableMutationIntent({
      scope: expired.scope,
      signature: expired.signature,
      storage,
      now: 100 + 24 * 60 * 60 * 1_000 + 1,
    })).toMatchObject({
      idempotencyKey: "intent-key-expired",
      status: "reconciliation_required",
    });
    expect(readActiveDurableMutationIntent({
      scope,
      storage,
      now: 100 + 24 * 60 * 60 * 1_000 + 1,
    })).toMatchObject({
      idempotencyKey: "intent-key-expired",
      status: "reconciliation_required",
    });
  });

  it("retains the receipt key when a legacy snapshot is too large to replay", () => {
    const storage = memoryStorage();
    const intent = beginDurableMutationIntent({
      scope: "character-asset:review:operator-a:character-a",
      signature: "review-v1",
      storage,
      now: 100,
      createIdempotencyKey: () => "intent-key-oversized",
      requestSnapshot: { decision: "approved" },
    });
    const key = durableMutationIntentStorageKey(
      intent.scope,
      intent.signature,
    );
    storage.setItem(key, JSON.stringify({
      ...intent,
      requestSnapshot: Array.from(
        { length: 257 },
        (_, index) => index,
      ),
    }));

    const recovered = readDurableMutationIntent({
      scope: intent.scope,
      signature: intent.signature,
      storage,
      now: 200,
    });
    expect(recovered).toMatchObject({
      version: 1,
      scope: intent.scope,
      signature: intent.signature,
      idempotencyKey: "intent-key-oversized",
      status: "reconciliation_required",
      createdAt: 100,
      updatedAt: 100,
    });
    expect(recovered).not.toHaveProperty("requestSnapshot");
    expect(storage.getItem(key)).not.toBeNull();
    expect(readActiveDurableMutationIntent({
      scope: intent.scope,
      storage,
      now: 200,
    })).toMatchObject({
      idempotencyKey: "intent-key-oversized",
      status: "reconciliation_required",
    });
  });

  it("serializes same-scope claims so another tab cannot overwrite an undiscovered intent", async () => {
    const storage = memoryStorage();
    let queue = Promise.resolve();
    const lockManager = {
      request<T>(
        _name: string,
        callback: () => Promise<T> | T,
      ) {
        const result = queue.then(callback);
        queue = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    const [first, second] = await Promise.all([
      claimDurableMutationIntent({
        scope: "creative-run:create:operator-a",
        signature: "campaign-a",
        storage,
        lockManager,
        createIdempotencyKey: () => "intent-key-first",
        requestSnapshot: { brief: "first" },
      }),
      claimDurableMutationIntent({
        scope: "creative-run:create:operator-a",
        signature: "campaign-b",
        storage,
        lockManager,
        createIdempotencyKey: () => "intent-key-second",
        requestSnapshot: { brief: "second" },
      }),
    ]);
    expect(first).toMatchObject({
      created: true,
      intent: {
        signature: "campaign-a",
        idempotencyKey: "intent-key-first",
      },
    });
    expect(second).toMatchObject({
      created: false,
      intent: {
        signature: "campaign-a",
        idempotencyKey: "intent-key-first",
      },
    });
    expect(readActiveDurableMutationIntent({
      scope: "creative-run:create:operator-a",
      storage,
    })?.requestSnapshot).toEqual({ brief: "first" });
  });
});
