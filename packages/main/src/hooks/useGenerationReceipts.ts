"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createGenerationIdempotencyKeys } from "@/lib/generation-request";
import {
  GenerationRequestError,
  listGenerationReceipts,
  parseStoredGenerationReceipt,
  readGenerationReceipts,
  requestGenerationReceipt,
  type GenerationReceipt,
  type GenerationReceiptPersistence,
} from "@/lib/generation-write-client";

function createKeys() {
  return { ...createGenerationIdempotencyKeys(), enhancement: new Map<string, string>() };
}

type ReceiptKeys = ReturnType<typeof createKeys>;

function mapForReceipt(keys: ReceiptKeys, receipt: GenerationReceipt) {
  return receipt.kind === "generation" || receipt.kind === "chat_video" ? keys.generation
    : receipt.kind === "media_variation" ? keys.variation
    : receipt.kind === "generation_retry" ? keys.retry : keys.enhancement;
}

// SPEC: a retained generation action always includes its confirmed owner,
// original payload and key. Storage and owner invalidation are part of the
// action lifecycle, not optional wiring repeated by each product surface.
export function useGenerationReceipts({ ownerScope, onWarning }: {
  ownerScope: string | null;
  onWarning?: (message: string) => void;
}) {
  const bookRef = useRef({ ownerScope: null as string | null, keys: createKeys() });
  const authorityRef = useRef<GenerationReceiptPersistence | null>(null);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const checksRef = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState<{ ownerScope: string | null; items: GenerationReceipt[] }>({ ownerScope: null, items: [] });
  const [checkingKeys, setCheckingKeys] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(() => {
    const owner = authorityRef.current;
    setSnapshot({
      ownerScope: owner?.ownerScope ?? null,
      items: owner ? Object.values(bookRef.current.keys).flatMap(listGenerationReceipts) : [],
    });
  }, []);

  const restore = useCallback(() => {
    const owner = authorityRef.current;
    if (!owner) return;
    for (const receipt of readGenerationReceipts(owner)) {
      const map = mapForReceipt(bookRef.current.keys, receipt);
      if (!map.has(receipt.record)) map.set(receipt.record, receipt.key);
    }
  }, []);

  const confirmOwner = useCallback((confirmedOwnerScope: string | null) => {
    if (!mountedRef.current) return;
    const current = authorityRef.current;
    if (current?.ownerScope === confirmedOwnerScope) {
      // A same-owner session poll updates no authority and must not invalidate
      // an in-flight ACK just because its React warning callback changed.
      current.onWarning = onWarning;
      return;
    }
    epochRef.current += 1;
    authorityRef.current = confirmedOwnerScope ? { ownerScope: confirmedOwnerScope, onWarning } : null;
    if (!confirmedOwnerScope) return;
    if (bookRef.current.ownerScope !== confirmedOwnerScope) {
      bookRef.current = { ownerScope: confirmedOwnerScope, keys: createKeys() };
      checksRef.current = new Set();
    }
    restore();
  }, [onWarning, restore]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // An unmounted surface cannot publish a late ACK into its original owner.
      mountedRef.current = false;
      epochRef.current += 1;
      authorityRef.current = null;
    };
  }, []);

  useEffect(() => {
    confirmOwner(ownerScope);
    const timer = window.setTimeout(() => { setCheckingKeys(new Set(checksRef.current)); refresh(); }, 0);
    const onStorage = (event: StorageEvent) => {
      // The retained book keeps its owner during revalidation. Consuming an
      // exact removal does not grant the suspended context permission to write.
      const retainedOwnerScope = bookRef.current.ownerScope;
      if (retainedOwnerScope && event.storageArea === window.localStorage && event.key && event.newValue === null) {
        const removed = parseStoredGenerationReceipt({ ownerScope: retainedOwnerScope, storageKey: event.key, value: event.oldValue });
        if (removed) {
          const map = mapForReceipt(bookRef.current.keys, removed);
          // Consume the exact cross-tab removal, without dropping requests that
          // only exist in memory because browser persistence failed.
          if (map.get(removed.record) === removed.key) map.delete(removed.record);
        }
      }
      restore();
      refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [ownerScope, confirmOwner, refresh, restore]);

  // Call only with a freshly server-confirmed owner. Explicit confirmation is
  // required after suspension even if React batches null → the same owner and
  // never commits the intermediate prop. Old contexts remain invalid forever.
  const resume = useCallback((confirmedOwnerScope: string) => {
    if (!mountedRef.current) return;
    confirmOwner(confirmedOwnerScope);
    setCheckingKeys(new Set(checksRef.current));
    refresh();
  }, [confirmOwner, refresh]);

  const context = useCallback(() => {
    const persistence = authorityRef.current;
    if (!persistence) throw new GenerationRequestError("Confirm your signed-in account before checking or creating a generation request.", 409);
    const epoch = epochRef.current;
    return {
      keys: bookRef.current.keys,
      persistence,
      isCurrent: () => epoch === epochRef.current && authorityRef.current === persistence,
    };
  }, []);

  // Pending identity also protects same-owner drafts while authority is being
  // rechecked. It is not permission to write; only context() grants that.
  const hasPending = useCallback((matches: (keys: ReceiptKeys) => boolean) =>
    matches(bookRef.current.keys), []);

  const suspend = useCallback((preserveUnconfirmed = false) => {
    epochRef.current += 1;
    authorityRef.current = null;
    if (!preserveUnconfirmed) bookRef.current = { ownerScope: null, keys: createKeys() };
    checksRef.current = new Set();
    setCheckingKeys(new Set());
    setSnapshot({ ownerScope: null, items: [] });
  }, []);

  const recover = useCallback(async (receipt: GenerationReceipt) => {
    const ctx = context();
    const checks = checksRef.current;
    if (checks.has(receipt.key)) return null;
    checks.add(receipt.key);
    setCheckingKeys(new Set(checks));
    try {
      return await requestGenerationReceipt(receipt, {
        ...ctx,
        idempotencyKeys: mapForReceipt(ctx.keys, receipt),
      });
    } finally {
      checks.delete(receipt.key);
      if (ctx.isCurrent()) { setCheckingKeys(new Set(checks)); refresh(); }
    }
  }, [context, refresh]);

  return {
    receipts: ownerScope && ownerScope === snapshot.ownerScope ? snapshot.items : [],
    checkingKeys,
    context,
    refresh,
    hasPending,
    recover,
    suspend,
    resume,
  };
}
