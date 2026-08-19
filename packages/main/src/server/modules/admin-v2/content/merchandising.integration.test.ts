import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import {
  createCharacter,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-content-merch-";
const actorId = `${P}admin`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: actorId, role: "admin", dataClass: "internal" });
});

afterAll(async () => {
  await removeFaultInjection();
  await prisma.appSetting.deleteMany({ where: { key: "feed.featured" } });
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("content merchandising commands", () => {
  it("replays an exact visibility command and rejects key collisions", async () => {
    const characterId = `${P}visibility`;
    const idempotencyKey = `${P}visibility-key`;
    await createCharacter({
      id: characterId,
      creatorId: actorId,
      source: "user",
      name: "Visibility command",
      visibility: "public",
      status: "approved",
    });
    const body = {
      visibility: "private",
      reason: "verify exact content command replay",
      confirmation: `${characterId}:visibility:private`,
    };
    const first = await command(characterId, "visibility", idempotencyKey, body);
    const replay = await command(characterId, "visibility", idempotencyKey, body);
    expectOk(first);
    expectOk(replay);
    expect(replay.data).toMatchObject({
      character: first.data.character,
      replayed: true,
    });

    const collision = await command(characterId, "visibility", idempotencyKey, {
      visibility: "public",
      reason: "attempt key reuse with changed payload",
      confirmation: `${characterId}:visibility:public`,
    });
    expectError(collision, 409, "conflict");
    await expect(
      prisma.adminAuditLog.count({
        where: { action: "content.visibility.write", targetId: characterId },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.mainOutboxEvent.count({
        where: {
          eventType: "admin.content.visibility_changed.v2",
          aggregateId: characterId,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey },
      }),
    ).resolves.toBe(1);
  });

  it("records status and featured commands in the control plane transaction", async () => {
    const statusId = `${P}status`;
    const featuredId = `${P}featured`;
    await createCharacter({
      id: statusId,
      creatorId: actorId,
      source: "user",
      name: "Status command",
      visibility: "public",
      status: "approved",
    });
    await createCharacter({
      id: featuredId,
      creatorId: actorId,
      source: "user",
      name: "Featured command",
      visibility: "public",
      status: "approved",
    });
    const status = await command(statusId, "status", `${P}status-key`, {
      status: "removed",
      reason: "verify status command transaction",
      confirmation: `${statusId}:status:removed`,
    });
    const currentFeatured = await adminV2Api("GET", "/api/v2/admin/content/featured", {
      userId: actorId,
      role: "admin",
    });
    expectOk(currentFeatured);
    const featured = await adminV2Api("PUT", "/api/v2/admin/content/featured", {
      userId: actorId,
      role: "admin",
      headers: { "idempotency-key": `${P}featured-key` },
      body: {
        characterIds: [featuredId],
        expectedVersion: currentFeatured.data.settingVersion,
        reason: "verify featured command transaction",
        confirmation: featuredId,
      },
    });
    expectOk(status);
    expectOk(featured);
    await expect(
      prisma.controlPlaneCommand.count({
        where: {
          actorId,
          commandType: {
            in: ["content.status.write", "content.featured.write"],
          },
        },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.mainOutboxEvent.count({
        where: {
          eventType: {
            in: [
              "admin.content.status_changed.v2",
              "admin.content.featured_updated.v2",
            ],
          },
          payload: { path: ["actorId"], equals: actorId },
        },
      }),
    ).resolves.toBe(2);
  });

  it("rolls back domain, audit, and command rows when outbox insertion fails", async () => {
    const characterId = `${P}rollback`;
    const requestId = `${P}fail-outbox`;
    const idempotencyKey = `${P}rollback-key`;
    await createCharacter({
      id: characterId,
      creatorId: actorId,
      source: "user",
      name: "Rollback command",
      visibility: "public",
      status: "approved",
    });
    // INTENT: an infrastructure failure is not an authority decision, so `adminV2Route` lets it
    // out untouched and the framework turns it into a 500. Invoking the handler directly here
    // therefore observes the raw throw; the invariant under test is the rollback below.
    await installFaultInjection(requestId);
    await expect(command(
      characterId,
      "visibility",
      idempotencyKey,
      {
        visibility: "private",
        reason: "verify transactional outbox rollback",
        confirmation: `${characterId}:visibility:private`,
      },
      requestId,
    )).rejects.toThrow(/injected content command outbox failure/);
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ visibility: "public" });
    await expect(
      prisma.adminAuditLog.count({ where: { targetId: characterId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.mainOutboxEvent.count({ where: { aggregateId: characterId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.controlPlaneCommand.count({ where: { actorId, idempotencyKey } }),
    ).resolves.toBe(0);
  });

  it("attaches curated tags to a character, including official ones", async () => {
    // SPEC: 分类法链路此前缺「挂载」这一环——标签只能随创建写一次，且唯一入口没有前端。
    // INTENT: 官方角色恰恰是需要打标签的那批（16 个目录角色都是 official），所以这条命令
    //         刻意不像 visibility/status 那样 rejectOfficialCharacter。
    const characterId = `${P}tags-official`;
    await createCharacter({
      id: characterId,
      creatorId: actorId,
      source: "official",
      name: "Taggable official",
      visibility: "public",
      status: "approved",
    });
    const slow = await prisma.tag.create({
      data: { slug: `${P}slow-burn`, label: "Slow Burn" },
    });
    const elf = await prisma.tag.create({
      data: { slug: `${P}elf`, label: "Elf" },
    });

    const applied = await tagsCommand(characterId, `${P}tags-key-1`, {
      tagIds: [slow.id, elf.id],
      reason: "curate discovery taxonomy for the launch catalog",
      confirmation: `${characterId}:tags`,
    });
    expectOk(applied);
    expect(applied.data.character.tags).toEqual(["Elf", "Slow Burn"]);

    // 整组替换：再发一次只留一个，另一个必须被摘掉。
    const replaced = await tagsCommand(characterId, `${P}tags-key-2`, {
      tagIds: [elf.id],
      reason: "drop the mismatched pacing tag",
      confirmation: `${characterId}:tags`,
    });
    expectOk(replaced);
    const links = await prisma.characterTag.findMany({
      where: { characterId },
      include: { tag: true },
    });
    expect(links.map((link) => link.tag.label)).toEqual(["Elf"]);
  });

  it("refuses unknown tags and mismatched confirmation", async () => {
    const characterId = `${P}tags-guard`;
    await createCharacter({
      id: characterId,
      creatorId: actorId,
      source: "user",
      name: "Tag guards",
      visibility: "public",
      status: "approved",
    });

    // 不隐式建标签：造词是 Taxonomy 的治理动作，从角色页 upsert 出新标签是分类法失控的起点。
    expectError(
      await tagsCommand(characterId, `${P}tags-key-3`, {
        tagIds: [`${P}does-not-exist`],
        reason: "attempt to invent taxonomy from the character page",
        confirmation: `${characterId}:tags`,
      }),
      400,
    );
    expect(
      await prisma.characterTag.count({ where: { characterId } }),
    ).toBe(0);

    expectError(
      await tagsCommand(characterId, `${P}tags-key-4`, {
        tagIds: [],
        reason: "confirmation does not match the tag target",
        confirmation: `${characterId}:visibility:private`,
      }),
      400,
    );
  });
});

function tagsCommand(
  characterId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
) {
  return adminV2Api("PUT", `/api/v2/admin/content/characters/${characterId}/tags`, {
    userId: actorId,
    role: "admin",
    headers: { "idempotency-key": idempotencyKey },
    body,
  });
}

function command(
  characterId: string,
  field: "visibility" | "status",
  idempotencyKey: string,
  body: Record<string, unknown>,
  requestId?: string,
) {
  return adminV2Api("POST", `/api/v2/admin/content/characters/${characterId}/${field}`, {
    userId: actorId,
    role: "admin",
    headers: {
      "idempotency-key": idempotencyKey,
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body,
  });
}

async function installFaultInjection(requestId: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_admin_content_fail_outbox()
    RETURNS trigger AS $$
    BEGIN
      IF NEW."eventType" = 'admin.content.visibility_changed.v2'
        AND COALESCE(NEW."payload"->>'requestId', '') = '${requestId}' THEN
        RAISE EXCEPTION 'injected content command outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_content_fail_outbox ON "main_outbox_events";
    CREATE TRIGGER zt_admin_content_fail_outbox
    BEFORE INSERT ON "main_outbox_events"
    FOR EACH ROW EXECUTE FUNCTION zt_admin_content_fail_outbox();
  `);
}

async function removeFaultInjection() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_admin_content_fail_outbox ON "main_outbox_events";
    DROP FUNCTION IF EXISTS zt_admin_content_fail_outbox();
  `);
}
