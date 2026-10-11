import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const suffix = randomUUID().replaceAll("-", "");
const prefix = `zt-audit-atomicity-${suffix}-`;
const requester = `${prefix}requester`;
const reviewer = `${prefix}reviewer`;
const trigger = `audit_atomicity_${suffix}`;
const failAudit = `fail_audit_atomicity_${suffix}`;

beforeAll(async () => {
  await createUser({ id: requester, role: "admin", dataClass: "internal" });
  await createUser({ id: reviewer, role: "admin", dataClass: "internal" });
  // Unique identifiers and trigger arguments below contain only this test's
  // generated identifiers and fixed actions, never request-controlled SQL.
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION ${failAudit}() RETURNS trigger AS $$ BEGIN
      IF NEW."action" = TG_ARGV[0] AND NEW."targetId" = TG_ARGV[1] THEN
        RAISE EXCEPTION 'injected audit atomicity failure';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "admin_audit_logs"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${failAudit}()`);
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function withFailedAudit(action: string, targetId: string, run: () => Promise<void>) {
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${trigger} BEFORE INSERT ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION ${failAudit}('${action}', '${targetId}')
  `);
  try {
    await run();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "admin_audit_logs"`);
  }
}

describe("Admin domain mutations commit together with their Audit", () => {
  it.each(["approve", "reject"] as const)("rolls back %s and allows the pending approval to be retried", async (decision) => {
    const targetId = `${prefix}${decision}-target`;
    const created = await adminV2("POST", "approvals", {
      userId: requester, role: "admin",
      body: {
        permissionKey: "billing.ledger.adjust", action: "billing.ledger.adjust",
        targetType: "user", targetId, payload: { delta: 5000 },
        reason: "Verify approval decision audit atomicity",
        confirmation: `${targetId}:billing.ledger.adjust`,
      },
    });
    expectOk(created);
    const approvalId = created.data.request.id as string;
    const action = `admin.approval.${decision}`;
    const decide = () => adminV2("POST", `approvals/${approvalId}/${decision}`, {
      userId: reviewer, role: "admin",
      body: { reason: "Verify decision rollback and recovery", confirmation: approvalId },
    });

    await withFailedAudit(action, targetId, async () => {
      expectError(await decide(), 500, "internal");
      expect(await prisma.adminActionRequest.findUniqueOrThrow({ where: { id: approvalId } }))
        .toMatchObject({ status: "pending", approvedById: null, decidedAt: null });
      expect(await prisma.adminAuditLog.count({ where: { action, targetId } })).toBe(0);
      expect(await prisma.adminAuditLog.count({ where: { action: "admin.approval.request", targetId } })).toBe(1);
    });

    expectOk(await decide());
    expect(await prisma.adminActionRequest.findUniqueOrThrow({ where: { id: approvalId } }))
      .toMatchObject({ status: decision === "approve" ? "approved" : "rejected", approvedById: reviewer, decidedAt: expect.any(Date) });
    expect(await prisma.adminAuditLog.count({ where: { action, targetId } })).toBe(1);
  });

  it("rolls back deletion acceptance, access revocation and Outbox when erase Audit fails", async () => {
    const userId = `${prefix}erase-user`;
    await createUser({ id: userId });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const session = await prisma.session.create({ data: {
      userId, token: `${prefix}erase-session`, expiresAt: new Date(Date.now() + 60_000),
    } });
    const erase = () => adminV2("POST", `compliance/users/${userId}/erase`, {
      userId: reviewer, role: "admin",
      body: { reason: "Verify deletion request audit atomicity", confirmation: userId },
    });
    const outboxId = `user_deleted_${userId}`;
    const action = "compliance.erase";

    await withFailedAudit(action, userId, async () => {
      expectError(await erase(), 500, "internal");
      expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .toMatchObject({ status: before.status, deletedAt: before.deletedAt });
      expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
      expect(await prisma.accountDeletion.count({ where: { userId } })).toBe(0);
      expect(await prisma.mainOutboxEvent.findUnique({ where: { id: outboxId } })).toBeNull();
      expect(await prisma.adminAuditLog.count({ where: { action, targetId: userId } })).toBe(0);
    });

    const accepted = await erase();
    expectOk(accepted);
    expect(accepted.data).toMatchObject({ erased: true, idempotent: false, deletion: { status: "awaiting_chat" } });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
      .toMatchObject({ status: "deleted", deletedAt: expect.any(Date) });
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await prisma.accountDeletion.count({ where: { userId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } }))
      .toMatchObject({ aggregateId: userId, status: "pending" });
    expect(await prisma.adminAuditLog.count({ where: { action, targetId: userId } })).toBe(1);
  });

  it("does not authorize plaintext when consent grant Audit fails, and grants access after retry", async () => {
    const userId = `${prefix}consent-owner`;
    const ticketId = `${prefix}consent-ticket`;
    const jobId = `${prefix}consent-job`;
    await createUser({ id: userId });
    await prisma.generationJob.create({ data: {
      id: jobId, userId, mode: "image", prompt: "Audit rollback private prompt",
      negativePrompt: "Must remain outside the grant", controls: {}, presetIds: [], status: "failed",
    } });
    await prisma.supportRequest.create({ data: {
      ticketId, userId, category: "generation", subject: "Failed image",
      description: "Inspect only my prompt", diagnosticConsent: true,
    } });
    const grant = () => adminV2("POST", `support/requests/${ticketId}/consent-grants`, {
      userId: reviewer, role: "admin",
      body: { targetType: "generation_job", targetId: jobId, fields: ["prompt"], reason: "Verify consent audit atomicity" },
    });
    const view = () => adminV2("POST", "support/plaintext/view", {
      userId: reviewer, role: "admin",
      body: { targetType: "generation_job", targetId: jobId, ticketId, reason: "Inspect authorized diagnostic field", confirmation: jobId },
    });
    const action = "support.consent.grant";

    await withFailedAudit(action, jobId, async () => {
      expectError(await grant(), 500, "internal");
      expect(await prisma.supportConsentGrant.count({ where: { ticketId, targetId: jobId } })).toBe(0);
      expect(await prisma.adminAuditLog.count({ where: { action, targetId: jobId } })).toBe(0);
      expectError(await view(), 403, "forbidden");
    });

    expectOk(await grant());
    expect(await prisma.supportConsentGrant.count({ where: { ticketId, targetId: jobId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action, targetId: jobId } })).toBe(1);
    const viewed = await view();
    expectOk(viewed);
    expect(viewed.data.plaintext).toEqual({ prompt: "Audit rollback private prompt" });
  });
});
