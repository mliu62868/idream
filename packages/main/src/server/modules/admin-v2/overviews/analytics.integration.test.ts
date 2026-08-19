import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as analyticsExportRoute } from "@/app/api/v2/admin/analytics/export/route";
import { GET as flagMonitoringRoute } from "@/app/api/v2/admin/analytics/flag-monitoring/route";
import { GET as analyticsRetentionRoute } from "@/app/api/v2/admin/analytics/retention/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { createUser, purgeTestData } from "@/server/test/helpers";

const P = "zt-v2ana-";
const admin = { userId: `${P}admin`, role: "admin" };
const ops = { userId: `${P}ops`, role: "ops" }; // lacks analytics.export

describe("Admin v2 analytics export, retention, and flag monitoring", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: admin.userId, role: "admin", dataClass: "internal" });
    await createUser({ id: ops.userId, role: "ops", dataClass: "internal" });
  });

  afterAll(async () => {
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it("returns a CSV payload and an explicitly invalid retention answer", async () => {
    expect(
      (await callAdminV2(analyticsExportRoute, {
        url: "/api/v2/admin/analytics/export",
        actor: ops,
      })).status,
    ).toBe(403);

    const csv = expectAdminV2Ok(await callAdminV2(analyticsExportRoute, {
      url: "/api/v2/admin/analytics/export",
      actor: admin,
    }));
    expect(csv.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(csv.data.window.days).toBe(30);
    expect(typeof csv.data.csv).toBe("string");
    expect(csv.data.csv).toContain("section");

    const scoped = expectAdminV2Ok(await callAdminV2(analyticsExportRoute, {
      url: "/api/v2/admin/analytics/export",
      actor: admin,
      query: { days: "7" },
    }));
    expect(scoped.data.window.days).toBe(7);

    const retention = expectAdminV2Ok(await callAdminV2(analyticsRetentionRoute, {
      url: "/api/v2/admin/analytics/retention",
      actor: admin,
    }));
    expect(retention.data).toMatchObject({
      qualityState: "invalid",
      validForDecisions: false,
      metricVersion: "legacy-v1",
    });
    expect(Array.isArray(retention.data.items)).toBe(true);
  });

  it("lists feature flags with directional metrics, gated by analytics.export", async () => {
    expect(
      (await callAdminV2(flagMonitoringRoute, {
        url: "/api/v2/admin/analytics/flag-monitoring",
        actor: ops,
      })).status,
    ).toBe(403);

    const result = expectAdminV2Ok(await callAdminV2(flagMonitoringRoute, {
      url: "/api/v2/admin/analytics/flag-monitoring",
      actor: admin,
    }));
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(Array.isArray(result.data.items)).toBe(true);
    expect(typeof result.data.note).toBe("string");
  });

  it("rejects a days window outside the declared bounds", async () => {
    const result = await callAdminV2(analyticsExportRoute, {
      url: "/api/v2/admin/analytics/export",
      actor: admin,
      query: { days: "999" },
    });
    expect(result.status).toBe(400);
  });
});
