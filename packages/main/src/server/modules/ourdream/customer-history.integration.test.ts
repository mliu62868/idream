import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as supportRequestPatchRoute } from "@/app/api/v2/admin/support/requests/[id]/route";
import { prisma } from "@/server/lib/db";
import {
  api,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";
import { adminV2 } from "@/server/test/trust-safety-admin-v2";

const P = "zt-customer-history-";
const CUSTOMER = `${P}customer`;
const OTHER = `${P}other`;
const OUTSIDER = `${P}outsider`;
const ADMIN = `${P}admin`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: CUSTOMER, dataClass: "customer" });
  await createUser({ id: OTHER, dataClass: "customer" });
  await createUser({ id: OUTSIDER, dataClass: "customer" });
  await createUser({ id: ADMIN, role: "admin", dataClass: "internal" });
});

describe("POST /api/v1/appeals authority", () => {
  it("rejects decisions and targets that do not belong to the appellant", async () => {
    const targetId = `${P}owned-appeal-character`;
    await prisma.character.create({
      data: {
        id: targetId,
        creatorId: CUSTOMER,
        name: "Owned appeal target",
        age: 28,
        description: "A customer-owned Character moderation target.",
        appearance: {},
        advancedDetails: {},
      },
    });
    const report = await prisma.contentReport.create({
      data: {
        id: `${P}owned-appeal-report`,
        reporterId: OTHER,
        targetType: "character",
        targetId,
        category: "other_prohibited_content",
        status: "closed",
      },
    });
    const decision = await prisma.moderationReview.create({
      data: {
        id: `${P}owned-appeal-decision`,
        reportId: report.id,
        reviewerId: ADMIN,
        decision: "actioned",
      },
    });

    expectError(await api("POST", "appeals", {
      userId: OUTSIDER,
      ageGate: true,
      body: {
        targetType: "character",
        targetId,
        originalDecisionId: decision.id,
        appealText: "I must not enter another customer's review case.",
      },
    }), 403, "forbidden");
    expectError(await api("POST", "appeals", {
      userId: OUTSIDER,
      ageGate: true,
      body: {
        targetType: "character",
        targetId,
        appealText: "Inference must not bypass the same authority check.",
      },
    }), 403, "forbidden");
    expectError(await api("POST", "appeals", {
      userId: CUSTOMER,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: `${P}different-target`,
        originalDecisionId: decision.id,
        appealText: "A real decision cannot be rebound to another target.",
      },
    }), 400, "bad_request");
    await expect(prisma.appeal.count({ where: { userId: OUTSIDER } })).resolves.toBe(0);

    const valid = await api("POST", "appeals", {
      userId: CUSTOMER,
      ageGate: true,
      body: {
        targetType: "character",
        targetId,
        appealText: "Please review the decision affecting my Character.",
      },
    });
    expectOk(valid);
    expect(valid.data.appeal).toMatchObject({
      userId: CUSTOMER,
      targetType: "character",
      targetId,
      originalDecisionId: decision.id,
    });
  });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("GET /api/v1/support/history", () => {
  it("returns only the authenticated customer's records", async () => {
    const own = await api("POST", "support/requests", {
      userId: CUSTOMER,
      ageGate: true,
      body: {
        category: "account",
        subject: "My account request",
        description: "Please check my own account history entry.",
        diagnosticConsent: false,
      },
    });
    const other = await api("POST", "support/requests", {
      userId: OTHER,
      ageGate: true,
      body: {
        category: "billing",
        subject: "Another customer request",
        description: "This request must never appear to the first customer.",
        diagnosticConsent: true,
      },
    });
    expectOk(own, 201);
    expectOk(other, 201);

    const history = await api("GET", "support/history", { userId: CUSTOMER });
    expectOk(history);
    expect(history.data.supportRequests).toEqual([
      expect.objectContaining({
        id: own.data.request.id,
        ticketId: own.data.request.ticketId,
        subject: "My account request",
      }),
    ]);
    expect(JSON.stringify(history.data)).not.toContain(other.data.request.ticketId);
  });

  it("does not let an authenticated customer claim an anonymous report by ID", async () => {
    const anonymous = await api("POST", "reports", {
      body: {
        targetType: "character",
        targetId: `${P}anonymous-target`,
        category: "other_prohibited_content",
      },
    });
    expectOk(anonymous);

    expectError(
      await api("GET", `reports/${anonymous.data.report.id as string}`, {
        userId: CUSTOMER,
      }),
      404,
      "not_found",
    );
  });

  it("fails closed for non-customer and deleted viewer authority", async () => {
    const fixtureUser = `${P}fixture`;
    const deletedUser = `${P}deleted`;
    await createUser({ id: fixtureUser, dataClass: "fixture" });
    await createUser({ id: deletedUser, dataClass: "customer", status: "deleted" });
    await prisma.user.update({
      where: { id: deletedUser },
      data: { deletedAt: new Date("2026-08-11T00:00:00.000Z") },
    });

    expectError(
      await api("GET", "support/history", { userId: fixtureUser }),
      403,
      "forbidden",
    );
    expectError(
      await api("GET", "support/history", { userId: deletedUser }),
      401,
      "unauthorized",
    );
  });

  it("shows a terminal support resolution without internal notes or PII", async () => {
    const filed = await api("POST", "support/requests", {
      userId: CUSTOMER,
      ageGate: true,
      body: {
        category: "bug",
        subject: "Resolved support request",
        description: "The operator will resolve this support request.",
        diagnosticConsent: true,
      },
    });
    expectOk(filed, 201);
    const ticketId = filed.data.request.ticketId as string;
    // 运营侧的工单解决已迁到 Admin v2，直接打它的 Route Handler。
    const resolved = await supportRequestPatchRoute(
      new Request(`http://localhost/api/v2/admin/support/requests/${ticketId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": ADMIN,
          "x-idream-role": "admin",
          "idempotency-key": `${P}resolve-${ticketId}`,
        },
        body: JSON.stringify({
          status: "resolved",
          resolutionNotes: "private operator note with customer@example.test",
          reason: "The issue was fixed and verified",
          confirmation: ticketId,
        }),
      }),
      { params: Promise.resolve({ id: ticketId }) },
    );
    expect(resolved.status, JSON.stringify(await resolved.clone().json())).toBe(200);

    const history = await api("GET", "support/history", { userId: CUSTOMER });
    expectOk(history);
    expect(history.data.supportRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticketId,
        status: "resolved",
        resolution: { outcome: "resolved", resolvedAt: expect.any(String) },
      }),
    ]));
    expect(JSON.stringify(history.data)).not.toContain("private operator note");
    expect(JSON.stringify(history.data)).not.toContain("customer@example.test");
  });

  it("shows the public report decision and its linked appeal", async () => {
    const filed = await api("POST", "reports", {
      userId: CUSTOMER,
      body: {
        targetType: "character",
        targetId: `${P}report-target`,
        category: "other_prohibited_content",
        description: "Please review this target.",
      },
    });
    expectOk(filed);
    const reportId = filed.data.report.id as string;
    const decided = await adminV2("POST", `moderation/reports/${reportId}/decision`, {
      userId: ADMIN,
      role: "admin",
      body: {
        decision: "closed",
        policyCode: "no_action_required",
        notes: "private reviewer note",
        reason: "Review completed with no further action",
        confirmation: reportId,
      },
    });
    expectOk(decided);
    const appeal = await api("POST", "appeals", {
      userId: CUSTOMER,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: `${P}report-target`,
        originalDecisionId: decided.data.review.id,
        appealText: "Please take another look at this decision.",
      },
    });
    expectOk(appeal);

    const history = await api("GET", "support/history", { userId: CUSTOMER });
    expectOk(history);
    expect(history.data.reports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: reportId,
        status: "closed",
        decision: {
          outcome: "closed",
          decidedAt: expect.any(String),
        },
        appealIds: [appeal.data.appeal.id],
      }),
    ]));
    expect(history.data.appeals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: appeal.data.appeal.id,
        relatedReportId: reportId,
      }),
    ]));
    expect(JSON.stringify(history.data)).not.toContain("private reviewer note");
    expect(JSON.stringify(history.data)).not.toContain(ADMIN);
  });

  it("shows an upheld appeal outcome after refresh", async () => {
    const report = await prisma.contentReport.create({
      data: {
        id: `${P}standalone-report`,
        reporterId: CUSTOMER,
        targetType: "safety_issue",
        targetId: `${P}standalone-safety-issue`,
        category: "other_prohibited_content",
        status: "closed",
      },
    });
    const decision = await prisma.moderationReview.create({
      data: {
        id: `${P}standalone-decision`,
        reportId: report.id,
        reviewerId: ADMIN,
        decision: "closed",
      },
    });
    const appeal = await api("POST", "appeals", {
      userId: CUSTOMER,
      ageGate: true,
      body: {
        targetType: "moderation_decision",
        targetId: decision.id,
        appealText: "Please review this standalone decision again.",
      },
    });
    expectOk(appeal);
    const appealId = appeal.data.appeal.id as string;
    expectOk(await adminV2("POST", `moderation/appeals/${appealId}/decision`, {
      userId: ADMIN,
      role: "admin",
      body: {
        outcome: "upheld",
        notes: "private appeal note",
        reason: "The original decision was verified",
        confirmation: "UPHOLD",
      },
    }));

    const history = await api("GET", "support/history", { userId: CUSTOMER });
    expectOk(history);
    expect(history.data.appeals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: appealId,
        status: "upheld",
        outcome: { result: "upheld", resolvedAt: expect.any(String) },
      }),
    ]));
    expect(JSON.stringify(history.data)).not.toContain("private appeal note");
    expect(JSON.stringify(history.data)).not.toContain(ADMIN);
  });
});
