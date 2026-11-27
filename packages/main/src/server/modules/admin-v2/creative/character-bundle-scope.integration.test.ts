import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminGrantBundleKey } from "@idream/shared/admin";
import { GET as getImageSources } from "@/app/api/v2/admin/characters/[id]/image-sources/route";
import { POST as publishReferenceSet } from "@/app/api/v2/admin/characters/[id]/reference-sets/route";
import { POST as characterAssist } from "@/app/api/v2/admin/content/character-assist/route";
import { GET as getCreativeRun } from "@/app/api/v2/admin/creative/runs/[id]/route";
import { GET as listCreativeRuns, POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";

// SPEC: 角色级权限包（创作者 / 生产者 / 发布者）能在被分配的角色上走完本职链路，
//       新增的 creative.run.* / content.official.write 不越出被分配的角色；全局授予行为不变。
const prefix = "character-bundle-scope-";
const adminId = `${prefix}admin`;
const ownerId = `${prefix}owner`;
const creatorId = `${prefix}creator`;
const publisherId = `${prefix}publisher`;
const assignedId = `${prefix}assigned`;
const otherId = `${prefix}other`;
const assignedRunId = `${prefix}run-assigned`;
const otherRunId = `${prefix}run-other`;
const untargetedRunId = `${prefix}run-untargeted`;

function adminRequest(path: string, input: {
  readonly userId: string;
  readonly role?: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly key?: string;
}) {
  return new Request(`http://localhost${path}`, {
    method: input.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-idream-user-id": input.userId,
      "x-idream-role": input.role ?? "user",
      ...(input.key ? { "idempotency-key": input.key } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

async function errorDetails(response: Response) {
  const body = await response.json() as { error?: { details?: Record<string, unknown> } };
  return body.error?.details ?? {};
}

function runBody(characterId: string | null) {
  return {
    title: "Scope probe",
    purpose: characterId ? "character_cover" : "feed",
    targetType: characterId ? "character" : "none",
    ...(characterId ? { targetId: characterId } : {}),
    // Unknown on purpose: an admitted request ends in the same domain refusal for every actor.
    profileId: `${prefix}missing-profile`,
    presetIds: [],
    count: 1,
    brief: "A single scoped authority probe image.",
    consistencyMode: "balanced",
    priority: "normal",
    reason: "Probe the Character scope of Creative Run creation",
  };
}

async function grant(userId: string, bundleKey: AdminGrantBundleKey, characterIds: string[]) {
  await prisma.adminUserGrantBundle.create({
    data: {
      userId,
      bundleKey,
      createdById: adminId,
      reason: "character bundle scope test",
      scope: { characterIds },
    },
  });
}

describe("Character grant bundles reach Creative Runs only on assigned Characters", () => {
  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createUser({ id: ownerId, role: "user", dataClass: "internal" });
    await createUser({ id: creatorId, role: "user", dataClass: "internal" });
    await createUser({ id: publisherId, role: "user", dataClass: "internal" });
    await createCharacter({ id: assignedId, creatorId: ownerId, source: "official" });
    await createCharacter({ id: otherId, creatorId: ownerId, source: "official" });
    await grant(creatorId, "character_creator", [assignedId]);
    await grant(publisherId, "character_publisher", [assignedId]);
    const run = (id: string, target: { readonly type: string; readonly id?: string }) => ({
      id,
      title: `${prefix}${id}`,
      purpose: target.type === "character" ? "character_cover" : "feed",
      targetType: target.type,
      ...(target.id ? { targetId: target.id } : {}),
      presetIds: [],
      totalItems: 1,
      createdById: adminId,
    });
    await prisma.contentProductionBatch.createMany({
      data: [
        run(assignedRunId, { type: "character", id: assignedId }),
        run(otherRunId, { type: "character", id: otherId }),
        run(untargetedRunId, { type: "none" }),
      ],
    });
  });

  afterAll(async () => {
    const actorIds = [adminId, creatorId, publisherId];
    await prisma.contentProductionBatch.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { in: actorIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: actorIds } } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: { in: actorIds } } });
    await purgeTestData(prefix);
  });

  it("lets an assigned creator read the image library, and only of its assigned Character", async () => {
    const assigned = await getImageSources(
      adminRequest(`/api/v2/admin/characters/${assignedId}/image-sources`, { userId: creatorId }),
      params({ id: assignedId }),
    );
    expect(assigned.status).toBe(200);
    const other = await getImageSources(
      adminRequest(`/api/v2/admin/characters/${otherId}/image-sources`, { userId: creatorId }),
      params({ id: otherId }),
    );
    expect(other.status).toBe(403);
    expect(await errorDetails(other)).toMatchObject({ characterId: otherId });
  });

  it("admits an assigned creator's Run for its Character exactly like an admin, and refuses every other target", async () => {
    const create = (userId: string, role: string, characterId: string | null, key: string) =>
      createCreativeRun(adminRequest("/api/v2/admin/creative/runs", {
        userId,
        role,
        method: "POST",
        key: `${prefix}${key}`,
        body: runBody(characterId),
      }));

    const asAdmin = await create(adminId, "admin", assignedId, "admin-assigned");
    const asCreator = await create(creatorId, "user", assignedId, "creator-assigned");
    // Both pass the authority seam and meet the same domain refusal (the probe profile is unknown).
    expect(asCreator.status).not.toBe(403);
    expect(asCreator.status).toBe(asAdmin.status);
    const refusal = async (response: Response) =>
      ((await response.json()) as { error?: { message?: string } }).error?.message;
    const adminRefusal = await refusal(asAdmin);
    expect(adminRefusal).toBe("Production Studio requires an active image profile");
    expect(await refusal(asCreator)).toBe(adminRefusal);

    const outside = await create(creatorId, "user", otherId, "creator-other");
    expect(outside.status).toBe(403);
    expect(await errorDetails(outside)).toMatchObject({ permission: "creative.run.write", characterId: otherId });

    const untargeted = await create(creatorId, "user", null, "creator-untargeted");
    expect(untargeted.status).toBe(403);
    expect(await errorDetails(untargeted)).toMatchObject({ permission: "creative.run.write", characterId: null });

    const adminUntargeted = await create(adminId, "admin", null, "admin-untargeted");
    expect(adminUntargeted.status).not.toBe(403);
  });

  it("lists and opens only the scoped creator's Runs, while admin still sees every Run", async () => {
    const listIds = async (userId: string, role: string) => {
      const response = await listCreativeRuns(adminRequest(
        `/api/v2/admin/creative/runs?search=${prefix}&limit=100`,
        { userId, role },
      ));
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { items: Array<{ id: string }> } };
      return new Set(body.data.items.map((item) => item.id));
    };
    expect(await listIds(creatorId, "user")).toEqual(new Set([assignedRunId]));
    expect(await listIds(adminId, "admin")).toEqual(new Set([assignedRunId, otherRunId, untargetedRunId]));

    const open = (userId: string, role: string, runId: string) => getCreativeRun(
      adminRequest(`/api/v2/admin/creative/runs/${runId}`, { userId, role }),
      params({ id: runId }),
    );
    expect((await open(creatorId, "user", assignedRunId)).status).toBe(200);
    expect((await open(creatorId, "user", otherRunId)).status).toBe(403);
    expect((await open(creatorId, "user", untargetedRunId)).status).toBe(403);
    expect((await open(adminId, "admin", otherRunId)).status).toBe(200);
    expect((await open(adminId, "admin", untargetedRunId)).status).toBe(200);
  });

  it("lets a publisher read the image library but never create a Run", async () => {
    const library = await getImageSources(
      adminRequest(`/api/v2/admin/characters/${assignedId}/image-sources`, { userId: publisherId }),
      params({ id: assignedId }),
    );
    expect(library.status).toBe(200);
    const created = await createCreativeRun(adminRequest("/api/v2/admin/creative/runs", {
      userId: publisherId,
      method: "POST",
      key: `${prefix}publisher-assigned`,
      body: runBody(assignedId),
    }));
    expect(created.status).toBe(403);
    expect(await errorDetails(created)).toMatchObject({ permission: "creative.run.write" });
  });

  it("scopes the creator's content.official.write to assigned Characters and keeps creation aid closed", async () => {
    const publish = (characterId: string) => publishReferenceSet(
      adminRequest(`/api/v2/admin/characters/${characterId}/reference-sets`, {
        userId: creatorId,
        method: "POST",
        key: `${prefix}reference-${characterId}`,
        body: {},
      }),
      params({ id: characterId }),
    );
    const outside = await publish(otherId);
    expect(outside.status).toBe(403);
    expect(await errorDetails(outside)).toMatchObject({ permission: "content.official.write", characterId: otherId });
    // Admitted on the assigned Character: the empty body is refused by the contract, not by authority.
    expect((await publish(assignedId)).status).toBe(400);

    const assist = await characterAssist(adminRequest("/api/v2/admin/content/character-assist", {
      userId: creatorId,
      method: "POST",
      body: { inspiration: "scoped creators cannot use creation aid" },
    }));
    expect(assist.status).toBe(403);
  });
});
