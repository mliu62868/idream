import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { ensureReviewCaseForReport, recordReviewCaseDecisionAtomic } from "./service";

// SPEC: Case 级复核决定要么把来源记录一起推到终态，要么直接拒绝。
// INTENT: 实测过一次真实闭环——认领 → 记录决定 → 覆盖验证 → 关闭工单，全部成功，而
//         content_reports 那一行仍然是 open：举报继续占着审核队列，并且立刻违反
//         open_source_without_case 这条跨表不变式。更糟的是 `actioned` 在这条路径上
//         根本不会调用 applyModerationAction，内容原封不动还挂在线上。
describe("Review Case decisions settle their source", () => {
  const suffix = randomUUID();
  const actorId = `review-settle-actor-${suffix}`;
  const reportId = `review-settle-report-${suffix}`;
  const takedownReportId = `review-settle-takedown-${suffix}`;
  const escalatedReportId = `review-settle-escalated-report-${suffix}`;

  async function seedReport(id: string) {
    const report = await prisma.contentReport.create({
      data: {
        id,
        reporterId: actorId,
        targetType: "character",
        targetId: `${id}-target`,
        category: `review-settle-${suffix}`,
        status: "open",
        priority: 3,
      },
    });
    const adminCase = await ensureReviewCaseForReport(prisma, report);
    if (!adminCase) throw new Error("fixture report did not produce a Review Case");
    const evidence = await prisma.caseEvidence.findFirstOrThrow({
      where: { caseId: adminCase.id, sourceType: "content_report", sourceId: report.id },
    });
    return { adminCase, evidence };
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
    });
  });

  afterAll(async () => {
    const reportIds = [reportId, takedownReportId, escalatedReportId];
    const cases = await prisma.adminCase.findMany({
      where: { evidence: { some: { sourceId: { in: reportIds } } } },
      select: { id: true },
    });
    await prisma.decisionRecord.deleteMany({
      where: { sourceType: "admin_case", sourceId: { in: cases.map((row) => row.id) } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: cases.map((row) => row.id) } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: cases.map((row) => row.id) } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: cases.map((row) => row.id) } } });
    await prisma.contentReport.deleteMany({ where: { id: { in: reportIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("moves the source report out of open when the Case records a decision", async () => {
    const { adminCase, evidence } = await seedReport(reportId);

    await recordReviewCaseDecisionAtomic({
      caseId: adminCase.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: adminCase.version,
      decision: "no_violation",
      summary: "Reviewed from the Case workspace; the report does not violate policy.",
      evidenceRefs: [evidence.id],
      requestId: `review-settle-decision-${suffix}`,
    });

    const report = await prisma.contentReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(report.status).toBe("no_violation");
  });

  // INVARIANT: `escalated` 是「转交别的流程」，不是举报的终态。写进 status 会让它离开
  //            审核队列却没有任何人接手 —— 比留在 open 更糟。
  it("leaves the source untouched for a decision that is not a source-side terminal state", async () => {
    const { adminCase, evidence } = await seedReport(escalatedReportId);

    await recordReviewCaseDecisionAtomic({
      caseId: adminCase.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: adminCase.version,
      decision: "escalated",
      summary: "Handed to the trust and safety escalation path; the report stays open.",
      evidenceRefs: [evidence.id],
      requestId: `review-settle-escalated-${suffix}`,
    });

    const report = await prisma.contentReport.findUniqueOrThrow({ where: { id: escalatedReportId } });
    expect(report.status).toBe("open");
  });

  // INVARIANT: 下架 / 恢复只能出自 moderation 的复合命令 —— 那里才会真的执行效果。
  it("refuses a decision that would change live content", async () => {
    const { adminCase, evidence } = await seedReport(takedownReportId);

    await expect(recordReviewCaseDecisionAtomic({
      caseId: adminCase.id,
      actor: { id: actorId, role: "admin" },
      expectedVersion: adminCase.version,
      decision: "actioned",
      summary: "Attempt to take content down without the moderation command.",
      evidenceRefs: [evidence.id],
      requestId: `review-settle-takedown-${suffix}`,
    })).rejects.toMatchObject({
      code: "conflict",
      details: { blocker: "content_effect_decision_requires_moderation_command" },
    });

    const report = await prisma.contentReport.findUniqueOrThrow({ where: { id: takedownReportId } });
    expect(report.status).toBe("open");
  });
});
