import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

type PageInfo = { endCursor: string | null; hasNextPage: boolean };

describe("Admin v2 moderation queue", () => {
  const suffix = randomUUID();
  const token = `moderation-queue-${suffix}`;
  const actorId = `moderation-queue-admin-${suffix}`;
  const ids = (kind: string) => [0, 1].map((index) => `${token}-${kind}-${index}`);

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${token}@example.test`, role: "admin", status: "active" },
    });
    await prisma.contentReport.createMany({ data: ids("report").map((id, index) => ({
      id,
      reporterId: actorId,
      targetType: "character",
      targetId: `${token}-target-${index}`,
      category: token,
      status: "open",
      priority: 3,
      createdAt: new Date(Date.UTC(2026, 6, 11, 4, index)),
    })) });
    await prisma.mediaAsset.createMany({ data: ids("media").map((id, index) => ({
      id,
      ownerId: actorId,
      type: "image",
      url: `memory://${id}`,
      safetyStatus: "blocked",
      metadata: { token },
      createdAt: new Date(Date.UTC(2026, 6, 11, 5, index)),
    })) });
    await prisma.appeal.createMany({ data: ids("appeal").map((id, index) => ({
      id,
      userId: actorId,
      targetType: "character",
      targetId: `${token}-appeal-target-${index}`,
      status: "open",
      appealText: token,
      createdAt: new Date(Date.UTC(2026, 6, 11, 6, index)),
    })) });
  });

  afterAll(async () => {
    await prisma.appeal.deleteMany({ where: { id: { in: ids("appeal") } } });
    await prisma.contentReport.deleteMany({ where: { id: { in: ids("report") } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: ids("media") } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  function queue(query: Record<string, string | number>) {
    return adminV2("GET", "moderation/queue", { userId: actorId, role: "admin", query });
  }

  it("paginates all three moderation collections independently", async () => {
    const first = await queue({ search: token, limit: 1 });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const data = first.data as {
      reports: Array<{ id: string }>;
      mediaReview: Array<{ id: string }>;
      appeals: Array<{ id: string }>;
      pageInfo: { reports: PageInfo; mediaReview: PageInfo; appeals: PageInfo };
    };
    expect(data.reports).toHaveLength(1);
    expect(data.mediaReview).toHaveLength(1);
    expect(data.appeals).toHaveLength(1);
    expect(data.pageInfo.reports.hasNextPage).toBe(true);
    expect(data.pageInfo.mediaReview.hasNextPage).toBe(true);
    expect(data.pageInfo.appeals.hasNextPage).toBe(true);

    const second = await queue({
      search: token,
      limit: 1,
      reportCursor: data.pageInfo.reports.endCursor ?? "",
      mediaCursor: data.pageInfo.mediaReview.endCursor ?? "",
      appealCursor: data.pageInfo.appeals.endCursor ?? "",
    });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const secondData = second.data as typeof data;
    expect(secondData.reports[0]?.id).not.toBe(data.reports[0]?.id);
    expect(secondData.mediaReview[0]?.id).not.toBe(data.mediaReview[0]?.id);
    expect(secondData.appeals[0]?.id).not.toBe(data.appeals[0]?.id);
  });

  it("isolates malformed moderation cursors to the requested authority", async () => {
    const result = await queue({
      scope: "media",
      search: token,
      limit: 1,
      reportCursor: "not-a-report-cursor",
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.data).toMatchObject({
      reports: [],
      mediaReview: [{ id: ids("media")[0] }],
      appeals: [],
    });
  });

  it("rejects a cursor bound to a different query", async () => {
    const first = await queue({ search: token, limit: 1 });
    const mismatch = await queue({
      search: "different",
      limit: 1,
      reportCursor: first.data.pageInfo.reports.endCursor ?? "",
    });
    expect(mismatch.status).toBe(400);
  });
});
