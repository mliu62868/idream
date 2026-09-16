import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

// SPEC: 恢复不了就不许记 `overturned` —— 这条守卫本来就是 fail-closed 的，本用例钉的是它**怎么拒**。
// INTENT: 它原先抛的是一句没有 details 的 conflict，而前端把「没有 blocker 的 409」一律翻译成
//         「已经有人改过这条记录，刷新后重新判断」。可这里的原因是
//         manual_followup_required / unresolvable_feed_item —— 刷一万次也不会变，
//         运营会一直刷下去。restoreReason 在抛异常前一行就已经算出来了，之前只是被丢掉。
describe("appeal overturn refusal carries the authority's own reason", () => {
  const suffix = randomUUID();
  const token = `appeal-blocker-${suffix}`;
  const adminId = `${token}-admin`;
  const userId = `${token}-user`;
  const admin = { userId: adminId, role: "admin" };
  let appealId = "";

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active", dataClass: "internal" },
        { id: userId, email: `${userId}@example.test`, role: "user", status: "active", dataClass: "customer" },
      ],
    });
    const appeal = await prisma.appeal.create({
      data: {
        // chat_message 没有实现下架，所以也没有恢复路径 —— 恢复逻辑会走到默认分支。
        userId,
        targetType: "chat_message",
        targetId: `${token}-message`,
        status: "open",
        appealText: "Restoring this target has no implemented path.",
      },
    });
    appealId = appeal.id;
  });

  afterAll(async () => {
    const cases = await prisma.adminCase.findMany({
      where: { evidence: { some: { sourceId: appealId } } },
      select: { id: true },
    });
    const caseIds = cases.map((row) => row.id);
    await prisma.decisionRecord.deleteMany({ where: { sourceType: "admin_case", sourceId: { in: caseIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [appealId, ...caseIds] } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [appealId, ...caseIds] } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: caseIds } } });
    await prisma.appeal.deleteMany({ where: { id: appealId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
    await prisma.$disconnect();
  });

  it("refuses with a structured blocker instead of a bare conflict", async () => {
    const response = await adminV2(
      "POST",
      `/api/v2/admin/moderation/appeals/${appealId}/decision`,
      {
        ...admin,
        body: { outcome: "overturned", reason: "Customer appeal accepted", confirmation: appealId },
      },
    );
    expect(response.status).toBe(409);
    // blocker 存在，前端的 CONFLICT_PRECONDITION 文案才会取代「有人并发改过」的默认翻译。
    expect(response.error).toMatchObject({
      details: { blocker: "manual_followup_required", targetType: "chat_message" },
    });
    // fail-closed 的部分不能被这次改动碰坏：申诉必须还开着。
    const appeal = await prisma.appeal.findUniqueOrThrow({ where: { id: appealId } });
    expect(appeal.status).toBe("open");
  });
});
