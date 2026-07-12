import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
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
  await createUser({ id: actorId, role: "admin" });
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
      name: "Status command",
      visibility: "public",
      status: "approved",
    });
    await createCharacter({
      id: featuredId,
      name: "Featured command",
      visibility: "public",
      status: "approved",
    });
    const status = await command(statusId, "status", `${P}status-key`, {
      status: "removed",
      reason: "verify status command transaction",
      confirmation: `${statusId}:status:removed`,
    });
    const featured = await api("PUT", "admin/content/featured", {
      userId: actorId,
      role: "admin",
      headers: { "idempotency-key": `${P}featured-key` },
      body: {
        characterIds: [featuredId],
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
      name: "Rollback command",
      visibility: "public",
      status: "approved",
    });
    await installFaultInjection(requestId);
    const failed = await command(
      characterId,
      "visibility",
      idempotencyKey,
      {
        visibility: "private",
        reason: "verify transactional outbox rollback",
        confirmation: `${characterId}:visibility:private`,
      },
      requestId,
    );
    expectError(failed, 500);
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
});

function command(
  characterId: string,
  field: "visibility" | "status",
  idempotencyKey: string,
  body: Record<string, unknown>,
  requestId?: string,
) {
  return api("POST", `admin/content/characters/${characterId}/${field}`, {
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
