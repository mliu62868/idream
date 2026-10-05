import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

describe("generation metrics profile attribution", () => {
  const token = `metrics-profile-${randomUUID()}`;
  const adminId = `${token}-admin`;
  const customerId = `${token}-customer`;
  const profileKey = `${token}-profile`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active", dataClass: "internal" },
      { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active", dataClass: "customer" },
    ] });
    await prisma.generationModelProfile.createMany({ data: [1, 2].map(version => ({
      id: `${token}-profile-v${version}`,
      profileKey,
      version,
      label: `Profile version ${version}`,
      mode: "image",
      pipelineModel: "test-model",
      workflowKey: `workflow-v${version}`,
      allowedOrientations: ["1:1"],
      status: version === 1 ? "archived" : "active",
    })) });
    const createdAt = new Date(Date.now() - 60 * 60 * 1_000);
    await prisma.generationJob.createMany({ data: [
      { suffix: "v1", profileId: profileKey, profileVersion: 1, duration: 1_000 },
      { suffix: "v2", profileId: profileKey, profileVersion: 2, duration: 100_000 },
      { suffix: "unversioned", profileId: profileKey, profileVersion: null, duration: 3_000 },
      { suffix: "row-id", profileId: `${token}-profile-v1`, profileVersion: 1, duration: 2_000 },
    ].map(row => ({
      id: `${token}-job-${row.suffix}`,
      userId: customerId,
      mode: "image",
      controls: {},
      presetIds: [],
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      status: "completed",
      sourceType: "generator",
      createdAt,
      completedAt: new Date(createdAt.getTime() + row.duration),
    })) });
  });

  afterAll(async () => {
    await prisma.generationJob.deleteMany({ where: { userId: customerId } });
    await prisma.generationModelProfile.deleteMany({ where: { profileKey } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, customerId] } } });
    await prisma.$disconnect();
  });

  it("keeps each pinned version's workflow and latency separate and does not guess an unversioned route", async () => {
    const response = await adminV2("GET", "/api/v2/admin/generation/metrics?days=7", { userId: adminId, role: "admin" });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const rows = response.data.profiles.filter((row: { profileId: string }) => row.profileId === profileKey);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileVersion: 1, label: "Profile version 1", workflowKey: "workflow-v1", avgDurationMs: 1_000 }),
      expect.objectContaining({ profileVersion: 2, label: "Profile version 2", workflowKey: "workflow-v2", avgDurationMs: 100_000 }),
      expect.objectContaining({ profileVersion: null, label: null, workflowKey: null, avgDurationMs: 3_000 }),
    ]));
  });

  it("resolves a recorded profile row id to that exact version's metadata", async () => {
    const response = await adminV2("GET", "/api/v2/admin/generation/metrics?days=7", { userId: adminId, role: "admin" });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    expect(response.data.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: `${token}-profile-v1`, profileVersion: 1, label: "Profile version 1", workflowKey: "workflow-v1", avgDurationMs: 2_000 }),
    ]));
  });

  it("counts only the returned frozen half-open period and drills to the same failed jobs", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const from = new Date("2026-09-28T12:00:00.000Z");
    const scopeProfile = `${token}-frozen`;
    const recipeId = `${token}-recipe`;
    const rows = [
      { key: "from", createdAt: from, status: "failed" },
      { key: "inside", createdAt: new Date("2026-10-01T12:00:00.000Z"), status: "failed" },
      { key: "before", createdAt: new Date(from.getTime() - 1), status: "failed" },
      { key: "to", createdAt: now, status: "failed" },
      { key: "future-completed", createdAt: new Date(now.getTime() + 1), status: "completed" },
    ];
    await prisma.generationJob.createMany({ data: rows.map(row => ({
      id: `${token}-frozen-${row.key}`, userId: customerId, mode: "image", controls: {}, presetIds: [],
      profileId: scopeProfile, profileVersion: 2, recipeId, sourceType: `${token}-source`, status: row.status,
      createdAt: row.createdAt, completedAt: row.status === "completed" ? new Date(row.createdAt.getTime() + 1_000) : null,
    })) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const response = await adminV2("GET", "/api/v2/admin/generation/metrics?days=7", { userId: adminId, role: "admin" });
      expect(response.status, JSON.stringify(response.error)).toBe(200);
      const metric = response.data.profiles.find((row: { profileId: string }) => row.profileId === scopeProfile);
      expect(metric).toMatchObject({ total: 2, failed: 2, completed: 0, profileVersion: 2, avgDurationMs: null });
      expect(response.data.recipes.find((row: { recipeId: string }) => row.recipeId === recipeId)).toMatchObject({ total: 2, failed: 2 });
      expect(response.data.sources.find((row: { sourceType: string }) => row.sourceType === `${token}-source`)).toMatchObject({ total: 2, failed: 2 });
      const period = response.data.periods.current;
      expect(period).toMatchObject({ from: from.toISOString(), to: now.toISOString() });
      const jobs = await adminV2("GET", "/api/v2/admin/jobs", { userId: adminId, role: "admin", query: {
        mode: "all", legacyStatus: "failed", from: period.from, to: period.to,
        profileId: scopeProfile, profileVersion: "2", recipeId, sourceType: `${token}-source`,
      } });
      expect(jobs.status, JSON.stringify(jobs.error)).toBe(200);
      expect(jobs.data.summary.totalCount).toBe(metric.failed);
      expect(jobs.data.items.map((row: { id: string }) => row.id).sort()).toEqual([`${token}-frozen-from`, `${token}-frozen-inside`].sort());
    } finally {
      vi.useRealTimers();
      await prisma.generationJob.deleteMany({ where: { profileId: scopeProfile } });
    }
  });
});
