import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as recordHandoffRoute } from "@/app/api/v2/admin/characters/[id]/handoffs/route";
import { prisma } from "@/server/lib/db";
import {
  characterHandoffDrift,
  loadCharacterWorkspaceHandoff,
} from "@/server/modules/admin-v2/characters/handoff";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";

const prefix = "character-handoff-";
const adminId = `${prefix}admin`;
const ownerId = `${prefix}owner`;
const creatorId = `${prefix}creator`;
const characterId = `${prefix}character`;
const projectId = `${prefix}project`;
const profileId = `${prefix}profile`;

function handoffRequest(input: {
  readonly key: string;
  readonly role?: string;
  readonly userId?: string;
  readonly body?: Record<string, unknown>;
}) {
  return new Request(`http://localhost/api/v2/admin/characters/${characterId}/handoffs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": input.key,
      "x-idream-user-id": input.userId ?? adminId,
      "x-idream-role": input.role ?? "admin",
    },
    body: JSON.stringify(input.body ?? {}),
  });
}

const post = (request: Request) =>
  recordHandoffRoute(request, { params: Promise.resolve({ id: characterId }) });

describe("creation handoff", () => {
  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createUser({ id: ownerId, role: "user", dataClass: "internal" });
    await createCharacter({ id: characterId, creatorId: ownerId, source: "official" });
    await prisma.characterProject.create({ data: { id: projectId, characterId } });
  });

  afterAll(async () => {
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: creatorId } });
    await prisma.characterHandoff.deleteMany({ where: { characterId } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: characterId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await purgeTestData(prefix);
  });

  it("records one immutable snapshot without touching Release, Serving, or the Project version", async () => {
    const before = {
      releases: await prisma.characterRelease.count({ where: { projectId } }),
      serving: await prisma.characterServing.findUnique({ where: { characterId } }),
      project: await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }),
    };
    const response = await post(handoffRequest({ key: `${prefix}first` }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      characterId,
      projectId,
      contentVersionId: null,
      visualProfileId: null,
      referenceSetRevisionId: null,
      selectableImageCount: 0,
      note: null,
      createdById: adminId,
    });

    expect(await prisma.characterRelease.count({ where: { projectId } })).toBe(before.releases);
    expect(await prisma.characterServing.findUnique({ where: { characterId } })).toEqual(before.serving);
    const project = await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.version).toBe(before.project.version);
    expect(project.updatedAt).toEqual(before.project.updatedAt);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "character.handoff.recorded", targetId: characterId },
    });
    expect(audit).not.toBeNull();
  });

  it("replays the same idempotency key instead of writing a second record", async () => {
    const count = () => prisma.characterHandoff.count({ where: { characterId } });
    const key = `${prefix}replay`;
    const first = await post(handoffRequest({ key, body: { note: "ready" } }));
    expect(first.status).toBe(200);
    const after = await count();
    const second = await post(handoffRequest({ key, body: { note: "ready" } }));
    expect(second.status).toBe(200);
    expect(await count()).toBe(after);
    expect((await second.json()).data.id).toBe((await first.json()).data.id);
  });

  it("requires character.project.write", async () => {
    const response = await post(handoffRequest({ key: `${prefix}support`, role: "support", userId: ownerId }));
    expect(response.status).toBe(403);
  });

  // SPEC: 角色级权限包按分配的角色生效；scope 缺失不能被解析成全局授权。
  it("limits a character_creator grant to its assigned Characters", async () => {
    const grant = (scope: { characterIds: string[] } | null) => prisma.adminUserGrantBundle.create({
      data: {
        userId: creatorId,
        bundleKey: "character_creator",
        createdById: adminId,
        reason: "handoff test",
        ...(scope ? { scope } : {}),
      },
    });
    await createUser({ id: creatorId, role: "support", dataClass: "internal" });
    const unscoped = await grant(null);
    const denied = await post(handoffRequest({ key: `${prefix}creator-unscoped`, role: "support", userId: creatorId }));
    expect(denied.status).toBe(403);
    await prisma.adminUserGrantBundle.delete({ where: { id: unscoped.id } });
    await grant({ characterIds: [characterId] });
    const allowed = await post(handoffRequest({ key: `${prefix}creator-scoped`, role: "support", userId: creatorId }));
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).data.createdById).toBe(creatorId);
  });

  it("reports drift when the visual identity moves after the handoff, without blocking anything", async () => {
    const load = () => loadCharacterWorkspaceHandoff({ characterId, projectId });
    await post(handoffRequest({ key: `${prefix}baseline` }));
    const before = await load();
    expect(before?.drift).toEqual([]);
    expect(before?.createdById).toBe(adminId);
    expect(before?.createdByName).not.toBeNull();

    await prisma.characterVisualProfile.create({
      data: {
        id: profileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "fixture identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        adapterRefs: {},
        createdFrom: "handoff-test",
      },
    });
    expect((await load())?.drift).toEqual(["visual_identity"]);
    expect(await prisma.characterRelease.count({ where: { projectId } })).toBe(0);
  });

  it("names each drifted fact separately", () => {
    const facts = { contentVersionId: "a", visualProfileId: "b", visualProfileVersion: 1, referenceSetRevisionId: "c" };
    expect(characterHandoffDrift(facts, facts)).toEqual([]);
    expect(characterHandoffDrift(facts, {
      contentVersionId: "a2", visualProfileId: "b", visualProfileVersion: 2, referenceSetRevisionId: "c2",
    })).toEqual(["content", "visual_identity", "reference_set"]);
  });
});
