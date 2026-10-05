import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as providerRoute } from "@/app/api/v2/admin/ops/providers/route";
import { GET as riskRoute } from "@/app/api/v2/admin/risk/abuse/route";
import { GET as analyticsRoute } from "@/app/api/v2/admin/analytics/overview/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { createUser, purgeTestData } from "@/server/test/helpers";

const P = "zt-v2window-";
const actor = { userId: `${P}admin`, role: "admin" as const };

describe.each([
  ["Providers", "/api/v2/admin/ops/providers", providerRoute],
  ["Risk", "/api/v2/admin/risk/abuse", riskRoute],
  ["Product Health legacy", "/api/v2/admin/analytics/overview", analyticsRoute],
] as const)("%s time window authority", (_name, url, handler) => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: actor.userId, role: actor.role, dataClass: "internal" });
  });

  afterAll(async () => {
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it.each([
    { from: "2100-10-06T02:00:00.000Z", to: "2100-10-06T01:00:00.000Z" },
    { from: "2100-10-06T02:00:00.000Z" },
    { to: "2000-01-01T00:00:00.000Z" },
  ])("rejects inversion after resolving explicit or default endpoints: %j", async (query) => {
    const result = await callAdminV2(handler, { url, actor, query });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("bad_request");
    expect(result.ok).toBe(false);
  });

  it.each([
    { from: "2100-10-06T00:00:00.000Z", to: "2100-10-06T01:00:00.000Z" },
    { from: "2100-10-06T00:00:00.000Z", to: "2100-10-06T00:00:00.000Z" },
  ])("preserves a legal future or inclusive empty window: %j", async (query) => {
    const result = expectAdminV2Ok(await callAdminV2(handler, { url, actor, query }));
    expect(result.data.window).toEqual(query);
    if (url.endsWith("/providers")) expect(result.data.providers).toEqual([]);
    else if (url.endsWith("/abuse")) expect(result.data).toMatchObject({ deviceClusters: [], referralAbuse: [], adjustAnomalies: [] });
    else expect(result.data.generation.total).toBe(0);
  });

  it("keeps the default thirty-day window valid", async () => {
    const result = expectAdminV2Ok(await callAdminV2(handler, { url, actor }));
    expect(Date.parse(result.data.window.to) - Date.parse(result.data.window.from)).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
