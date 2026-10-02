import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { ANNOUNCEMENTS_KEY, readAnnouncements, writeAnnouncements } from "@/server/announcements/store";
import { adminV2 } from "@/server/test/admin-v2-http";

// Inject the same audit outage into direct and transactional Prisma calls; all
// content/permission/storage queries still use the real isolated PostgreSQL.
const failure = vi.hoisted(() => ({ audit: false }));
vi.mock("@/server/lib/db", async (importOriginal) => {
  const db = await importOriginal<typeof import("@/server/lib/db")>();
  return { ...db, prisma: db.prisma.$extends({ query: { adminAuditLog: {
    create({ args, query }) {
      if (failure.audit && args.data.action.startsWith("growth.announcement.")) throw new Error("controlled announcement audit outage");
      return query(args);
    },
  } } }) };
});

const actor = { userId: "seed-admin-user", role: "admin" };
type Item = { id: string; version?: number; title: string };
function create(title: string, fields: Record<string, unknown> = {}, idempotencyKey?: string) {
  return adminV2("POST", "announcements", { ...actor, idempotencyKey, body: {
    title, body: `Content for ${title}`, active: true, reason: "Verify concurrent announcement operations", confirmation: title, ...fields,
  } });
}
function patch(item: Item, fields: Record<string, unknown>, idempotencyKey?: string) {
  return adminV2("PATCH", `announcements/${item.id}`, { ...actor, idempotencyKey, body: {
    ...(item.version === undefined ? {} : { entityVersion: item.version }),
    reason: "Verify versioned announcement update", confirmation: item.id, ...fields,
  } });
}
function remove(item: Item, idempotencyKey?: string) {
  return adminV2("DELETE", `announcements/${item.id}`, { ...actor, idempotencyKey, body: {
    ...(item.version === undefined ? {} : { entityVersion: item.version }),
    reason: "Verify versioned announcement removal", confirmation: item.id,
  } });
}
async function existing(title: string, fields: Record<string, unknown> = {}) {
  const result = await create(title, fields);
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  return result.data.announcement as Item;
}

// Hold the setting row until both independent operations reach a database lock.
// Before the fix both have already read the same JSON; a correct writer can
// instead wait on its transaction lock before reading. No scheduling sleeps
// or mocks of the read/modify/write implementation are needed.
async function overlapping<T>(operations: () => Promise<T[]>) {
  let acquired!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const lock = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT key FROM app_settings WHERE key = ${ANNOUNCEMENTS_KEY} FOR UPDATE`;
    acquired();
    await held;
  }, { timeout: 15_000 });
  await ready;
  const result = operations();
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND (query LIKE '%app_settings%' OR query LIKE '%pg_advisory_xact_lock%')`;
      if (rows[0]!.waiting >= 2) break;
      if (Date.now() > deadline) throw new Error("Both announcement operations did not reach the controlled database barrier");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    release();
    await lock;
  }
  return await result;
}

describe("announcement mutation isolation", () => {
  beforeEach(async () => {
    failure.audit = false;
    await writeAnnouncements([]);
    await prisma.adminAuditLog.deleteMany({ where: { action: { startsWith: "growth.announcement." } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { commandType: { startsWith: "growth.announcement." } } });
  });
  afterEach(() => { failure.audit = false; });
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: ANNOUNCEMENTS_KEY } });
    await prisma.controlPlaneCommand.deleteMany({ where: { commandType: { startsWith: "growth.announcement." } } });
    await prisma.adminAuditLog.deleteMany({ where: { action: { startsWith: "growth.announcement." } } });
    await prisma.$disconnect();
  });

  it("retains both independently successful concurrent creations", async () => {
    const results = await overlapping(() => Promise.all([create("Concurrent A"), create("Concurrent B")]));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect((await readAnnouncements()).map(item => item.title).sort()).toEqual(["Concurrent A", "Concurrent B"]);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.create" } })).toBe(2);
  }, 15_000);

  it("retains edits of separate announcements", async () => {
    const a = await existing("Before A"), b = await existing("Before B");
    const results = await overlapping(() => Promise.all([patch(a, { title: "After A" }), patch(b, { title: "After B" })]));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect((await readAnnouncements()).map(item => item.title).sort()).toEqual(["After A", "After B"]);
  }, 15_000);

  it("does not resurrect a deleted announcement while another is edited", async () => {
    const a = await existing("Remove A"), b = await existing("Before B");
    const results = await overlapping(() => Promise.all([remove(a), patch(b, { title: "After B" })]));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect((await readAnnouncements()).map(item => item.title)).toEqual(["After B"]);
  }, 15_000);

  it("rejects a stale same-announcement edit and deletion without changing content or audit", async () => {
    const item = await existing("Original");
    const changed = await patch(item, { title: "Current title" });
    expect(changed.status).toBe(200);
    expect((await patch(item, { title: "Stale overwrite" })).status).toBe(409);
    expect((await remove(item)).status).toBe(409);
    expect((await readAnnouncements()).map(row => row.title)).toEqual(["Current title"]);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.update", targetId: item.id } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.delete", targetId: item.id } })).toBe(0);
  });

  it.each(["create", "patch", "delete"])("rolls back %s when its audit cannot be persisted", async operation => {
    const item = await existing("Original");
    const before = await prisma.appSetting.findUniqueOrThrow({ where: { key: ANNOUNCEMENTS_KEY } });
    failure.audit = true;
    const result = operation === "create" ? await create("Unaudited") : operation === "patch" ? await patch(item, { title: "Unaudited" }) : await remove(item);
    expect(result.status).toBe(500);
    expect(await prisma.appSetting.findUniqueOrThrow({ where: { key: ANNOUNCEMENTS_KEY } })).toEqual(before);
    expect(await prisma.adminAuditLog.count({ where: { targetId: item.id } })).toBe(1);
  });

  it.each([
    ["2026-10-03T00:00:00.000Z", "2026-10-02T00:00:00.000Z"],
    ["2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z"],
  ])("rejects a non-serving ordered window on creation (%s, %s)", async (startsAt, endsAt) => {
    const result = await create("Invalid window", { startsAt, endsAt });
    expect(result.status).toBe(400);
    expect(await readAnnouncements()).toEqual([]);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.create" } })).toBe(0);
  });

  it("checks the merged window when only one bound is edited", async () => {
    const item = await existing("Scheduled", { startsAt: "2026-10-02T00:00:00.000Z", endsAt: "2026-10-04T00:00:00.000Z" });
    const before = await readAnnouncements();
    expect((await patch(item, { endsAt: "2026-10-01T00:00:00.000Z" })).status).toBe(400);
    expect((await patch(item, { startsAt: "2026-10-05T00:00:00.000Z" })).status).toBe(400);
    expect(await readAnnouncements()).toEqual(before);
  });

  it("replays a creation after its response is lost without another row or audit", async () => {
    const key = randomUUID();
    const first = await create("Lost response", {}, key);
    const replay = await create("Lost response", {}, key);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.data.announcement.id).toBe(first.data.announcement.id);
    expect((await readAnnouncements()).map(item => item.id)).toEqual([first.data.announcement.id]);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.create" } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("deduplicates concurrent submissions with the same idempotency key", async () => {
    const key = randomUUID();
    const results = await overlapping(() => Promise.all([create("Same command", {}, key), create("Same command", {}, key)]));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results[0]!.data.announcement.id).toBe(results[1]!.data.announcement.id);
    expect(await readAnnouncements()).toHaveLength(1);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.create" } })).toBe(1);
  }, 15_000);

  it("binds an idempotency key to its original payload", async () => {
    const key = randomUUID();
    expect((await create("First payload", {}, key)).status).toBe(200);
    expect((await create("Changed payload", {}, key)).status).toBe(409);
    expect((await readAnnouncements()).map(item => item.title)).toEqual(["First payload"]);
  });

  it("replays a patch and deletion despite the committed version change or missing row", async () => {
    const item = await existing("Before");
    const patchKey = randomUUID();
    const changed = await patch(item, { title: "After" }, patchKey);
    expect(changed.status).toBe(200);
    expect(await patch(item, { title: "After" }, patchKey)).toMatchObject({ status: 200, data: changed.data });
    const deleteKey = randomUUID();
    expect((await remove(changed.data.announcement, deleteKey)).status).toBe(200);
    expect((await remove(changed.data.announcement, deleteKey)).status).toBe(200);
    expect(await readAnnouncements()).toEqual([]);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.update", targetId: item.id } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.delete", targetId: item.id } })).toBe(1);
  });

  it("serializes the first concurrent creations when no setting row exists", async () => {
    await prisma.appSetting.delete({ where: { key: ANNOUNCEMENTS_KEY } });
    const results = await Promise.all([create("Cold A"), create("Cold B")]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect((await readAnnouncements()).map(item => item.title).sort()).toEqual(["Cold A", "Cold B"]);
  });

  it("reads legacy unversioned JSON as version 1 and persists its first versioned edit", async () => {
    const legacy = { id: "legacy-announcement", title: "Legacy", body: "Old persisted copy", level: "info", active: true,
      startsAt: null, endsAt: null, href: null, createdAt: "2026-09-01T00:00:00.000Z" };
    await prisma.appSetting.update({ where: { key: ANNOUNCEMENTS_KEY }, data: { value: { items: [legacy] } } });
    const list = await adminV2("GET", "announcements", actor);
    expect(list.status).toBe(200);
    expect(list.data.items[0]).toMatchObject({ id: legacy.id, version: 1, serving: true });
    const result = await patch({ ...legacy, version: 1 }, { title: "Updated legacy" });
    expect(result.status).toBe(200);
    expect((await readAnnouncements())[0]).toMatchObject({ id: legacy.id, version: 2, title: "Updated legacy" });
  });

  it("requires the command key and version before changing content", async () => {
    const noKey = await adminV2("POST", "announcements", { ...actor, idempotencyKey: null, body: {
      title: "Missing key", body: "Missing command key", confirmation: "Missing key", reason: "Reject a missing command key",
    } });
    expect(noKey.status).toBe(400);
    const item = await existing("Requires version");
    expect((await patch({ id: item.id, title: item.title }, { title: "No version" })).status).toBe(400);
    expect((await remove({ id: item.id, title: item.title })).status).toBe(400);
    expect((await readAnnouncements()).map(item => item.title)).toEqual(["Requires version"]);
  });

  it("can retry an audited mutation with the same key after a rolled-back audit outage", async () => {
    const item = await existing("Before outage");
    const key = randomUUID();
    failure.audit = true;
    expect((await patch(item, { title: "Recovered copy" }, key)).status).toBe(500);
    expect(await prisma.controlPlaneCommand.count({ where: { idempotencyKey: key } })).toBe(0);
    failure.audit = false;
    const result = await patch(item, { title: "Recovered copy" }, key);
    expect(result.status).toBe(200);
    expect(result.data.announcement).toMatchObject({ id: item.id, version: 2, title: "Recovered copy" });
    expect(await prisma.adminAuditLog.count({ where: { action: "growth.announcement.update", targetId: item.id } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { idempotencyKey: key } })).toBe(1);
  });
});
