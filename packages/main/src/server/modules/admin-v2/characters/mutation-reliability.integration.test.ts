import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as performanceBackfillRoute } from "@/app/api/v2/admin/characters/performance/backfill/route";
import { prisma } from "@/server/lib/db";

describe("Character mutation reliability", () => {
  const suffix = randomUUID();
  const actorId = `character-reliability-admin-${suffix}`;
  const source = `character-reliability-${suffix}`;
  const rollbackSource = `character-reliability-rollback-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active" } });
  });

  afterAll(async () => {
    const targetId = `funnel:${source}`;
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: targetId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId } });
    await prisma.metricBackfillRun.deleteMany({ where: { source: { in: [source, rollbackSource] } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId, commandType: "character.performance.backfill" } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("requires Idempotency-Key before starting a Character performance backfill", async () => {
    const response = await performanceBackfillRoute(new Request("http://localhost/api/v2/admin/characters/performance/backfill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": `missing-key-${suffix}`,
      },
      body: JSON.stringify({ source, kind: "funnel", dryRun: true, batchSize: 10, cursor: null }),
    }));
    expect(response.status, await response.clone().text()).toBe(400);
    await expect(prisma.metricBackfillRun.count({ where: { source } })).resolves.toBe(0);
  });

  it("replays the exact backfill result and rejects a changed payload", async () => {
    const key = `performance-${suffix}`;
    const request = (body: Record<string, unknown>, requestId: string) => new Request("http://localhost/api/v2/admin/characters/performance/backfill", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": requestId,
      },
      body: JSON.stringify({ source, kind: "funnel", dryRun: true, batchSize: 10, cursor: null, ...body }),
    });
    const first = await performanceBackfillRoute(request({}, `first-${suffix}`));
    const firstPayload = await first.json();
    const replay = await performanceBackfillRoute(request({}, `replay-${suffix}`));
    expect(await replay.json()).toEqual(firstPayload);
    const collision = await performanceBackfillRoute(request({ batchSize: 11 }, `collision-${suffix}`));
    expect(collision.status).toBe(409);
    await expect(prisma.metricBackfillRun.count({ where: { source } })).resolves.toBe(1);
    await expect(prisma.controlPlaneCommand.findUniqueOrThrow({
      where: { scope_idempotencyKey: { scope: `test:${actorId}`, idempotencyKey: key } },
    })).resolves.toMatchObject({ requestId: `first-${suffix}`, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("rolls back the backfill, Audit and Outbox when receipt persistence fails", async () => {
    const targetId = `funnel:${rollbackSource}`;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_character_mutation_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'character.performance.backfill' AND NEW."targetId" = '${targetId}' THEN
          RAISE EXCEPTION 'injected character receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_character_mutation_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_character_mutation_receipt();
    `);
    try {
      const request = new Request("http://localhost/api/v2/admin/characters/performance/backfill", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `rollback-${suffix}`,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({ source: rollbackSource, kind: "funnel", dryRun: true, batchSize: 10, cursor: null }),
      });
      await expect(performanceBackfillRoute(request)).rejects.toThrow("injected character receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_character_mutation_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_character_mutation_receipt();
      `);
    }
    await expect(prisma.metricBackfillRun.count({ where: { source: rollbackSource } })).resolves.toBe(0);
    await expect(prisma.adminAuditLog.count({ where: { targetId } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: targetId } })).resolves.toBe(0);
  });
});
