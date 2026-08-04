import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as claimTodayRoute } from "@/app/api/v2/admin/today/claim/route";
import { PUT as updateTodayPreferenceRoute } from "@/app/api/v2/admin/today/preferences/route";
import { prisma } from "@/server/lib/db";
import { adminCaseActiveKey } from "@/server/modules/admin-v2/cases/service";

describe("Today mutation transport", () => {
  const suffix = randomUUID();
  const actorId = `today-mutation-admin-${suffix}`;
  const caseId = `today-mutation-case-${suffix}`;
  const rollbackCaseId = `today-mutation-rollback-${suffix}`;

  function claimRequest(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    return new Request("http://localhost/api/v2/admin/today/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        ...headers,
      },
      body: JSON.stringify({ sourceType: "admin_case", sourceId: caseId, entityVersion: 1, ...body }),
    });
  }

  function preferenceRequest(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    return new Request("http://localhost/api/v2/admin/today/preferences", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        ...headers,
      },
      body: JSON.stringify({ sourceType: "admin_case", sourceId: caseId, pinned: true, ...body }),
    });
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
    });
    await prisma.adminCase.create({
      data: {
        id: caseId,
        type: "support_request",
        targetType: "user",
        targetId: `customer-${suffix}`,
        caseKey: `today-mutation-${suffix}`,
        activeKey: adminCaseActiveKey(
          "support_request",
          "user",
          `customer-${suffix}`,
          `today-mutation-${suffix}`,
        ),
        status: "new",
        priority: "normal",
        verificationState: "pending",
      },
    });
    await prisma.adminCase.create({
      data: {
        id: rollbackCaseId,
        type: "support_request",
        targetType: "user",
        targetId: `rollback-customer-${suffix}`,
        caseKey: `today-mutation-rollback-${suffix}`,
        activeKey: adminCaseActiveKey(
          "support_request",
          "user",
          `rollback-customer-${suffix}`,
          `today-mutation-rollback-${suffix}`,
        ),
        status: "new",
        priority: "normal",
        verificationState: "pending",
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [caseId, rollbackCaseId] } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [caseId, rollbackCaseId] } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "today.work.claim" } });
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId } });
    await prisma.adminCase.deleteMany({ where: { id: { in: [caseId, rollbackCaseId] } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("rejects a claim without Idempotency-Key before applying the owner mutation", async () => {
    const response = await claimTodayRoute(claimRequest({ "x-request-id": `missing-key-${suffix}` }));

    expect(response.status).toBe(400);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: caseId } })).resolves.toMatchObject({
      ownerId: null,
      version: 1,
    });
  });

  it("binds a claim key to the canonical body and replays the exact persisted result", async () => {
    const key = `claim-key-${suffix}`;
    const firstRequestId = `claim-request-first-${suffix}`;
    const replayRequestId = `claim-request-replay-${suffix}`;
    const first = await claimTodayRoute(claimRequest({
      "idempotency-key": key,
      "x-request-id": firstRequestId,
    }));
    const firstPayload = await first.json();

    const replay = await claimTodayRoute(claimRequest({
      "idempotency-key": key,
      "x-request-id": replayRequestId,
    }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstPayload);

    const collision = await claimTodayRoute(claimRequest({
      "idempotency-key": key,
      "x-request-id": `claim-request-collision-${suffix}`,
    }, { entityVersion: 2 }));
    expect(collision.status).toBe(409);

    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { scope_idempotencyKey: { scope: `test:${actorId}`, idempotencyKey: key } },
    })).resolves.toMatchObject({
      commandType: "today.work.claim",
      requestId: firstRequestId,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "succeeded",
      result: {
        sourceType: "admin_case",
        sourceId: caseId,
        ownerId: actorId,
        entityVersion: 2,
      },
    });
    await expect(prisma.adminAuditLog.count({ where: { action: "case.assigned", targetId: caseId } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { eventType: "admin.case.assigned.v2", aggregateId: caseId } })).resolves.toBe(1);
  });

  it("requires If-Match before replacing a Today preference", async () => {
    const response = await updateTodayPreferenceRoute(preferenceRequest({
      "x-request-id": `preference-no-if-match-${suffix}`,
    }));

    expect(response.status).toBe(400);
    await expect(prisma.operationalWorkPreference.count({ where: { actorId, sourceId: caseId } })).resolves.toBe(0);
  });

  it("uses preference version zero for create and rejects stale replacement without an Audit", async () => {
    const created = await updateTodayPreferenceRoute(preferenceRequest({
      "if-match": '"0"',
      "x-request-id": `preference-create-${suffix}`,
    }));
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ data: { pinned: true, version: 1 } });

    const updated = await updateTodayPreferenceRoute(preferenceRequest({
      "if-match": '"1"',
      "x-request-id": `preference-update-${suffix}`,
    }, { pinned: false }));
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ data: { pinned: false, version: 2 } });

    const stale = await updateTodayPreferenceRoute(preferenceRequest({
      "if-match": '"1"',
      "x-request-id": `preference-stale-${suffix}`,
    }, { watching: true }));
    expect(stale.status).toBe(409);
    await expect(prisma.operationalWorkPreference.findUniqueOrThrow({
      where: { actorId_sourceType_sourceId: { actorId, sourceType: "admin_case", sourceId: caseId } },
    })).resolves.toMatchObject({ pinned: false, watching: false, version: 2 });
    await expect(prisma.adminAuditLog.count({
      where: { actorId, action: "today.preference.updated", targetId: caseId },
    })).resolves.toBe(2);
  });

  it("rolls owner, Audit and Outbox back when the claim receipt cannot commit", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_today_claim_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'today.work.claim' AND NEW."targetId" = '${rollbackCaseId}' THEN
          RAISE EXCEPTION 'injected today receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_today_claim_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_today_claim_receipt();
    `);
    try {
      const request = claimRequest({
        "idempotency-key": `rollback-key-${suffix}`,
        "x-request-id": `rollback-request-${suffix}`,
      }, { sourceId: rollbackCaseId });
      await expect(claimTodayRoute(request)).rejects.toThrow("injected today receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_today_claim_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_today_claim_receipt();
      `);
    }

    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: rollbackCaseId } })).resolves.toMatchObject({ ownerId: null, version: 1 });
    await expect(prisma.adminAuditLog.count({ where: { targetId: rollbackCaseId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: rollbackCaseId } })).resolves.toBe(0);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: rollbackCaseId } })).resolves.toBe(0);

    const retry = await claimTodayRoute(claimRequest({
      "idempotency-key": `rollback-key-${suffix}`,
      "x-request-id": `rollback-retry-${suffix}`,
    }, { sourceId: rollbackCaseId }));
    expect(retry.status).toBe(200);
    await expect(prisma.adminCase.findUniqueOrThrow({ where: { id: rollbackCaseId } })).resolves.toMatchObject({ ownerId: actorId, version: 2 });
  });
});
