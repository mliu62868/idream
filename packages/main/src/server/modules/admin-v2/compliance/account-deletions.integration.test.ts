import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

// SPEC: 擦除队列要分得开「按设计在等」和「已经欠着」。
// INTENT: 库里 status 只有四个值，其中 `awaiting_chat` 同时覆盖这两件事——我自己就照着
//         status 把一批正常处于宽限期的请求读成了「卡死 27 天」。派生的 waitingOn / pastDue
//         存在的唯一理由就是不让下一个人再读错，所以这两件事必须各有一条用例钉住。
describe("compliance account deletion queue", () => {
  const suffix = randomUUID();
  const token = `acct-del-${suffix}`;
  const adminId = `${token}-admin`;
  const admin = { userId: adminId, role: "admin" };
  const inGraceId = `${token}-in-grace`;
  const dueId = `${token}-due`;
  const blockedId = `${token}-blocked`;
  const doneId = `${token}-done`;
  const ids = [inGraceId, dueId, blockedId, doneId];
  const requestEventId = `${token}-request-event`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active", dataClass: "internal" },
    });
    const past = new Date(Date.now() - 40 * 86_400_000);
    const chatTerminal = (id: string) => ({
      chatCompletionEventId: `${id}-completion`,
      chatFileMutationId: `${id}-mutation`,
      chatCompletedAt: new Date(),
    });
    await prisma.accountDeletion.createMany({
      data: [
        {
          id: inGraceId,
          userId: `${inGraceId}-user`,
          subjectHash: `${inGraceId}-hash`,
          status: "awaiting_chat",
          requestedAt: new Date(),
          graceEndsAt: new Date(Date.now() + 20 * 86_400_000),
          chatRequestEventId: `${inGraceId}-event`,
        },
        {
          id: dueId,
          userId: `${dueId}-user`,
          subjectHash: `${dueId}-hash`,
          status: "awaiting_chat",
          requestedAt: past,
          graceEndsAt: new Date(Date.now() - 86_400_000),
          chatRequestEventId: requestEventId,
        },
        {
          id: blockedId,
          userId: `${blockedId}-user`,
          subjectHash: `${blockedId}-hash`,
          status: "finalizing",
          requestedAt: past,
          graceEndsAt: new Date(Date.now() - 2 * 86_400_000),
          chatRequestEventId: `${blockedId}-event`,
          ...chatTerminal(blockedId),
          lastError: { code: "account_deletion_active_legal_hold", message: "held" },
        },
        {
          id: doneId,
          // INVARIANT: account_deletions_terminal_check —— completed 必须 userId 为空、
          //            chatRequestEventId 为空、mainPurgedAt/completedAt 齐全。
          subjectHash: `${doneId}-hash`,
          status: "completed",
          requestedAt: past,
          graceEndsAt: new Date(Date.now() - 10 * 86_400_000),
          ...chatTerminal(doneId),
          mainPurgedAt: new Date(),
          completedAt: new Date(),
        },
      ],
    });
    await prisma.mainOutboxEvent.create({
      data: {
        id: requestEventId,
        eventType: "user.account_deletion.requested.v2",
        aggregateType: "user",
        aggregateId: `${dueId}-user`,
        payload: {},
        status: "pending",
        attempts: 0,
        nextRunAt: new Date(Date.now() - 86_400_000),
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { id: requestEventId } });
    await prisma.accountDeletion.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  async function rowsById() {
    const response = await adminV2("GET", "/api/v2/admin/compliance/account-deletions?scope=all&limit=200", admin);
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const items = response.data.items as { id: string }[];
    return {
      pastDueCount: response.data.pastDueCount as number,
      byId: new Map(items.map((item) => [item.id, item as Record<string, unknown>])),
    };
  }

  it("does not call a request inside its grace period late", async () => {
    const { byId } = await rowsById();
    expect(byId.get(inGraceId)).toMatchObject({ waitingOn: "grace_period", pastDue: false });
  });

  it("marks a request past its grace period and exposes why Chat has not acted", async () => {
    const { byId, pastDueCount } = await rowsById();
    expect(byId.get(dueId)).toMatchObject({
      waitingOn: "chat_erasure",
      pastDue: true,
      // 这三个字段合起来才说得出「一次都没被取走」——只看 status 看不出来。
      chatRequestDelivery: { status: "pending", attempts: 0 },
    });
    expect(pastDueCount).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the authority's own blocker instead of a generic stall", async () => {
    const { byId } = await rowsById();
    expect(byId.get(blockedId)).toMatchObject({
      waitingOn: "main_purge",
      blockedReason: "account_deletion_active_legal_hold",
    });
  });

  it("keeps erased requests out of the in-flight scope", async () => {
    const response = await adminV2("GET", "/api/v2/admin/compliance/account-deletions?limit=200", admin);
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const items = response.data.items as { id: string }[];
    const listed = new Set(items.map((item) => item.id));
    expect(listed.has(doneId)).toBe(false);
    expect(listed.has(dueId)).toBe(true);
    const { byId } = await rowsById();
    expect(byId.get(doneId)).toMatchObject({ waitingOn: "nothing", pastDue: false, userId: null });
  });
});
