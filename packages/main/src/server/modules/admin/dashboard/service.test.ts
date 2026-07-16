import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actorWithPermission: vi.fn(),
  countUsers: vi.fn(),
  countGenerationJobs: vi.fn(),
  countReports: vi.fn(),
  countSubscriptions: vi.fn(),
  listFlags: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    user: {
      count: mocks.countUsers,
    },
    generationJob: {
      count: mocks.countGenerationJobs,
    },
    contentReport: {
      count: mocks.countReports,
    },
    subscription: {
      count: mocks.countSubscriptions,
    },
    featureFlag: {
      findMany: mocks.listFlags,
    },
  },
}));

vi.mock("@/server/modules/admin/shared/legacy-primitives", () => ({
  actorWithPermission: mocks.actorWithPermission,
}));

import { adminDashboard } from "./service";

describe("admin dashboard truth semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actorWithPermission.mockResolvedValue({ id: "analyst-1" });
    mocks.countUsers.mockResolvedValue(0);
    mocks.countGenerationJobs.mockResolvedValue(0);
    mocks.countReports.mockResolvedValue(0);
    mocks.countSubscriptions.mockResolvedValue(0);
    mocks.listFlags.mockResolvedValue([]);
  });

  it("returns an unavailable success rate when no generation jobs have finished", async () => {
    const response = await adminDashboard(
      new Request("http://localhost/api/v1/admin/dashboard"),
    );
    const payload = (await response.json()) as {
      data: {
        metrics: { generation: { successRate: number | null } };
      };
    };

    expect(payload.data.metrics.generation.successRate).toBeNull();
  });
});
