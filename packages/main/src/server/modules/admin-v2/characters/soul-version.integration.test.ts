import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { POST as createSoulVersionRoute } from "@/app/api/v2/admin/characters/[id]/soul/versions/route";
import { createCharacterSoulVersion } from "./soul-version";

describe("Character Soul version authority", () => {
  const suffix = randomUUID();
  const characterId = `soul-version-character-${suffix}`;
  const projectId = `soul-version-project-${suffix}`;
  const contentId = `soul-version-content-${suffix}`;
  const revisionId = `soul-version-revision-${suffix}`;
  const actorId = `soul-version-actor-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Legacy Mara",
        age: 28,
        gender: "female",
        description: "Mutable projection must not become Soul input.",
        source: "official",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "draft",
        audience: {},
        hypothesis: "",
        differentiation: "",
        successCriteria: [],
        activeKey: `soul-version:${suffix}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `legacy-soul-version-${suffix}`,
        personaSnapshot: {
          name: "Pinned Mara",
          age: 28,
          gender: "female",
          description: "Pinned legacy promise.",
          relationship: "late-night confidante",
          personality: "Measured and observant.",
          systemPrompt: "PINNED LEGACY PROMPT",
        },
        openingSnapshot: { firstMessage: "Pinned opening." },
        appearanceSnapshot: {
          style: "realistic",
          structured: { sourceImage: "/legacy-mara.webp" },
        },
        sourceType: "soul_version_test",
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "character.soul.version.create" },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: projectId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: projectId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("creates only a new immutable Soul/opening version and preserves appearance bytes", async () => {
    const created = await createCharacterSoulVersion({
      characterId,
      expectedProjectVersion: 1,
      expectedContentVersionId: contentId,
      actor: { id: actorId, role: "admin" },
      persona: {
        name: "Pinned Mara",
        age: 28,
        gender: "female",
        relationshipArchetype: "late-night confidante",
        characterPromise: "A precise place to put the day down.",
        personality: "Measured, observant, and gently challenging.",
        tone: "Warm and concise.",
        backstory: "A former night-shift radio host.",
        firstMessage: "What followed you home tonight?",
        exampleDialogue: ["Start with the part that still has heat."],
      },
      reason: "Create reviewed Soul version",
      requestId: `soul-version-request-${suffix}`,
    });

    expect(created).toMatchObject({
      characterId,
      projectId,
      projectVersion: 2,
      contentVersion: 2,
      revision: 2,
    });
    const versions = await prisma.characterContentVersion.findMany({
      where: { characterId },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[1]?.appearanceSnapshot).toEqual(versions[0]?.appearanceSnapshot);
    expect(versions[1]?.openingSnapshot).toEqual({
      firstMessage: "What followed you home tonight?",
    });
    const loaded = loadCharacterSoulSnapshot(versions[1]?.personaSnapshot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("created Soul must load through runtime authority");
    expect(loaded.snapshot.soul.identity.characterPromise).toBe(
      "A precise place to put the day down.",
    );
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({
      name: "Legacy Mara",
      description: "Mutable projection must not become Soul input.",
    });
    expect(await prisma.adminAuditLog.count({
      where: { targetId: projectId, action: "character.soul.version_created" },
    })).toBe(1);
  });

  it("replays the HTTP mutation by idempotency key without creating a third copy", async () => {
    const current = await prisma.characterContentVersion.findFirstOrThrow({
      where: { characterId },
      orderBy: { version: "desc" },
    });
    const body = {
      entityVersion: 2,
      expectedContentVersionId: current.id,
      persona: {
        name: "Pinned Mara",
        age: 28,
        gender: "female",
        relationshipArchetype: "late-night confidante",
        characterPromise: "A precise place to put the day down.",
        personality: "Measured, observant, and gently challenging.",
        tone: "Warm, concise, and newly candid.",
        backstory: "A former night-shift radio host.",
        firstMessage: "What followed you home tonight?",
        exampleDialogue: ["Start with the part that still has heat."],
      },
      reason: "Verify idempotent Soul version creation",
    };
    const key = `soul-version-http-${suffix}`;
    const request = () => new Request(
      `http://localhost/api/v2/admin/characters/${characterId}/soul/versions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "if-match": '"2"',
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
        },
        body: JSON.stringify(body),
      },
    );

    const created = await createSoulVersionRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      data: { projectVersion: 3, contentVersion: 3, replayed: false },
    });
    const replay = await createSoulVersionRoute(request(), {
      params: Promise.resolve({ id: characterId }),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      data: { projectVersion: 3, contentVersion: 3, replayed: true },
    });
    expect(await prisma.characterContentVersion.count({ where: { characterId } })).toBe(3);
  });
});
