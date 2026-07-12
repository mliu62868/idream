import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as reviewCaseBackfill } from "@/app/api/v2/admin/cases/backfill/route";
import { POST as customerCaseBackfill } from "@/app/api/v2/admin/cases/backfill/customer/route";
import { POST as incidentBackfill } from "@/app/api/v2/admin/incidents/backfill/route";
import { prisma } from "@/server/lib/db";

describe("Admin backfill mutation reliability", () => {
  const suffix = randomUUID();
  const actorId = `backfill-reliability-admin-${suffix}`;
  const runIds = new Set<string>();

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
    });
  });

  afterAll(async () => {
    const ids = [...runIds];
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
    await prisma.adminBackfillItem.deleteMany({ where: { runId: { in: ids } } });
    await prisma.adminBackfillRun.deleteMany({ where: { id: { in: ids } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("requires Idempotency-Key for every Admin backfill endpoint", async () => {
    const routes = [reviewCaseBackfill, customerCaseBackfill, incidentBackfill];
    for (const route of routes) {
      const response = await route(new Request("http://localhost/api/v2/admin/backfill", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({ dryRun: true, batchSize: 1 }),
      }));
      expect(response.status).toBe(400);
    }
    await expect(prisma.adminBackfillRun.count()).resolves.toBe(0);
  });

  it("maps an exact retry to one durable Run and rejects a changed request", async () => {
    const key = `review-case-${suffix}`;
    const request = (body: Record<string, unknown>) => new Request("http://localhost/api/v2/admin/cases/backfill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({ dryRun: true, batchSize: 1, ...body }),
    });
    const first = await reviewCaseBackfill(request({}));
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      domain: "review_case_v1",
      runId: expect.stringMatching(/^admin_backfill_[a-f0-9]{32}$/),
      optionsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    runIds.add(firstBody.data.runId);
    const replay = await reviewCaseBackfill(request({}));
    expect(await replay.json()).toEqual(firstBody);
    const collision = await reviewCaseBackfill(request({ batchSize: 2 }));
    expect(collision.status).toBe(409);
    await expect(prisma.adminBackfillRun.count({ where: { id: firstBody.data.runId } })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { scope_idempotencyKey: { scope: `test:${actorId}`, idempotencyKey: key } },
    })).resolves.toMatchObject({
      targetId: firstBody.data.runId,
      commandType: "admin.backfill.review_case_v1",
      result: firstBody.data,
    });
  });

  it("recovers the same options-bound Run when final receipt persistence fails", async () => {
    const key = `customer-case-${suffix}`;
    const request = (batchSize: number) => new Request("http://localhost/api/v2/admin/cases/backfill/customer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({ dryRun: true, batchSize }),
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_admin_backfill_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'admin.backfill.customer_case_v1' THEN
          RAISE EXCEPTION 'injected Admin backfill receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_admin_backfill_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_admin_backfill_receipt();
    `);
    try {
      await expect(customerCaseBackfill(request(1))).rejects.toThrow("injected Admin backfill receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_admin_backfill_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_admin_backfill_receipt();
      `);
    }
    const durableRun = await prisma.adminBackfillRun.findFirstOrThrow({
      where: { domain: "customer_case_v1" },
      orderBy: { startedAt: "desc" },
    });
    const stableRunId = durableRun.id;
    runIds.add(stableRunId);
    expect(durableRun.optionsHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(prisma.controlPlaneCommand.count({ where: { targetId: stableRunId } })).resolves.toBe(0);
    await expect(prisma.adminAuditLog.count({ where: { targetId: stableRunId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: stableRunId } })).resolves.toBe(0);

    const changed = await customerCaseBackfill(request(2));
    expect(changed.status).toBe(409);
    const recovered = await customerCaseBackfill(request(1));
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).data).toMatchObject({
      domain: "customer_case_v1",
      runId: stableRunId,
      optionsHash: durableRun.optionsHash,
    });
    await expect(prisma.adminAuditLog.count({ where: { targetId: stableRunId } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: stableRunId } })).resolves.toBe(1);
  });

  it("persists a receipt for Incident backfill requests", async () => {
    const key = `incident-${suffix}`;
    const response = await incidentBackfill(new Request("http://localhost/api/v2/admin/incidents/backfill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
      },
      body: JSON.stringify({ dryRun: true, batchSize: 1 }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ domain: "generation_incident_v1" });
    runIds.add(body.data.runId);
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { scope_idempotencyKey: { scope: `test:${actorId}`, idempotencyKey: key } },
    })).resolves.toMatchObject({ targetId: body.data.runId });
  });
});
