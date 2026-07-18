import { describe, expect, it } from "vitest";
import {
  CHECKOUT_INTENT_TTL_MS,
  checkoutIntentFingerprint,
  checkoutIntentStorageKey,
  createPendingCheckoutIntent,
  readPendingCheckoutIntents,
  removePendingCheckoutIntent,
  shouldRemovePendingCheckoutIntent,
  upsertPendingCheckoutIntent,
  writePendingCheckoutIntents,
  type PendingCheckoutIntent,
} from "./billing-checkout-intent";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    values,
  };
}

function intent(
  overrides: Partial<PendingCheckoutIntent> = {},
): PendingCheckoutIntent {
  const input = {
    planId: "plan-1",
    autoConfirm: false,
    returnPath: "/generate",
  };
  return {
    version: 1,
    fingerprint: checkoutIntentFingerprint(input),
    idempotencyKey: "checkout-key-1",
    ...input,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("viewer-scoped checkout intent storage", () => {
  it("creates a canonical intent before any checkout request is sent", () => {
    expect(
      createPendingCheckoutIntent(
        {
          planId: "plan-1",
          autoConfirm: false,
          returnPath: "/generate",
        },
        "checkout-key-1",
        1_000,
      ),
    ).toEqual(intent());
  });

  it("survives a reload and remains isolated by viewer id", () => {
    const storage = memoryStorage();
    writePendingCheckoutIntents(storage, "user-a", [intent()]);

    expect(readPendingCheckoutIntents(storage, "user-a", 2_000)).toEqual([
      intent(),
    ]);
    expect(readPendingCheckoutIntents(storage, "user-b", 2_000)).toEqual([]);
    expect(checkoutIntentStorageKey("user-a")).not.toBe(
      checkoutIntentStorageKey("user-b"),
    );
  });

  it("retains provider URLs while upserting and removes only the matching intent", () => {
    const first = intent();
    const continued = {
      ...first,
      checkoutUrl: "https://payments.example.com/invoice/1",
    };
    const second = intent({
      fingerprint: "second",
      idempotencyKey: "checkout-key-2",
      planId: "plan-2",
    });
    const updated = upsertPendingCheckoutIntent([first, second], continued);

    expect(updated).toContainEqual(continued);
    expect(removePendingCheckoutIntent(updated, first.fingerprint)).toEqual([
      second,
    ]);
  });

  it("rejects malformed, unsafe, oversized, and expired browser state", () => {
    const storage = memoryStorage();
    storage.setItem(
      checkoutIntentStorageKey("user-a"),
      JSON.stringify([
        intent({ checkoutUrl: "javascript:alert(1)" }),
      ]),
    );
    expect(readPendingCheckoutIntents(storage, "user-a", 2_000)).toEqual([]);

    storage.setItem(checkoutIntentStorageKey("user-a"), "x".repeat(100_001));
    expect(readPendingCheckoutIntents(storage, "user-a", 2_000)).toEqual([]);

    writePendingCheckoutIntents(storage, "user-a", [intent()]);
    expect(
      readPendingCheckoutIntents(
        storage,
        "user-a",
        1_000 + CHECKOUT_INTENT_TTL_MS + 1,
      ),
    ).toEqual([]);
  });

  it("removes an intent only when server authority explicitly requires a new key", () => {
    expect(shouldRemovePendingCheckoutIntent("new_key")).toBe(true);
    expect(shouldRemovePendingCheckoutIntent("same_key")).toBe(false);
    expect(shouldRemovePendingCheckoutIntent(undefined)).toBe(false);
    expect(shouldRemovePendingCheckoutIntent("unknown")).toBe(false);
  });
});
