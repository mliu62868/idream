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
  const resumableSupportIds = [1, 2, 3].map((index) => `zzzzzzzz-http-backfill-${suffix}-${index}`);

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" },
    });
    await prisma.supportRequest.createMany({
      data: resumableSupportIds.map((id) => ({
        id,
        ticketId: `ticket-${id}`,
        userId: actorId,
        category: "technical",
        subject: "HTTP continuation contract",
        description: "Verifies a paused HTTP backfill can advance with a new batch receipt.",
        status: "open",
      })),
    });
  });

  afterAll(async () => {
    const ids = [...runIds];
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: ids } } });
    await prisma.adminBackfillItem.deleteMany({ where: { runId: { in: ids } } });
    await prisma.adminBackfillRun.deleteMany({ where: { id: { in: ids } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.supportRequest.deleteMany({ where: { id: { in: resumableSupportIds } } });
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

  it("continues a paused Run under a new batch receipt without changing Run identity", async () => {
    const request = (key: string, body: Record<string, unknown>) => new Request(
      "http://localhost/api/v2/admin/cases/backfill/customer",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify(body),
      },
    );
    const firstKey = `customer-resume-first-${suffix}`;
    const firstRequest = {
      dryRun: true,
      batchSize: 1,
      cursor: `zzzzzzzz-http-backfill-${suffix}-0`,
    };
    const first = await customerCaseBackfill(request(firstKey, firstRequest));
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      domain: "customer_case_v1",
      status: "paused",
      scanned: 1,
      dryRun: true,
    });
    const runId = firstBody.data.runId as string;
    const optionsHash = firstBody.data.optionsHash as string;
    runIds.add(runId);

    const firstReplay = await customerCaseBackfill(request(firstKey, firstRequest));
    expect(await firstReplay.json()).toEqual(firstBody);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION slow_admin_backfill_claim() RETURNS trigger AS $$
      BEGIN
        IF OLD."id" = '${runId}' AND OLD."status" = 'paused' AND NEW."status" = 'running' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER slow_admin_backfill_claim_trigger
      BEFORE UPDATE ON "admin_backfill_runs"
      FOR EACH ROW EXECUTE FUNCTION slow_admin_backfill_claim();
    `);
    const continuationKeys = [
      `customer-resume-next-a-${suffix}`,
      `customer-resume-next-b-${suffix}`,
    ];
    let concurrent: Response[];
    try {
      concurrent = await Promise.all(continuationKeys.map((key) => (
        customerCaseBackfill(request(key, { runId }))
      )));
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS slow_admin_backfill_claim_trigger ON "admin_backfill_runs";
        DROP FUNCTION IF EXISTS slow_admin_backfill_claim();
      `);
    }
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = concurrent.findIndex((response) => response.status === 200);
    const continuationKey = continuationKeys[winnerIndex]!;
    const continuationBody = await concurrent[winnerIndex]!.json();
    expect(continuationBody.data).toMatchObject({
      domain: "customer_case_v1",
      runId,
      optionsHash,
      status: "paused",
      scanned: 2,
      dryRun: true,
    });
    const continuationReplay = await customerCaseBackfill(request(continuationKey, { runId }));
    expect(await continuationReplay.json()).toEqual(continuationBody);

    const finalKey = `customer-resume-final-${suffix}`;
    const finalBatch = await customerCaseBackfill(request(finalKey, { runId }));
    expect(finalBatch.status).toBe(200);
    expect((await finalBatch.json()).data).toMatchObject({
      runId,
      optionsHash,
      status: "completed",
      scanned: 3,
    });

    await expect(prisma.adminBackfillRun.count({ where: { id: runId } })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.count({
      where: { actorId, targetId: runId, commandType: "admin.backfill.customer_case_v1" },
    })).resolves.toBe(3);
    await expect(prisma.adminAuditLog.count({
      where: { actorId, targetId: runId, action: "admin.backfill.executed" },
    })).resolves.toBe(3);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: runId, eventType: "admin.backfill.executed.v2" },
    })).resolves.toBe(3);

    const changedRun = await customerCaseBackfill(request(continuationKey, { runId: `${runId}-changed` }));
    expect(changedRun.status).toBe(409);
    const optionsOnContinuation = await customerCaseBackfill(request(
      `customer-resume-options-${suffix}`,
      { runId, dryRun: false },
    ));
    expect(optionsOnContinuation.status).toBe(400);
    const wrongDomain = await reviewCaseBackfill(request(`customer-resume-domain-${suffix}`, { runId }));
    expect(wrongDomain.status).toBe(409);
  });

  it("replays a continuation batch when its final receipt transaction fails", async () => {
    const request = (key: string, body: Record<string, unknown>) => new Request(
      "http://localhost/api/v2/admin/cases/backfill/customer",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      },
    );
    const first = await customerCaseBackfill(request(`continuation-fault-start-${suffix}`, {
      dryRun: true,
      batchSize: 1,
      cursor: `zzzzzzzz-http-backfill-${suffix}-0`,
    }));
    const firstBody = await first.json();
    const runId = firstBody.data.runId as string;
    runIds.add(runId);
    expect(firstBody.data).toMatchObject({ status: "paused", scanned: 1 });

    const continuationKey = `continuation-fault-next-${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_continuation_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."idempotencyKey" = '${continuationKey}' THEN
          RAISE EXCEPTION 'injected continuation receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_continuation_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_continuation_receipt();
    `);
    try {
      await expect(customerCaseBackfill(request(continuationKey, { runId })))
        .rejects.toThrow("injected continuation receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_continuation_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_continuation_receipt();
      `);
    }
    const afterFailure = await prisma.adminBackfillRun.findUniqueOrThrow({ where: { id: runId } });
    expect(afterFailure).toMatchObject({ status: "paused" });
    expect(afterFailure.summary).toMatchObject({ scanned: 2 });

    const replay = await customerCaseBackfill(request(continuationKey, { runId }));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({
      runId,
      status: "paused",
      scanned: 2,
      nextCursor: afterFailure.cursor,
    });
    await expect(prisma.controlPlaneCommand.count({
      where: { actorId, targetId: runId, commandType: "admin.backfill.customer_case_v1" },
    })).resolves.toBe(2);
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
    expect(durableRun.status).toBe("paused");
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
      status: durableRun.status,
      nextCursor: durableRun.cursor,
      scanned: (durableRun.summary as { scanned: number }).scanned,
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
