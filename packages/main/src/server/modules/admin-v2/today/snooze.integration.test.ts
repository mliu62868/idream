import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TodayAllWorkResponse, TodayProjection } from "@idream/shared/admin";
import { todayAllWorkQuerySchema } from "@idream/shared/admin";
import { GET as allWorkRoute } from "@/app/api/v2/admin/today/all-work/route";
import { GET as todayRoute } from "@/app/api/v2/admin/today/route";
import { PUT as preferenceRoute } from "@/app/api/v2/admin/today/preferences/route";
import { prisma } from "@/server/lib/db";
import { resolvePermissions } from "@/server/admin/permissions";
import { adminCaseActiveKey } from "../cases/service";
import { buildTodayAllWork } from "./query";

describe("personal snooze recovery", () => {
  const suffix = randomUUID();
  const actorId = `snooze-support-${suffix}`;
  const otherId = `snooze-other-${suffix}`;
  const customerId = `snooze-customer-${suffix}`;
  const caseIds = ["active", "snoozed", "restricted"].map(label => `snooze-${label}-${suffix}`);
  const until = new Date(Date.now() + 3_600_000);
  const headers = (actor = actorId) => ({ "content-type": "application/json", "x-idream-user-id": actor, "x-idream-role": "support" });
  const url = (extra = "") => `http://localhost/api/v2/admin/today/all-work?domain=admin_case&ownerId=${actorId}${extra}`;
  async function list(extra = "", actor = actorId) {
    const response = await allWorkRoute(new Request(url(extra), { headers: headers(actor) }));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).data as TodayAllWorkResponse;
  }
  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@example.test`, role: "support", dataClass: "internal" },
      { id: otherId, email: `${otherId}@example.test`, role: "support", dataClass: "internal" },
      { id: customerId, email: `${customerId}@example.test`, role: "user", dataClass: "customer" },
    ] });
    await prisma.adminCase.createMany({ data: caseIds.map((id, index) => ({ id, type: index === 2 ? "content_report" : "support_request", targetType: "user", targetId: customerId, caseKey: id, activeKey: adminCaseActiveKey(index === 2 ? "content_report" : "support_request", "user", customerId, id), status: "triaged", ownerId: actorId, slaDueAt: new Date(Date.now() + 7_200_000) })) });
    await prisma.operationalWorkPreference.createMany({ data: [
      { actorId, sourceType: "admin_case", sourceId: caseIds[1], snoozedUntil: until, pinned: true, watching: true, version: 3 },
      { actorId: otherId, sourceType: "admin_case", sourceId: caseIds[1], watching: true, version: 7 },
    ] });
  });
  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: caseIds } } });
    await prisma.operationalWorkPreference.deleteMany({ where: { sourceId: { in: caseIds } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, otherId, customerId] } } });
  });

  it("explicitly lists a hidden snooze without broadening permissions or another actor's preference", async () => {
    const before = await prisma.operationalWorkPreference.findMany({ where: { sourceId: { in: caseIds } }, orderBy: { actorId: "asc" } });
    expect((await list()).items.map(item => item.sourceId)).toEqual([caseIds[0]]);
    const included = await list("&includeSnoozed=true");
    expect(included.totalCount).toBe(2);
    expect(new Set(included.items.map(item => item.sourceId))).toEqual(new Set(caseIds.slice(0, 2)));
    expect(included.items.find(item => item.sourceId === caseIds[1])).toMatchObject({ pinned: true, preferenceVersion: 3, snoozedUntil: until.toISOString() });
    expect(included.items.find(item => item.sourceId === caseIds[0])).toMatchObject({ snoozedUntil: null });
    const other = await list("", otherId);
    expect(other.totalCount).toBe(2);
    expect(other.items.find(item => item.sourceId === caseIds[1])).toMatchObject({ preferenceVersion: 7, snoozedUntil: null });
    const summary = await todayRoute(new Request("http://localhost/api/v2/admin/today", { headers: headers() }));
    expect(summary.status).toBe(200);
    const projection = (await summary.json()).data as TodayProjection;
    expect(projection.watching.items.find(item => item.sourceId === caseIds[1])).toMatchObject({ snoozedUntil: until.toISOString(), preferenceVersion: 3 });
    expect(await prisma.operationalWorkPreference.findMany({ where: { sourceId: { in: caseIds } }, orderBy: { actorId: "asc" } })).toEqual(before);
  });

  it("binds pagination to the inclusion filter and restores a snooze only by its current preference version", async () => {
    const first = await list("&includeSnoozed=true&limit=1");
    expect(first.pageInfo.hasNextPage).toBe(true);
    const cursor = encodeURIComponent(first.pageInfo.endCursor!);
    const second = await list(`&includeSnoozed=true&limit=1&cursor=${cursor}`);
    expect(new Set([...first.items, ...second.items].map(item => item.sourceId))).toEqual(new Set(caseIds.slice(0, 2)));
    expect((await allWorkRoute(new Request(url(`&limit=1&cursor=${cursor}`), { headers: headers() }))).status).toBe(400);
    const domainBefore = await prisma.adminCase.findUniqueOrThrow({ where: { id: caseIds[1] } });
    const otherBefore = await prisma.operationalWorkPreference.findMany({ where: { actorId: otherId, sourceId: caseIds[1] } });
    const clear = (version: number) => preferenceRoute(new Request("http://localhost/api/v2/admin/today/preferences", { method: "PUT", headers: { ...headers(), "if-match": `"${version}"`, "x-request-id": randomUUID() }, body: JSON.stringify({ sourceType: "admin_case", sourceId: caseIds[1], snoozedUntil: null }) }));
    expect((await clear(2)).status).toBe(409);
    const restored = await clear(3);
    expect(restored.status).toBe(200);
    expect((await restored.json()).data).toMatchObject({ snoozedUntil: null, pinned: true, watching: true, version: 4 });
    expect((await clear(3)).status).toBe(409);
    expect((await list()).items.find(item => item.sourceId === caseIds[1])).toMatchObject({ snoozedUntil: null, preferenceVersion: 4 });
    expect(await prisma.adminCase.findUniqueOrThrow({ where: { id: caseIds[1] } })).toEqual(domainBefore);
    expect(await prisma.operationalWorkPreference.findMany({ where: { actorId: otherId, sourceId: caseIds[1] } })).toEqual(otherBefore);
  });

  it("automatically reappears at expiry without a background mutation and rejects non-true inclusion values", async () => {
    await prisma.operationalWorkPreference.update({ where: { actorId_sourceType_sourceId: { actorId, sourceType: "admin_case", sourceId: caseIds[1] } }, data: { snoozedUntil: until } });
    const before = await prisma.operationalWorkPreference.findMany({ where: { actorId, sourceId: caseIds[1] } });
    const afterExpiry = await buildTodayAllWork({ actor: { id: actorId, role: "support" }, permissions: resolvePermissions("support"), now: until, query: todayAllWorkQuerySchema.parse({ domain: "admin_case", ownerId: actorId }) });
    expect(afterExpiry.items.find(item => item.sourceId === caseIds[1])).toMatchObject({ snoozedUntil: until.toISOString() });
    expect(afterExpiry.totalCount).toBe(2);
    expect(await prisma.operationalWorkPreference.findMany({ where: { actorId, sourceId: caseIds[1] } })).toEqual(before);
    for (const value of ["false", "1", "TRUE"]) expect((await allWorkRoute(new Request(url(`&includeSnoozed=${value}`), { headers: headers() }))).status).toBe(400);
  });
});
