import { z } from "zod";
import {
  isSafeExternalHref,
  isSafeInternalPath,
} from "./public-api-contracts";

export const CHECKOUT_INTENT_TTL_MS = 48 * 60 * 60 * 1_000;

type StorageReaderWriter = Pick<Storage, "getItem" | "setItem">;

const pendingCheckoutIntentSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().min(1).max(1_000),
    idempotencyKey: z.string().min(8).max(160),
    planId: z.string().min(1).max(200),
    autoConfirm: z.boolean(),
    returnPath: z
      .string()
      .refine(isSafeInternalPath, "Expected a safe return path"),
    checkoutUrl: z
      .string()
      .refine(isSafeExternalHref, "Expected a safe checkout URL")
      .optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const pendingCheckoutIntentStoreSchema = z.array(pendingCheckoutIntentSchema);

export type PendingCheckoutIntent = z.infer<
  typeof pendingCheckoutIntentSchema
>;

export type CheckoutIntentInput = Pick<
  PendingCheckoutIntent,
  "planId" | "autoConfirm" | "returnPath"
>;

export function checkoutIntentFingerprint(input: CheckoutIntentInput) {
  return JSON.stringify({
    planId: input.planId,
    autoConfirm: input.autoConfirm,
    returnPath: input.returnPath,
  });
}

export function checkoutIntentStorageKey(userId: string) {
  return `ourdream.billing.checkout-intents.v1:user:${userId}`;
}

export function createPendingCheckoutIntent(
  input: CheckoutIntentInput,
  idempotencyKey: string,
  createdAt = Date.now(),
): PendingCheckoutIntent {
  return pendingCheckoutIntentSchema.parse({
    version: 1,
    fingerprint: checkoutIntentFingerprint(input),
    idempotencyKey,
    ...input,
    createdAt,
  });
}

export function readPendingCheckoutIntents(
  storage: Pick<Storage, "getItem">,
  userId: string,
  now = Date.now(),
): PendingCheckoutIntent[] {
  try {
    const raw = storage.getItem(checkoutIntentStorageKey(userId));
    if (!raw || raw.length > 100_000) return [];
    const parsed = pendingCheckoutIntentStoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.filter(
      (intent) =>
        now - intent.createdAt >= 0 &&
        now - intent.createdAt <= CHECKOUT_INTENT_TTL_MS,
    );
  } catch {
    return [];
  }
}

export function writePendingCheckoutIntents(
  storage: StorageReaderWriter,
  userId: string,
  intents: readonly PendingCheckoutIntent[],
) {
  storage.setItem(
    checkoutIntentStorageKey(userId),
    JSON.stringify(pendingCheckoutIntentStoreSchema.parse(intents)),
  );
}

export function upsertPendingCheckoutIntent(
  intents: readonly PendingCheckoutIntent[],
  intent: PendingCheckoutIntent,
) {
  return [
    ...intents.filter(
      (candidate) => candidate.fingerprint !== intent.fingerprint,
    ),
    pendingCheckoutIntentSchema.parse(intent),
  ];
}

export function removePendingCheckoutIntent(
  intents: readonly PendingCheckoutIntent[],
  fingerprint: string,
) {
  return intents.filter((intent) => intent.fingerprint !== fingerprint);
}

export function shouldRemovePendingCheckoutIntent(
  idempotencyAction: unknown,
) {
  return idempotencyAction === "new_key";
}
