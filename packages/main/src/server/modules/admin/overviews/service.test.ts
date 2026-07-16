import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actorWithPermission: vi.fn(),
  countUsers: vi.fn(),
  groupGenerationJobs: vi.fn(),
  listGenerationJobs: vi.fn(),
  groupSubscriptions: vi.fn(),
  aggregateLedger: vi.fn(),
  groupLedger: vi.fn(),
  groupAnalyticsEvents: vi.fn(),
  groupReferrals: vi.fn(),
  listAnalyticsEvents: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    user: { count: mocks.countUsers },
    generationJob: {
      groupBy: mocks.groupGenerationJobs,
      findMany: mocks.listGenerationJobs,
    },
    subscription: { groupBy: mocks.groupSubscriptions },
    dreamcoinLedger: {
      aggregate: mocks.aggregateLedger,
      groupBy: mocks.groupLedger,
    },
    analyticsEvent: {
      groupBy: mocks.groupAnalyticsEvents,
      findMany: mocks.listAnalyticsEvents,
    },
    referral: { groupBy: mocks.groupReferrals },
  },
}));

vi.mock("@/server/modules/admin/shared/legacy-primitives", () => ({
  actorWithPermission: mocks.actorWithPermission,
}));

import { analyticsOverview, providerOps } from "./service";

describe("legacy overview data scopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actorWithPermission.mockResolvedValue({ id: "admin-1" });
    mocks.countUsers.mockResolvedValue(0);
    mocks.groupGenerationJobs.mockResolvedValue([]);
    mocks.listGenerationJobs.mockResolvedValue([]);
    mocks.groupSubscriptions.mockResolvedValue([]);
    mocks.aggregateLedger.mockResolvedValue({ _sum: { delta: null } });
    mocks.groupLedger.mockResolvedValue([]);
    mocks.groupAnalyticsEvents.mockResolvedValue([]);
    mocks.groupReferrals.mockResolvedValue([]);
    mocks.listAnalyticsEvents.mockResolvedValue([]);
  });

  it("uses only customer records for business analytics", async () => {
    const response = await analyticsOverview(
      new Request("http://localhost/api/v1/admin/analytics/overview"),
    );
    const payload = (await response.json()) as {
      data: { dataScope: Record<string, unknown> };
    };

    expect(payload.data.dataScope).toEqual({
      kind: "customer",
      includedDataClasses: ["customer"],
      excludedDataClasses: ["internal", "operational", "fixture", "audit"],
    });
    expect(mocks.countUsers.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          { dataClass: "customer" },
          { deletedAt: null },
        ],
      },
    });
    expect(mocks.groupGenerationJobs.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          { user: { is: { dataClass: "customer" } } },
          {},
        ],
      },
    });
    expect(mocks.groupSubscriptions.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          { user: { is: { dataClass: "customer" } } },
          {},
        ],
      },
    });
    expect(mocks.groupAnalyticsEvents.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          { dataClass: "customer" },
          {},
        ],
      },
    });
  });

  it("excludes fixture and audit owners from provider operations", async () => {
    const response = await providerOps(
      new Request("http://localhost/api/v1/admin/ops/providers"),
    );
    const payload = (await response.json()) as {
      data: { dataScope: Record<string, unknown> };
    };

    expect(payload.data.dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal", "operational"],
      excludedDataClasses: ["fixture", "audit"],
    });
    for (const call of mocks.groupGenerationJobs.mock.calls) {
      expect(call[0]).toMatchObject({
        where: {
          AND: [
            {
              user: {
                is: {
                  dataClass: { in: ["customer", "internal"] },
                },
              },
            },
            {},
          ],
        },
      });
    }
    expect(mocks.listGenerationJobs.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          {
            user: {
              is: {
                dataClass: { in: ["customer", "internal"] },
              },
            },
          },
          { status: "completed", completedAt: { not: null } },
        ],
      },
    });
  });
});
