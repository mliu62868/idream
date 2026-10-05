import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { GET as todayRoute } from "@/app/api/v2/admin/today/route";
import { PUT as preferenceRoute } from "@/app/api/v2/admin/today/preferences/route";
import { PUT as watchRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/watch/route";
import { GET as activityRoute } from "@/app/api/v2/admin/collaboration/[targetType]/[targetId]/activity/route";
import type { TodayProjection } from "@idream/shared/admin";
import { adminCaseActiveKey } from "@/server/modules/admin-v2/cases/service";

describe("one personal watch across Today and collaboration", () => {
  const suffix = randomUUID();
  const actorId = `watch-owner-${suffix}`;
  const otherId = `watch-other-${suffix}`;
  const customerId = `watch-customer-${suffix}`;
  const caseIds: string[] = [];
  const incidentIds: string[] = [];
  const headers = (actor = actorId) => ({ "content-type": "application/json", "x-idream-user-id": actor, "x-idream-role": "admin" });
  type Target = { targetType: "case" | "incident"; targetId: string; sourceType: "admin_case" | "ops_incident" };
  async function target(type: Target["targetType"]): Promise<Target> {
    if (type === "case") {
      const caseKey = randomUUID();
      const row = await prisma.adminCase.create({ data: { type: "support_request", targetType: "user", targetId: customerId, caseKey, activeKey: adminCaseActiveKey("support_request", "user", customerId, caseKey), ownerId: actorId, status: "triaged" } });
      caseIds.push(row.id);
      return { targetType: type, targetId: row.id, sourceType: "admin_case" };
    }
    const row = await prisma.opsIncident.create({ data: { signature: randomUUID(), signatureVersion: "v1", ownerId: actorId, status: "triaged", severity: "high", firstSeen: new Date(), lastSeen: new Date(), impact: {}, mitigation: {} } });
    incidentIds.push(row.id);
    return { targetType: type, targetId: row.id, sourceType: "ops_incident" };
  }
  async function projection(actor = actorId) {
    const response = await todayRoute(new Request("http://localhost/api/v2/admin/today", { headers: headers(actor) }));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).data as TodayProjection;
  }
  async function activity(input: Target, actor = actorId) {
    const response = await activityRoute(new Request(`http://localhost/api/v2/admin/collaboration/${input.targetType}/${input.targetId}/activity`, { headers: headers(actor) }), { params: Promise.resolve(input) });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).data as { watching: boolean; watcherIds: string[] };
  }
  async function watch(input: Target, watching: boolean, key = randomUUID()) {
    return watchRoute(new Request(`http://localhost/api/v2/admin/collaboration/${input.targetType}/${input.targetId}/watch`, { method: "PUT", headers: { ...headers(), "idempotency-key": key }, body: JSON.stringify({ watching }) }), { params: Promise.resolve(input) });
  }
  function preference(input: Target, expectedVersion: number, patch: object) {
    return preferenceRoute(new Request("http://localhost/api/v2/admin/today/preferences", { method: "PUT", headers: { ...headers(), "if-match": `"${expectedVersion}"`, "x-request-id": randomUUID() }, body: JSON.stringify({ sourceType: input.sourceType, sourceId: input.targetId, ...patch }) }));
  }
  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: actorId, email: `${actorId}@example.test`, role: "admin", dataClass: "internal" }, { id: otherId, email: `${otherId}@example.test`, role: "admin", dataClass: "internal" }, { id: customerId, email: `${customerId}@example.test`, role: "user", dataClass: "customer" }] });
  });
  afterAll(async () => {
    const ids = [...caseIds, ...incidentIds];
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: ids } } });
    await prisma.operationalWorkPreference.deleteMany({ where: { sourceId: { in: ids } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: incidentIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, otherId, customerId] } } });
  });

  it.each(["case", "incident"] as const)("cancels %s watching from either real API and keeps replay compatible", async type => {
    const input = await target(type);
    const key = randomUUID();
    expect((await watch(input, true, key)).status).toBe(200);
    expect(await activity(input)).toMatchObject({ watching: true, watcherIds: [actorId] });
    const item = (await projection()).watching.items.find(row => row.sourceId === input.targetId)!;
    expect(item).toBeDefined();
    const unwatch = await preference(input, item.preferenceVersion, { watching: false });
    expect(unwatch.status).toBe(200);
    const unwatchVersion = (await unwatch.json()).data.version as number;
    expect((await projection()).watching.items.some(row => row.sourceId === input.targetId)).toBe(false);
    expect(await activity(input)).toMatchObject({ watching: false, watcherIds: [] });
    const replay = await watch(input, true, key);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual({ watching: false, duplicate: true });
    expect((await projection()).watching.items.some(row => row.sourceId === input.targetId)).toBe(false);
    expect((await watch(input, false, key)).status).toBe(409);

    expect((await preference(input, unwatchVersion, { watching: true })).status).toBe(200);
    expect(await activity(input)).toMatchObject({ watching: true, watcherIds: [actorId] });
    expect((await watch(input, false)).status).toBe(200);
    expect((await projection()).watching.items.some(row => row.sourceId === input.targetId)).toBe(false);
  });

  it("preserves canonical pin/snooze, legacy watch and other actors while rejecting stale Today versions", async () => {
    const input = await target("case");
    const snoozedUntil = new Date(Date.now() + 86_400_000);
    await prisma.operationalWorkPreference.createMany({ data: [
      { actorId, sourceType: "admin_case", sourceId: input.targetId, watching: false, pinned: true, snoozedUntil, version: 2, updatedAt: new Date("2026-01-01T00:00:00Z") },
      { actorId, sourceType: "case", sourceId: input.targetId, watching: true, version: 5, updatedAt: new Date("2026-01-02T00:00:00Z") },
      { actorId: otherId, sourceType: "case", sourceId: input.targetId, watching: true, pinned: true, version: 7 },
    ] });
    const otherBefore = await prisma.operationalWorkPreference.findMany({ where: { actorId: otherId, sourceId: input.targetId } });
    const item = (await projection()).watching.items.find(row => row.sourceId === input.targetId)!;
    expect(item).toMatchObject({ pinned: true, preferenceVersion: 5 });
    expect((await preference(input, 2, { watching: false })).status).toBe(409);
    expect((await preference(input, item.preferenceVersion, { pinned: false })).status).toBe(200);
    expect(await activity(input)).toMatchObject({ watching: true });
    const updated = await prisma.operationalWorkPreference.findMany({ where: { actorId, sourceId: input.targetId } });
    expect(updated).toEqual([expect.objectContaining({ sourceType: "admin_case", watching: true, pinned: false, snoozedUntil, version: 6 })]);
    expect(await prisma.operationalWorkPreference.findMany({ where: { actorId: otherId, sourceId: input.targetId } })).toEqual(otherBefore);
    expect((await projection(otherId)).watching.items.some(row => row.sourceId === input.targetId)).toBe(true);
    expect((await watch(input, false)).status).toBe(200);
    const row = await prisma.operationalWorkPreference.findUniqueOrThrow({ where: { actorId_sourceType_sourceId: { actorId, sourceType: "admin_case", sourceId: input.targetId } } });
    expect(row).toMatchObject({ watching: false, pinned: false, snoozedUntil, version: 7 });
    expect((await preference(input, 6, { watching: true })).status).toBe(409);
  });

  it("reads the later stored Unwatch and transfers a legacy-only preference without losing fields", async () => {
    const input = await target("incident");
    const snoozedUntil = new Date(Date.now() + 86_400_000);
    await prisma.operationalWorkPreference.createMany({ data: [
      { actorId, sourceType: "incident", sourceId: input.targetId, watching: true, pinned: true, snoozedUntil, version: 4, updatedAt: new Date("2026-01-01T00:00:00Z") },
      { actorId: otherId, sourceType: "incident", sourceId: input.targetId, watching: true, updatedAt: new Date("2026-01-01T00:00:00Z") },
      { actorId: otherId, sourceType: "ops_incident", sourceId: input.targetId, watching: false, updatedAt: new Date("2026-01-02T00:00:00Z") },
    ] });
    expect((await projection(otherId)).watching.items.some(row => row.sourceId === input.targetId)).toBe(false);
    expect(await activity(input, otherId)).toMatchObject({ watching: false });
    const item = (await projection()).watching.items.find(row => row.sourceId === input.targetId)!;
    expect(item).toMatchObject({ pinned: true, preferenceVersion: 4 });
    expect((await watch(input, false)).status).toBe(200);
    const rows = await prisma.operationalWorkPreference.findMany({ where: { actorId, sourceId: input.targetId } });
    expect(rows).toEqual([expect.objectContaining({ sourceType: "ops_incident", watching: false, pinned: true, snoozedUntil, version: 5 })]);
  });
});
