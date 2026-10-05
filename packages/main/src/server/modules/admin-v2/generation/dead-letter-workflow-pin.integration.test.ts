import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
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
  const jobIds = [retiredJobId, servedJobId];

  beforeAll(async () => {
    const descriptors = await listWorkflowDescriptors();
    const imageDescriptors = descriptors.filter(item => item.capabilities.includes("textToImage"));
    const descriptor = imageDescriptors.find((item) => item.version > 1) ?? imageDescriptors[0];
    if (!descriptor) throw new Error("no image workflow descriptor available for this fixture");
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
    const attempts = await prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } }, select: { id: true } });
    const commands = await prisma.controlPlaneCommand.findMany({ where: { actorId: adminId }, select: { id: true } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commands.map(command => command.id) } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [...jobIds, ...attempts.map(attempt => attempt.id)] } } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { userId: customerId } });
    await prisma.generationJobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attempts.map(attempt => attempt.id) } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
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

  it.each(["single", "batch"] as const)("requeues a zero-cost confirmed unknown through the %s API without rewriting its Attempt", async kind => {
    const unknown = await retryFixture("unknown");
    const settled = await confirmFailed(unknown.jobId);
    expect(settled).toMatchObject({ requestStatus: "failed", attemptStatus: "unknown", refundAmount: 0, version: 2 });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: unknown.jobId } }))
      .toMatchObject({ status: "failed", errorCode: "operator_confirmed_provider_failure", version: 2 });
    const oldAttempt = await prisma.generationAttempt.findUniqueOrThrow({ where: { id: unknown.attemptId } });
    expect(oldAttempt).toMatchObject({ status: "unknown", retryability: "not_retryable", terminalSequence: 1 });
    expect(await eligibility(unknown.jobId)).toEqual({ eligible: true, reason: "retryable_failure" });
    const normal = kind === "batch" ? await retryFixture("failed") : null;
    const selectedIds = normal ? [normal.jobId, unknown.jobId] : [unknown.jobId];
    const idempotencyKey = `${unknown.jobId}:retry`;
    const first = await requeue(selectedIds, kind, idempotencyKey);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    if (kind === "batch") {
      expect(first.data.skipped).toEqual([]);
      expect(first.data.requeued).toHaveLength(selectedIds.length);
      expect(new Set(first.data.requeued)).toEqual(new Set(selectedIds));
    }
    else expect(first.data).toMatchObject({ queued: true, attemptNo: 2 });
    const repeated = await requeue(selectedIds, kind, idempotencyKey);
    expect(repeated.status, JSON.stringify(repeated.error)).toBe(200);
    expect(repeated.data).toEqual(first.data);
    for (const jobId of selectedIds) {
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "queued", version: jobId === unknown.jobId ? 3 : 2 });
      expect(await prisma.generationAttempt.count({ where: { requestId: jobId } })).toBe(2);
      expect(await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId, attemptNo: 2 } }))
        .toMatchObject({ status: "queued", workflowKey: servedWorkflowKey, workflowVersion: servedVersion });
      expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: jobId, eventType: "generation.retry.dispatch.v2" } })).toBe(1);
      expect(await prisma.mainOutboxEvent.findFirstOrThrow({ where: { aggregateId: jobId, eventType: "generation.retry.dispatch.v2" } }))
        .toMatchObject({ status: "pending", deliveredAt: null });
    }
    // A new Attempt is a separate fact; neither retry nor replay may alter the terminal unknown fact.
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: unknown.attemptId } })).toEqual(oldAttempt);
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId: unknown.attemptId } })).toBe(1);
    expect(await prisma.generationJobEvent.count({ where: { jobId: unknown.jobId, type: "unknown_reconciliation_confirm_failed" } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: unknown.jobId } })).toBe(0);
  });

  it.each(["pending_unknown", "blocked", "non_retryable_failed"] as const)("keeps %s out of the requeue API", async state => {
    const fixture = await retryFixture(state === "pending_unknown" ? "unknown" : state === "blocked" ? "blocked" : "failed", 0, "not_retryable");
    const oldAttempt = await prisma.generationAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    const response = await requeue([fixture.jobId], "single", `${fixture.jobId}:refused-retry`);
    expect(response.status).toBe(409);
    expect(await prisma.generationAttempt.count({ where: { requestId: fixture.jobId } })).toBe(1);
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } })).toEqual(oldAttempt);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: fixture.jobId, eventType: "generation.retry.dispatch.v2" } })).toBe(0);
  });

  it("retains the dead-letter refund guard after a paid unknown is confirmed failed", async () => {
    const fixture = await retryFixture("unknown", 5);
    expect(await confirmFailed(fixture.jobId)).toMatchObject({ requestStatus: "failed", attemptStatus: "unknown", refundAmount: 5 });
    expect(await eligibility(fixture.jobId)).toEqual({ eligible: false, reason: "refunded" });
    const oldAttempt = await prisma.generationAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    for (const kind of ["single", "batch"] as const) {
      const response = await requeue([fixture.jobId], kind, `${fixture.jobId}:${kind}:refused-retry`);
      expect(response.status).toBe(kind === "single" ? 409 : 200);
      if (kind === "batch") expect(response.data).toEqual({ requeued: [], skipped: [{ id: fixture.jobId, reason: "refunded" }] });
    }
    expect(await prisma.generationAttempt.count({ where: { requestId: fixture.jobId } })).toBe(1);
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } })).toEqual(oldAttempt);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: fixture.jobId, reason: "refund", delta: 5 } })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: fixture.jobId, eventType: "generation.retry.dispatch.v2" } })).toBe(0);
  });

  async function retryFixture(outcome: "unknown" | "failed" | "blocked", cost = 0, retryability = outcome === "unknown" ? "not_retryable" : "operator_retry") {
    const jobId = `${token}-${outcome}-${randomUUID()}`;
    jobIds.push(jobId);
    await prisma.generationJob.create({ data: {
      id: jobId, userId: customerId, mode: "image", provider: "mock", controls: {}, presetIds: [],
      status: outcome === "unknown" ? "queued" : outcome, costDreamcoins: cost,
      sourceType: cost === 0 ? "content_production_item" : "generator", sourceId: `${jobId}:source`,
    } });
    const attempt = await prisma.generationAttempt.create({ data: {
      requestId: jobId, attemptNo: 1, provider: "mock", status: "queued", workflowKey: servedWorkflowKey, workflowVersion: servedVersion,
    } });
    await prisma.$transaction(async tx => {
      if (cost > 0) {
        await postDreamcoinEntry(tx, { kind: "signup_bonus", userId: customerId, amount: 20, sourceId: `${jobId}:bonus`, idempotencyKey: `${jobId}:bonus` });
        await postDreamcoinEntry(tx, { kind: "generation_spend", userId: customerId, amount: cost, sourceId: jobId, idempotencyKey: `${jobId}:spend` });
      }
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attempt.id}:terminal`, attemptId: attempt.id, eventType: `generation.attempt.${outcome}.v1`,
        outcome, occurredAt: new Date(), payload: { requestId: jobId }, errorCode: `${outcome}_fixture`, retryability,
      });
    });
    return { jobId, attemptId: attempt.id };
  }

  async function confirmFailed(jobId: string) {
    const response = await adminV2("POST", `/api/v2/admin/jobs/${jobId}/commands/reconcile-unknown`, {
      ...admin, idempotencyKey: `${jobId}:confirm-failed`, body: {
        resolution: "confirm_failed", entityVersion: 1, reason: "Controlled provider evidence confirms failure",
        providerEvidenceRefs: [`request:${jobId}:provider-log`], confirmation: `${jobId}:confirm_failed`,
      },
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    return response.data;
  }

  async function eligibility(jobId: string) {
    const response = await adminV2("GET", `/api/v2/admin/generation/dead-letter?search=${jobId}&status=all&limit=10`, admin);
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    return (response.data.items as { id: string; retryEligibility: { eligible: boolean; reason: string } }[])
      .find(item => item.id === jobId)?.retryEligibility;
  }

  function requeue(ids: string[], kind: "single" | "batch", idempotencyKey: string) {
    return adminV2("POST", kind === "single" ? `/api/v2/admin/generation/dead-letter/${ids[0]}/commands/requeue` : "/api/v2/admin/generation/dead-letter/commands/requeue", {
      ...admin, idempotencyKey, body: kind === "single"
        ? { confirmation: ids[0], reason: "Controlled retry after provider review" }
        : { jobIds: ids, confirmation: ids.join(","), reason: "Controlled batch retry after provider review" },
    });
  }
});
