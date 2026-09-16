import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { listWorkflowDescriptors } from "@/server/modules/generation/generation-catalog";
import { adminV2 } from "@/server/test/admin-v2-http";

// SPEC: 死信队列不能把一条 worker 一定会拒的请求标成「可安全重新排队」。
// INTENT: worker 的 validateWorkflowPin 是 fail-closed 的 —— 上一轮尝试钉死的
//         workflow 版本不在服务中，重试必然被拒。实测过一次：点了「重新入队」之后
//         请求离开死信列表、停在 queued 不再出现在任何一页，白扣一次尝试。
describe("dead-letter retry eligibility honours the workflow pin", () => {
  const suffix = randomUUID();
  const token = `dl-pin-${suffix}`;
  const adminId = `${token}-admin`;
  const customerId = `${token}-customer`;
  const retiredJobId = `${token}-job-retired`;
  const servedJobId = `${token}-job-served`;
  const admin = { userId: adminId, role: "admin" };
  let servedWorkflowKey = "";
  let servedVersion = 0;

  beforeAll(async () => {
    const descriptors = await listWorkflowDescriptors();
    const descriptor = descriptors.find((item) => item.version > 1) ?? descriptors[0];
    if (!descriptor) throw new Error("no workflow descriptor available for this fixture");
    servedWorkflowKey = descriptor.workflowKey;
    servedVersion = descriptor.version;

    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active", dataClass: "internal" },
        { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active", dataClass: "customer" },
      ],
    });
    await prisma.generationJob.createMany({
      data: [retiredJobId, servedJobId].map((id, index) => ({
        id,
        userId: customerId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        errorCode: token,
        costDreamcoins: 0,
        sourceType: "dead_letter_pin_test",
        sourceId: `${token}-source-${index}`,
        updatedAt: new Date(Date.UTC(2026, 6, 11, 3, index)),
      })),
    });
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: `${token}-attempt-retired`,
          requestId: retiredJobId,
          attemptNo: 1,
          status: "failed",
          // INVARIANT: 终态尝试必须有 finishedAt —— 库里有 generation_attempt_terminal_time_check。
          finishedAt: new Date(Date.UTC(2026, 6, 11, 3, 0)),
          workflowKey: servedWorkflowKey,
          // 比在服务中的版本旧一格：这条钉子已经没有 worker 认。
          workflowVersion: servedVersion - 1,
        },
        {
          id: `${token}-attempt-served`,
          requestId: servedJobId,
          attemptNo: 1,
          status: "failed",
          finishedAt: new Date(Date.UTC(2026, 6, 11, 3, 1)),
          workflowKey: servedWorkflowKey,
          workflowVersion: servedVersion,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: [retiredJobId, servedJobId] } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: [retiredJobId, servedJobId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, customerId] } } });
    await prisma.$disconnect();
  });

  it("marks a retired pin ineligible and leaves a served pin retryable", async () => {
    const response = await adminV2("GET", `/api/v2/admin/generation/dead-letter?search=${token}&status=failed&limit=10`, admin);
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const byId = new Map(
      (response.data.items as { id: string; retryEligibility: { eligible: boolean; reason: string } }[])
        .map((item) => [item.id, item.retryEligibility]),
    );
    expect(byId.get(retiredJobId)).toEqual({ eligible: false, reason: "pinned_workflow_retired" });
    expect(byId.get(servedJobId)).toEqual({ eligible: true, reason: "retryable_failure" });
  });

  it("refuses the requeue command for a retired pin", async () => {
    const response = await adminV2(
      "POST",
      `/api/v2/admin/generation/dead-letter/${retiredJobId}/commands/requeue`,
      { ...admin, body: { confirmation: retiredJobId, reason: "pin guard regression" } },
    );
    expect(response.status).toBe(409);
    expect(response.error).toMatchObject({ details: { reason: "pinned_workflow_retired" } });
    const attempts = await prisma.generationAttempt.count({ where: { requestId: retiredJobId } });
    expect(attempts).toBe(1);
  });
});
