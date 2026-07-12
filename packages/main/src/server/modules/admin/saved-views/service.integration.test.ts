import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  api,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-saved-view-command-";
const actorId = `${P}admin`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: actorId, role: "admin" });
});

afterAll(async () => {
  await removeFaultInjection();
  await prisma.adminSavedView.deleteMany({ where: { ownerId: actorId } });
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("generic saved-view commands", () => {
  it("replays exact creates, rejects collisions, and deletes with an atomic receipt", async () => {
    const createKey = `${P}create-key`;
    const body = {
      scope: `${P}scope`,
      label: `${P}view`,
      filters: { status: "open" },
    };
    const first = await mutate("POST", "admin/saved-views", createKey, body);
    const replay = await mutate("POST", "admin/saved-views", createKey, body);
    expectOk(first);
    expectOk(replay);
    expect(replay.data).toMatchObject({
      replayed: true,
      view: { id: first.data.view.id },
    });
    expectError(
      await mutate("POST", "admin/saved-views", createKey, {
        ...body,
        label: `${P}collision`,
      }),
      409,
      "conflict",
    );
    await expect(
      prisma.adminSavedView.count({ where: { ownerId: actorId } }),
    ).resolves.toBe(1);

    const deleteKey = `${P}delete-key`;
    const path = `admin/saved-views/${first.data.view.id}`;
    const deleted = await mutate("DELETE", path, deleteKey);
    const deleteReplay = await mutate("DELETE", path, deleteKey);
    expectOk(deleted);
    expectOk(deleteReplay);
    expect(deleteReplay.data).toMatchObject({ deleted: true, replayed: true });
    await expect(
      prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey: { in: [createKey, deleteKey] } },
      }),
    ).resolves.toBe(2);
  });

  it("rolls back the view and command receipt when the domain insert fails", async () => {
    const key = `${P}fault-key`;
    const label = `${P}fault`;
    await installFaultInjection(label);
    const failed = await mutate("POST", "admin/saved-views", key, {
      scope: `${P}scope`,
      label,
      filters: {},
    });
    expectError(failed, 500);
    await expect(
      prisma.adminSavedView.count({ where: { ownerId: actorId, label } }),
    ).resolves.toBe(0);
    await expect(
      prisma.controlPlaneCommand.count({
        where: { actorId, idempotencyKey: key },
      }),
    ).resolves.toBe(0);
  });
});

function mutate(
  method: "POST" | "DELETE",
  path: string,
  idempotencyKey: string,
  body?: Record<string, unknown>,
) {
  return api(method, path, {
    userId: actorId,
    role: "admin",
    headers: { "idempotency-key": idempotencyKey },
    body,
  });
}

async function installFaultInjection(label: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION zt_saved_view_fail_insert()
    RETURNS trigger AS $$
    BEGIN
      IF NEW."label" = '${label}' THEN
        RAISE EXCEPTION 'injected saved-view insert failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_saved_view_fail_insert ON "admin_saved_views";
    CREATE TRIGGER zt_saved_view_fail_insert
    BEFORE INSERT ON "admin_saved_views"
    FOR EACH ROW EXECUTE FUNCTION zt_saved_view_fail_insert();
  `);
}

async function removeFaultInjection() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS zt_saved_view_fail_insert ON "admin_saved_views";
    DROP FUNCTION IF EXISTS zt_saved_view_fail_insert();
  `);
}
