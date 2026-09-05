import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { POST as createCharacterProjectRoute } from "@/app/api/v2/admin/characters/route";
import { GET as resumeCharacterProjectRoute } from "@/app/api/v2/admin/characters/[id]/project/route";
import { POST as reconcileMutationReceipt } from "@/app/api/v2/admin/mutation-receipts/reconcile/route";

describe("Character Project creation authority", () => {
  const suffix = randomUUID();
  const actorId = `character-create-admin-${suffix}`;
  const deniedActorId = `character-create-denied-${suffix}`;
  const idempotencyKey = `character-create-${suffix}`;
  const requestId = `character-create-request-${suffix}`;
  const createdIds: string[] = [];

  const body = {
    persona: {
      name: "Mara",
      age: 28,
      gender: "female",
      characterPromise: "A precise, warm place to put the day down",
      detailsMarkdown:
        "Observant, measured, gently challenging. Warm, concise, grounded. A night-shift radio host who learned how to listen between words.",
      firstMessage: "You made it. What do you need to put down tonight?",
    },
    visualDirection: {
      identityAnchor: "Composed late-night radio host",
      stableTraits: ["dark wavy hair", "warm brown eyes"],
      style: "realistic",
      referenceDirection:
        "Low-key tungsten portraiture with an intimate editorial crop",
    },
    reason: {
      code: "new_supply",
      summary: "Create an evening decompression companion",
    },
    confirmation: "CREATE CHARACTER",
  };

  function request(
    actor: string,
    role: string,
    payload: unknown,
    key = idempotencyKey,
    id = requestId,
  ) {
    return new Request("http://localhost/api/v2/admin/characters", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-request-id": id,
        "x-idream-user-id": actor,
        "x-idream-role": role,
      },
      body: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `${actorId}@example.test`,
          role: "admin",
          status: "active",
        },
        {
          id: deniedActorId,
          email: `${deniedActorId}@example.test`,
          role: "user",
          status: "active",
        },
      ],
    });
  });

  afterAll(async () => {
    const commands = await prisma.controlPlaneCommand.findMany({
      where: { actorId, commandType: "character.project.create" },
      select: { targetId: true },
    });
    const projectIds = commands.map((command) => command.targetId);
    const projects = await prisma.characterProject.findMany({
      where: { id: { in: projectIds } },
    });
    const characterIds = projects.map((project) => project.characterId);
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: projectIds } },
    });
    await prisma.adminCollaborationActivity.deleteMany({
      where: { targetId: { in: projectIds } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "character.project.create" },
    });
    await prisma.characterRevision.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.characterContentVersion.deleteMany({
      where: { characterId: { in: characterIds } },
    });
    await prisma.characterServing.deleteMany({
      where: { characterId: { in: characterIds } },
    });
    await prisma.characterProject.deleteMany({
      where: { id: { in: projectIds } },
    });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, deniedActorId] } },
    });
    await prisma.$disconnect();
  });

  it("creates Character, content v1, Project, Revision and evidence in one authority transaction", async () => {
    const response = await createCharacterProjectRoute(
      request(actorId, "admin", body),
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      data: Record<string, unknown>;
    };
    expect(payload.data).toMatchObject({
      projectVersion: 1,
      contentVersion: 1,
      replayed: false,
    });
    const characterId = String(payload.data.characterId);
    expect(payload.data.deepLink).toBe(`/admin/characters/${characterId}?tab=assets`);
    const projectId = String(payload.data.projectId);
    createdIds.push(characterId, projectId);

    expect(
      await prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).toMatchObject({
      age: 28,
      source: "official",
      status: "draft",
      visibility: "private",
    });
    expect(
      await prisma.characterContentVersion.findMany({ where: { characterId } }),
    ).toHaveLength(1);
    expect(
      await prisma.characterRevision.findMany({ where: { projectId } }),
    ).toHaveLength(1);
    expect(
      await prisma.characterServing.findUnique({ where: { characterId } }),
    ).toMatchObject({ state: "inactive", currentReleaseId: null, version: 1 });
    expect(
      await prisma.adminAuditLog.count({
        where: { targetId: projectId, action: "character.project.created" },
      }),
    ).toBe(1);
    expect(
      await prisma.adminCollaborationActivity.count({
        where: { targetId: projectId, kind: "status_change" },
      }),
    ).toBe(0);
    expect(
      await prisma.mainOutboxEvent.count({
        where: {
          aggregateId: projectId,
          eventType: "character.project.created.v2",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.mainOutboxEvent.findFirstOrThrow({
        where: { aggregateId: projectId },
      }),
    ).toMatchObject({ status: "pending" });
    expect(
      await prisma.controlPlaneCommand.findFirstOrThrow({
        where: {
          actorId,
          idempotencyKey,
          commandType: "character.project.create",
        },
      }),
    ).toMatchObject({
      status: "succeeded",
      targetId: projectId,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const resumed = await resumeCharacterProjectRoute(
      new Request(
        `http://localhost/api/v2/admin/characters/${characterId}/project`,
        {
          headers: { "x-idream-user-id": actorId, "x-idream-role": "admin" },
        },
      ),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      data: {
        authority: { characterId, projectId, projectVersion: 1 },
        draft: {
          persona: { name: "Mara", age: 28 },
          visualDirection: { style: "realistic" },
        },
      },
    });
  });

  it("replays the same request and rejects reuse with a different canonical request hash", async () => {
    const replay = await createCharacterProjectRoute(
      request(actorId, "admin", body, idempotencyKey, `${requestId}-replay`),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        characterId: createdIds[0],
        projectId: createdIds[1],
        replayed: true,
      },
    });

    const conflict = await createCharacterProjectRoute(
      request(
        actorId,
        "admin",
        {
          ...body,
          persona: { ...body.persona, characterPromise: "A different promise" },
        },
        idempotencyKey,
        `${requestId}-conflict`,
      ),
    );
    expect(conflict.status).toBe(409);
    expect(
      await prisma.characterProject.count({ where: { id: createdIds[1] } }),
    ).toBe(1);
  });

  it("denies actors without the effective Character Project write permission", async () => {
    const response = await createCharacterProjectRoute(
      request(
        deniedActorId,
        "user",
        body,
        `denied-${suffix}`,
        `denied-request-${suffix}`,
      ),
    );
    expect(response.status).toBe(403);
    const resume = await resumeCharacterProjectRoute(
      new Request(
        `http://localhost/api/v2/admin/characters/${createdIds[0]}/project`,
        {
          headers: {
            "x-idream-user-id": deniedActorId,
            "x-idream-role": "user",
          },
        },
      ),
      { params: Promise.resolve({ id: createdIds[0] }) },
    );
    expect(resume.status).toBe(403);
  });

  it("requires an Idempotency-Key before accepting a create request", async () => {
    const response = await createCharacterProjectRoute(
      new Request("http://localhost/api/v2/admin/characters", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects the former instructional defaults before creating any authority", async () => {
    const sentinelKey = `instructional-defaults-${suffix}`;
    const response = await createCharacterProjectRoute(
      request(
        actorId,
        "admin",
        {
          ...body,
          persona: {
            ...body.persona,
            name: "Untitled companion",
          },
          visualDirection: {
            ...body.visualDirection,
            identityAnchor: "A recognizable adult companion identity",
          },
        },
        sentinelKey,
        `instructional-defaults-request-${suffix}`,
      ),
    );
    expect(response.status).toBe(400);
    expect(
      await prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey: sentinelKey },
      }),
    ).toBe(0);
    expect(
      await prisma.character.count({
        where: { name: "Untitled companion" },
      }),
    ).toBe(0);
  });

  it("blocks a late Character Project create after receipt reconciliation sealed the key", async () => {
    const recoveryKey = `character-create-recovery-${suffix}`;
    const lateName = `Late character ${suffix}`;
    const recovery = await reconcileMutationReceipt(
      new Request("http://localhost/api/v2/admin/mutation-receipts/reconcile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": recoveryKey,
          "x-request-id": `character-recovery-${suffix}`,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify({
          commandType: "character.project.create",
        }),
      }),
    );
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({
      data: {
        state: "cancelled",
        commandType: "character.project.create",
      },
    });

    const lateCreate = await createCharacterProjectRoute(
      request(
        actorId,
        "admin",
        {
          ...body,
          persona: { ...body.persona, name: lateName },
        },
        recoveryKey,
        `character-recovery-late-${suffix}`,
      ),
    );
    expect(lateCreate.status).toBe(409);
    expect(
      await prisma.character.count({
        where: { name: lateName },
      }),
    ).toBe(0);
    expect(
      await prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey: recoveryKey },
      }),
    ).toBe(1);
  });

  it("rolls back every domain root when transaction evidence cannot be committed", async () => {
    const atomicKey = `atomic-${suffix}`;
    const atomicName = `Atomic rollback ${suffix}`;
    const contentCount = await prisma.characterContentVersion.count({ where: { createdById: actorId } });
    const revisionCount = await prisma.characterRevision.count({ where: { createdById: actorId } });
    // Fail the retained durable evidence seam, not the retired collaboration feed.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_character_create_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW."eventType" = 'character.project.created.v2' AND NEW.payload->>'actorId' = '${actorId}' THEN
          RAISE EXCEPTION 'injected Character creation outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_character_create_outbox_trigger
      BEFORE INSERT ON "main_outbox_events"
      FOR EACH ROW EXECUTE FUNCTION fail_character_create_outbox();
    `);
    try {
      const response = await createCharacterProjectRoute(
        request(
          actorId,
          "admin",
          {
            ...body,
            persona: { ...body.persona, name: atomicName },
          },
          atomicKey,
          `atomic-request-${suffix}`,
        ),
      );
      expect(response.status).toBe(500);
      expect(
        await prisma.character.count({ where: { name: atomicName } }),
      ).toBe(0);
      expect(
        await prisma.controlPlaneCommand.count({
          where: { actorId, idempotencyKey: atomicKey },
        }),
      ).toBe(0);
      expect(await prisma.characterContentVersion.count({ where: { createdById: actorId } })).toBe(contentCount);
      expect(await prisma.characterRevision.count({ where: { createdById: actorId } })).toBe(revisionCount);
      expect(await prisma.adminAuditLog.count({ where: { requestId: `atomic-request-${suffix}` } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_character_create_outbox_trigger ON "main_outbox_events";
        DROP FUNCTION IF EXISTS fail_character_create_outbox();
      `);
    }
  });
});
