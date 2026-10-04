import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser } from "@/server/test/helpers";
import * as contentAudit from "./audit";

const P = "zt-starter-reliable-";
const path = "/api/v2/admin/content/templates";

async function purge() {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { startsWith: P } } });
  await prisma.characterTemplate.deleteMany({ where: { createdById: { startsWith: P } } });
  await prisma.adminAuditLog.deleteMany({ where: { actorId: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(purge);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await purge(); await prisma.$disconnect(); });

async function actor(suffix: string) {
  const id = `${P}${suffix}`;
  await createUser({ id, role: "admin" });
  return { userId: id, role: "admin" as const };
}

describe("starter HTTP mutation receipts and atomic audit", () => {
  it("creates exactly one starter and audit for concurrent and lost-response retries", async () => {
    const auth = await actor("replay");
    const options = { ...auth, idempotencyKey: `${P}create`, body: { name: "Reliable starter", reason: "Create a starter once" } };
    const [first, concurrent] = await Promise.all([
      adminV2("POST", path, options), adminV2("POST", path, options),
    ]);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(concurrent.status, JSON.stringify(concurrent.json)).toBe(200);
    expect(concurrent.data).toEqual(first.data);
    const retry = await adminV2("POST", path, options);
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(retry.data).toEqual(first.data);
    expect(await prisma.characterTemplate.count({ where: { createdById: auth.userId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { actorId: auth.userId, action: "content.template.create" } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId: auth.userId, commandType: "content.template.create" } })).toBe(1);

    const conflict = await adminV2("POST", path, { ...options, body: { ...options.body, name: "Different payload" } });
    expect(conflict.status).toBe(409);
    expect(await prisma.characterTemplate.count({ where: { createdById: auth.userId } })).toBe(1);
  });

  it("rolls back starter creation on audit failure and accepts a same-key retry", async () => {
    const auth = await actor("create-rollback");
    const options = { ...auth, idempotencyKey: `${P}rollback-create`, body: { name: "Atomic starter", reason: "Create with its audit" } };
    vi.spyOn(contentAudit, "writeContentAudit").mockRejectedValueOnce(new Error("Injected audit outage"));
    const failure = await adminV2("POST", path, options);
    expect(failure.status).toBe(500);
    expect(await prisma.characterTemplate.count({ where: { createdById: auth.userId } })).toBe(0);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId: auth.userId } })).toBe(0);

    const retry = await adminV2("POST", path, options);
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(await prisma.characterTemplate.count({ where: { createdById: auth.userId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { actorId: auth.userId, action: "content.template.create" } })).toBe(1);
  });

  it.each(["update", "active"] as const)("keeps the previous %s state on audit failure, then replays without undoing a newer command", async (operation) => {
    const auth = await actor(`${operation}-rollback`);
    const created = await adminV2("POST", path, { ...auth, body: { name: "Initial starter", reason: "Create the initial draft" } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = created.data.template.id as string;
    const prior = await prisma.characterTemplate.findUniqueOrThrow({ where: { id } });
    const versions = new Map<string, string>();
    const command = async (latest: boolean, key: string) => {
      const expectedUpdatedAt = versions.get(key) ?? (await prisma.characterTemplate.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
      versions.set(key, expectedUpdatedAt);
      return operation === "update"
        ? adminV2("PATCH", `${path}/${id}`, { ...auth, idempotencyKey: key, body: { expectedUpdatedAt, name: latest ? "Latest starter" : "Earlier starter", reason: "Update the starter" } })
        : adminV2("POST", `${path}/${id}/active`, { ...auth, idempotencyKey: key, body: { expectedUpdatedAt, active: !latest, confirmation: id, reason: "Update starter publication" } });
    };

    vi.spyOn(contentAudit, "writeContentAudit").mockRejectedValueOnce(new Error("Injected audit outage"));
    expect((await command(false, `${P}${operation}-old`)).status).toBe(500);
    expect(await prisma.characterTemplate.findUniqueOrThrow({ where: { id } })).toEqual(prior);
    expect(await prisma.adminAuditLog.count({ where: { actorId: auth.userId } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId: auth.userId } })).toBe(1);

    const first = await command(false, `${P}${operation}-old`);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const latest = await command(true, `${P}${operation}-latest`);
    expect(latest.status, JSON.stringify(latest.json)).toBe(200);
    const replay = await command(false, `${P}${operation}-old`);
    expect(replay.status, JSON.stringify(replay.json)).toBe(200);
    expect(replay.data).toEqual(first.data);
    expect(await prisma.characterTemplate.findUniqueOrThrow({ where: { id } })).toMatchObject(
      operation === "update" ? { name: "Latest starter" } : { isActive: false },
    );
    expect(await prisma.adminAuditLog.count({ where: { actorId: auth.userId, action: `content.template.${operation}` } })).toBe(2);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId: auth.userId } })).toBe(3);
  });

  it.each(["update", "active"] as const)("rejects another operator's stale %s without changing the current template or writing an audit", async (operation) => {
    const a = await actor(`stale-${operation}-a`);
    const b = await actor(`stale-${operation}-b`);
    const created = await adminV2("POST", path, { ...a, body: { name: "Shared initial name", reason: "Create a shared starter" } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const { id, updatedAt: expectedUpdatedAt } = created.data.template;
    const saved = await adminV2("PATCH", `${path}/${id}`, { ...b, body: {
      expectedUpdatedAt, name: "B's latest name", reason: "B updates the shared starter",
    } });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const stale = operation === "update"
      ? await adminV2("PATCH", `${path}/${id}`, { ...a, body: { expectedUpdatedAt, name: "Shared initial name", summary: "A's old form", reason: "A updates an old snapshot" } })
      : await adminV2("POST", `${path}/${id}/active`, { ...a, body: { expectedUpdatedAt, active: true, confirmation: id, reason: "A publishes an old snapshot" } });
    expect(stale.status, JSON.stringify(stale.json)).toBe(409);
    expect(stale.error?.details).toMatchObject({ blocker: "version_mismatch" });
    expect(await prisma.characterTemplate.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "B's latest name", summary: null, isActive: false });
    expect(await prisma.adminAuditLog.count({ where: { actorId: a.userId } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId: a.userId } })).toBe(1);
  });

  it("accepts only one of two operators editing the same version concurrently", async () => {
    const a = await actor("cas-a");
    const b = await actor("cas-b");
    const created = await adminV2("POST", path, { ...a, body: { name: "Before either editor", reason: "Create a shared starter" } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const { id, updatedAt: expectedUpdatedAt } = created.data.template;
    const edits = await Promise.all([a, b].map((auth, index) => adminV2("PATCH", `${path}/${id}`, {
      ...auth, body: { expectedUpdatedAt, name: `Editor ${index}`, reason: "Save this exact snapshot" },
    })));
    expect(edits.map(result => result.status).sort()).toEqual([200, 409]);
    const accepted = edits.find(result => result.status === 200)!;
    expect((await prisma.characterTemplate.findUniqueOrThrow({ where: { id } })).name).toBe(accepted.data.template.name);
    expect(await prisma.adminAuditLog.count({ where: { targetId: id, action: "content.template.update" } })).toBe(1);
  });
});
