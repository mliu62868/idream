import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actorWithPermission: vi.fn(),
  groupGenerationJobs: vi.fn(),
  listGenerationJobs: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    generationJob: {
      groupBy: mocks.groupGenerationJobs,
      findMany: mocks.listGenerationJobs,
    },
  },
}));

vi.mock("@/server/modules/admin-v2/shared/authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/modules/admin-v2/shared/authority")>()),
  actorWithPermission: mocks.actorWithPermission,
}));

import { getProviderOperations } from "./providers";

const url = "http://localhost/api/v2/admin/ops/providers";

describe("provider operations rollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actorWithPermission.mockResolvedValue({ id: "admin-1", role: "admin" });
    mocks.groupGenerationJobs.mockResolvedValue([]);
    mocks.listGenerationJobs.mockResolvedValue([]);
  });

  it("excludes fixture and audit owners", async () => {
    const payload = await getProviderOperations(new Request(url));

    expect(payload.dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal", "operational"],
      excludedDataClasses: ["fixture", "audit"],
    });
    for (const call of mocks.groupGenerationJobs.mock.calls) {
      expect(call[0]).toMatchObject({
        where: {
          AND: [
            { user: { is: { dataClass: { in: ["customer", "internal"] } } } },
            {},
          ],
        },
      });
    }
    expect(mocks.listGenerationJobs.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          { user: { is: { dataClass: { in: ["customer", "internal"] } } } },
          { status: "completed", completedAt: { not: null } },
        ],
      },
    });
  });

  it("reports unavailable latency when there are no completed samples", async () => {
    mocks.groupGenerationJobs.mockResolvedValue([
      { provider: "backend", status: "queued", _count: { _all: 2 }, _sum: { costDreamcoins: 10 } },
    ]);

    const payload = await getProviderOperations(new Request(url));

    expect(payload.providers).toEqual([
      expect.objectContaining({
        provider: "backend",
        latencyP50Ms: null,
        latencyP95Ms: null,
        latencySamples: 0,
      }),
    ]);
  });

  it("rejects an unparsable window instead of silently widening it", async () => {
    await expect(getProviderOperations(new Request(`${url}?from=not-a-date`)))
      .rejects.toMatchObject({ status: 400 });
  });
});
