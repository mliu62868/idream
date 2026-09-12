import { z } from "zod";
import { coinCheckoutRequestSchema, type CoinCheckoutRequest } from "@idream/shared/coins";

const pendingSchema = z.object({ version: z.literal(1), key: z.string().min(8).max(160), body: coinCheckoutRequestSchema }).strict();
export type PendingCoinCheckout = z.infer<typeof pendingSchema>;
const storageKey = (viewerId: string) => `idream:coin-checkout:v1:${encodeURIComponent(viewerId)}`;

export function readPendingCoinCheckout(storage: Pick<Storage, "getItem">, viewerId: string) {
  const raw = storage.getItem(storageKey(viewerId));
  if (!raw) return null;
  // Unknown submission receipts do not expire: only a definitive response can
  // prove that using a new payment key will not create a second invoice.
  return pendingSchema.parse(JSON.parse(raw));
}
export function savePendingCoinCheckout(storage: Pick<Storage, "setItem">, viewerId: string, body: CoinCheckoutRequest): PendingCoinCheckout {
  const pending = pendingSchema.parse({ version: 1, key: crypto.randomUUID(), body });
  storage.setItem(storageKey(viewerId), JSON.stringify(pending));
  return pending;
}
export function clearPendingCoinCheckout(storage: Pick<Storage, "removeItem">, viewerId: string) {
  storage.removeItem(storageKey(viewerId));
}
