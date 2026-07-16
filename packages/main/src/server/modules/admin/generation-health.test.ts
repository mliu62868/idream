import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actorWithPermission: vi.fn(),
  findProfile: vi.fn(),
  countJobs: vi.fn(),
  listCompletedJobs: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    generationModelProfile: {
      findUnique: mocks.findProfile,
    },
    generationJob: {
      count: mocks.countJobs,
      findMany: mocks.listCompletedJobs,
    },
  },
}));

vi.mock("@/server/modules/admin/shared/legacy-primitives", () => ({
  actorWithPermission: mocks.actorWithPermission,
  clampInt: (
    _value: string | null,
    _minimum: number,
    _maximum: number,
    fallback: number,
  ) => fallback,
  jsonBody: vi.fn(),
  toInputJson: (value: unknown) => value,
  writeAudit: vi.fn(),
}));

import { profileHealth } from "./generation-health";

describe("generation profile health truth semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actorWithPermission.mockResolvedValue({ id: "admin-1" });
    mocks.findProfile.mockResolvedValue({
      id: "profile-1",
      profileKey: "profile-key-1",
    });
    mocks.countJobs.mockResolvedValue(0);
    mocks.listCompletedJobs.mockResolvedValue([]);
  });

  it("returns an unavailable success rate when no jobs have finished", async () => {
    const response = await profileHealth(
      new Request(
        "http://localhost/api/v1/admin/generation/model-profiles/profile-1/health",
      ),
      "profile-1",
    );
    const payload = (await response.json()) as {
      data: { metrics: { successRate: number | null } };
    };

    expect(payload.data.metrics.successRate).toBeNull();
  });
});
