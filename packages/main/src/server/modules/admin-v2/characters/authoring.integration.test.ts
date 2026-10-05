import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { PATCH as saveProject } from "@/app/api/v2/admin/characters/[id]/project/route";
import { POST as saveSoul } from "@/app/api/v2/admin/characters/[id]/soul/versions/route";
import { characterDraftSnapshots } from "./draft-content";
import { toInputJson } from "../shared/prisma-json";

describe("Character authoring content invariants", () => {
  const suffix = randomUUID();
  const actorId = `authoring-actor-${suffix}`;
  const characterId = `authoring-character-${suffix}`;
  const direction = {
    identityAnchor: "Adult radio host", stableTraits: ["brown eyes"],
    style: "realistic" as const, referenceDirection: "Soft studio light",
  };
  const legacyAppearance = {
    ...direction, sourceImage: "/legacy-portrait.webp",
    structured: { hairTraits: { color: "brown" }, sourceImage: "/structured-portrait.webp" },
  };
  const persona = {
    name: "Mara", age: 28, gender: "female" as const, characterPromise: "A warm place to put the day down",
    detailsMarkdown: "Observant and measured", firstMessage: "What followed you home tonight?",
  };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@example.test`, role: "admin" } });
    await prisma.character.create({ data: { id: characterId, name: persona.name, age: persona.age,
      gender: persona.gender, description: persona.characterPromise, source: "official", visibility: "private", status: "draft",
      appearance: {}, advancedDetails: {} } });
    const project = await prisma.characterProject.create({ data: { characterId } });
    const snapshots = characterDraftSnapshots({ persona, visualDirection: direction }, legacyAppearance);
    const content = await prisma.characterContentVersion.create({ data: { characterId, version: 1,
      contentHash: snapshots.contentHash, personaSnapshot: toInputJson(snapshots.personaSnapshot),
      openingSnapshot: toInputJson(snapshots.openingSnapshot), appearanceSnapshot: toInputJson(snapshots.appearanceSnapshot), sourceType: "test" } });
    await prisma.characterRevision.create({ data: { projectId: project.id, revision: 1,
      characterContentVersionId: content.id, projectSnapshot: {}, createdById: actorId } });
  });

  afterAll(async () => {
    const project = await prisma.characterProject.findFirst({ where: { characterId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    if (project) await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: project.id } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.moderationEvent.deleteMany({ where: { targetId: characterId } });
    if (project) await prisma.characterRevision.deleteMany({ where: { projectId: project.id } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    if (project) await prisma.characterProject.delete({ where: { id: project.id } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  async function authority() {
    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId } });
    const content = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    return { project, content };
  }

  function request(method: string, path: string, version: number, body: unknown) {
    return new Request(`http://localhost/api/v2/admin/characters/${characterId}/${path}`, {
      method, headers: { "content-type": "application/json", "if-match": `"${version}"`,
        "idempotency-key": randomUUID(), "x-idream-user-id": actorId, "x-idream-role": "admin" },
      body: JSON.stringify(body),
    });
  }

  it("keeps legacy appearance facts when Project PATCH edits the authored direction", async () => {
    const { project, content } = await authority();
    const changedDirection = { ...direction, referenceDirection: "Warm window light" };
    const response = await saveProject(request("PATCH", "project", project.version, {
      entityVersion: project.version, content: { persona: { ...persona, name: "Updated Mara" }, visualDirection: changedDirection },
      reason: "Correct the portrait lighting direction",
    }), { params: Promise.resolve({ id: characterId }) });
    expect(response.status).toBe(200);
    const next = await authority();
    expect(next.content.appearanceSnapshot).toEqual({ ...legacyAppearance, ...changedDirection });
    expect(next.content.version).toBe(content.version + 1);
    expect(await prisma.characterContentVersion.findUniqueOrThrow({ where: { id: content.id } })).toEqual(content);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ name: "Mara", visibility: "private" });
  });

  it.each([
    { term: "underage", field: "details" },
    { term: "minor", field: "opening" },
    { term: "csam", field: "appearance" },
  ])("blocks $term in $field through both content save entrances without changing authority", async ({ term, field }) => {
    const { project, content } = await authority();
    const loaded = loadCharacterSoulSnapshot(content.personaSnapshot);
    if (!loaded.ok) throw new Error("Fixture Soul must load");
    const blockedPersona = { ...loaded.snapshot.soul, firstMessage: persona.firstMessage,
      ...(field === "details" ? { detailsMarkdown: term } : {}),
      ...(field === "opening" ? { firstMessage: term } : {}),
    };
    const blockedDirection = { ...direction, ...(field === "appearance" ? { referenceDirection: term } : {}) };
    const responses = [
      await saveProject(request("PATCH", "project", project.version, {
        entityVersion: project.version, content: { persona: blockedPersona, visualDirection: blockedDirection }, reason: "Safety regression probe",
      }), { params: Promise.resolve({ id: characterId }) }),
      await saveSoul(request("POST", "soul/versions", project.version, {
        entityVersion: project.version, expectedContentVersionId: content.id, persona: blockedPersona, visualDirection: blockedDirection,
      }), { params: Promise.resolve({ id: characterId }) }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { message: "Character failed safety checks", details: { status: "blocked" } } });
    }
    expect(await authority()).toEqual({ project, content });
    expect(await prisma.characterContentVersion.count({ where: { characterId } })).toBe(content.version);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId } })).toBe(0);
    expect(await prisma.moderationEvent.count({ where: { targetId: characterId, status: "blocked" } })).toBeGreaterThanOrEqual(2);
  });
  it("rejects a Project content PATCH while a candidate Release pins the draft", async () => {
    const { project, content } = await authority();
    const revision = await prisma.characterRevision.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { revision: "desc" } });
    const candidate = await prisma.characterRelease.create({ data: {
      projectId: project.id, revisionId: revision.id, characterContentVersionId: content.id,
      generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: `authoring-candidate-${suffix}`,
    } });
    try {
      const response = await saveProject(request("PATCH", "project", project.version, {
        entityVersion: project.version, content: { persona: { ...persona, name: "Behind the candidate" }, visualDirection: direction },
        reason: "Edit beside a pending candidate",
      }), { params: Promise.resolve({ id: characterId }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { details: {
        releaseId: candidate.id, deepLink: `/admin/characters/${characterId}?tab=release`,
      } } });
      expect(await authority()).toEqual({ project, content });
    } finally {
      await prisma.characterRelease.delete({ where: { id: candidate.id } });
    }
  });
});
