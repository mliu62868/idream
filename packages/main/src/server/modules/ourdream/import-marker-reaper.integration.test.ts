import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { armImportMarker, dispatchImportMarkerReapers, reserveImportMarker, retireImportMarker } from "./import-marker-reaper";

const authority = "a".repeat(64);
const ids: string[] = [];
// Other integration scenarios intentionally retain their anonymous receipts.
// Scope only discovery to this test's keys; all claims and updates use the
// actual database so concurrent worker leasing is still exercised.
const scopedDb = {
  $transaction: prisma.$transaction.bind(prisma),
  importMarkerReaper: new Proxy(prisma.importMarkerReaper, {
    get(target, property) {
      if (property === "findMany") return (args: Prisma.ImportMarkerReaperFindManyArgs) => target.findMany({
        ...args, where: { AND: [args.where ?? {}, { id: { in: ids } }] },
      });
      return Reflect.get(target, property, target);
    },
  }),
};
function identity() {
  const stageId = `media_url_stage_${randomUUID()}`;
  ids.push(stageId);
  return { stageId, key: `imports/${randomUUID()}/${randomUUID()}`, authority };
}
afterEach(async () => {
  await prisma.importMarkerReaper.deleteMany({ where: { id: { in: ids } } });
  ids.length = 0;
});
afterAll(async () => { await prisma.$disconnect(); });

it("only retires a dormant marker; a claimed key cannot become a completed asset", async () => {
  const input = identity();
  await prisma.$transaction(tx => reserveImportMarker(tx, input));
  await prisma.$transaction(tx => armImportMarker(tx, input));
  await expect(prisma.$transaction(tx => retireImportMarker(tx, input))).rejects.toThrow("already claimed");
  await expect(prisma.importMarkerReaper.findUniqueOrThrow({ where: { id: input.stageId } })).resolves.toMatchObject({ status: "pending", authorityHash: authority });
  const winner = identity();
  await prisma.$transaction(tx => reserveImportMarker(tx, winner));
  await prisma.$transaction(tx => retireImportMarker(tx, winner));
  expect(await prisma.importMarkerReaper.findUnique({ where: { id: winner.stageId } })).toBeNull();
});

it("retains an anonymous tombstone and reaps a marker arriving after a successful delete", async () => {
  const input = identity();
  const now = new Date("2026-10-28T12:00:00Z");
  await prisma.$transaction(tx => reserveImportMarker(tx, input));
  await prisma.$transaction(tx => armImportMarker(tx, input, now));
  const objects = new Set<string>();
  const blob = { getFencedStorageAuthority: () => authority, deleteFenced: async ({ key }: { key: string }) => {
    objects.delete(key);
    return { ok: true as const, data: { deleted: true as const } };
  } };
  expect(await dispatchImportMarkerReapers({ now, blob, db: scopedDb })).toEqual({ checked: 1, failed: 0 });
  objects.add(input.key); // The first marker request reaches the server late.
  expect(await dispatchImportMarkerReapers({ now: new Date(now.getTime() + 24 * 60 * 60_000), blob, db: scopedDb })).toEqual({ checked: 1, failed: 0 });
  expect(objects.has(input.key)).toBe(false);
  await expect(prisma.importMarkerReaper.findUniqueOrThrow({ where: { id: input.stageId } })).resolves.toMatchObject({ status: "pending", storageKey: input.key, attempts: 2 });
});

it("does not delete from a changed storage authority and retries when restored", async () => {
  const input = identity();
  const now = new Date("2026-10-28T12:00:00Z");
  await prisma.$transaction(tx => reserveImportMarker(tx, input));
  await prisma.$transaction(tx => armImportMarker(tx, input, now));
  let calls = 0;
  const remove = async () => { calls++; return { ok: true as const, data: { deleted: true as const } }; };
  expect(await dispatchImportMarkerReapers({ now, db: scopedDb, blob: { getFencedStorageAuthority: () => "b".repeat(64), deleteFenced: remove } })).toEqual({ checked: 0, failed: 1 });
  expect(calls).toBe(0);
  expect(await dispatchImportMarkerReapers({ now: new Date(now.getTime() + 60_000), db: scopedDb, blob: { getFencedStorageAuthority: () => authority, deleteFenced: remove } })).toEqual({ checked: 1, failed: 0 });
  expect(calls).toBe(1);
});

it("leases one marker to one worker and never targets a different key", async () => {
  const input = identity();
  const now = new Date("2026-10-28T12:00:00Z");
  await prisma.$transaction(tx => reserveImportMarker(tx, input));
  await prisma.$transaction(tx => armImportMarker(tx, input, now));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const keys: string[] = [];
  const blob = { getFencedStorageAuthority: () => authority, deleteFenced: async ({ key }: { key: string }) => {
    keys.push(key); entered(); await wait;
    return { ok: true as const, data: { deleted: true as const } };
  } };
  const first = dispatchImportMarkerReapers({ now, blob, db: scopedDb });
  try {
    await started;
    expect(await dispatchImportMarkerReapers({ now, blob, db: scopedDb })).toEqual({ checked: 0, failed: 0 });
  } finally { release(); }
  expect(await first).toEqual({ checked: 1, failed: 0 });
  expect(keys).toEqual([input.key]);
});
