import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import {
  GET as listGrantBundlesRoute,
  POST as grantBundleRoute,
} from "@/app/api/v2/admin/users/[id]/grant-bundles/route";
import { DELETE as revokeBundleRoute } from "@/app/api/v2/admin/users/[id]/grant-bundles/[bundleKey]/route";

describe("persisted Admin grant bundle authority", () => {
  const suffix = randomUUID();
  const adminId = `grant-bundle-admin-${suffix}`;
  const operatorId = `grant-bundle-operator-${suffix}`;
  const characterId = `grant-bundle-character-${suffix}`;
  const headers = { "x-idream-user-id": adminId, "x-idream-role": "admin", "x-request-id": `grant-bundle-${suffix}` };

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@idream.internal`, role: "admin", status: "active" },
        { id: operatorId, email: `${operatorId}@idream.internal`, role: "ops", status: "active" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { eventType: { in: ["admin.grant_bundle.granted.v2", "admin.grant_bundle.revoked.v2"] } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: adminId }, { targetId: operatorId }] } });
    await prisma.adminUserPermission.deleteMany({ where: { userId: operatorId } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: operatorId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, operatorId] } } });
    await prisma.$disconnect();
  });

  function request(method: string, body?: unknown, options?: { readonly key?: string; readonly bundleKey?: string }) {
    const suffixPath = options?.bundleKey ? `/${options.bundleKey}` : "";
    return new Request(`http://localhost/api/v2/admin/users/${operatorId}/grant-bundles${suffixPath}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(options?.key ? { "idempotency-key": options.key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("requires Idempotency-Key before granting authority", async () => {
    const response = await grantBundleRoute(request("POST", {
      bundleKey: "growth_operator",
      reason: "Exercise the grant mutation transport precondition",
      confirmation: `${operatorId}:growth_operator:grant`,
    }), { params: Promise.resolve({ id: operatorId }) });
    expect(response.status).toBe(400);
    await expect(prisma.adminUserGrantBundle.count({
      where: { userId: operatorId, bundleKey: "growth_operator" },
    })).resolves.toBe(0);
  });

  it("rolls back grant state, Audit, and Outbox when receipt persistence fails", async () => {
    const key = `rollback-grant-${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_grant_bundle_receipt() RETURNS trigger AS $$
      BEGIN
        IF NEW."commandType" = 'admin.grant_bundle.grant' THEN
          RAISE EXCEPTION 'injected grant bundle receipt failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_grant_bundle_receipt_trigger
      BEFORE INSERT ON "control_plane_commands"
      FOR EACH ROW EXECUTE FUNCTION fail_grant_bundle_receipt();
    `);
    try {
      await expect(grantBundleRoute(request("POST", {
        bundleKey: "creative_operator",
        reason: "Exercise atomic grant receipt rollback",
        confirmation: `${operatorId}:creative_operator:grant`,
      }, { key }), { params: Promise.resolve({ id: operatorId }) }))
        .rejects.toThrow("injected grant bundle receipt failure");
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_grant_bundle_receipt_trigger ON "control_plane_commands";
        DROP FUNCTION IF EXISTS fail_grant_bundle_receipt();
      `);
    }
    await expect(prisma.adminUserGrantBundle.count({
      where: { userId: operatorId, bundleKey: "creative_operator" },
    })).resolves.toBe(0);
    await expect(prisma.adminAuditLog.count({
      where: { actorId: adminId, targetId: operatorId, action: "admin.grant_bundle.granted" },
    })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({
      where: { eventType: "admin.grant_bundle.granted.v2" },
    })).resolves.toBe(0);
  });

  it("grants a scoped bundle, applies override precedence, and revokes it with Audit", async () => {
    expect(await effectivePermissions(operatorId, "ops")).not.toContain("character.project.read");
    const grantKey = `character-grant-${suffix}`;
    const grantBody = {
      bundleKey: "character_producer",
      scope: { characterIds: [characterId] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "Assign one Character production portfolio",
      confirmation: `${operatorId}:character_producer:grant`,
    } as const;
    const granted = await grantBundleRoute(request("POST", grantBody, { key: grantKey }), {
      params: Promise.resolve({ id: operatorId }),
    });
    expect(granted.status).toBe(201);
    const grantedBody = await granted.json();
    expect(grantedBody.data.bundle).not.toHaveProperty("reason");
    expect(grantedBody.data.bundle).not.toHaveProperty("createdById");
    const grantReplay = await grantBundleRoute(request("POST", grantBody, { key: grantKey }), {
      params: Promise.resolve({ id: operatorId }),
    });
    expect(await grantReplay.json()).toEqual(grantedBody);
    const grantCollision = await grantBundleRoute(request("POST", {
      ...grantBody,
      reason: "A changed reason must not reuse the original grant receipt",
    }, { key: grantKey }), { params: Promise.resolve({ id: operatorId }) });
    expect(grantCollision.status).toBe(409);
    const effective = await effectivePermissions(operatorId, "ops");
    for (const permission of [
      "character.project.read",
      "character.project.write",
      "character.release.read",
      "character.release.propose",
      "character.release.review",
      "character.performance.read",
    ] as const) expect(effective).toContain(permission);
    const scopedRequest = new Request("http://localhost/api/v2/admin/characters", {
      headers: { "x-idream-user-id": operatorId, "x-idream-role": "ops" },
    });
    await expect(actorWithPermission(scopedRequest, "character.project.read", { characterId })).resolves.toMatchObject({ id: operatorId });
    await expect(actorWithPermission(scopedRequest, "character.project.read", { characterId: `unassigned-${suffix}` })).rejects.toMatchObject({ code: "forbidden" });

    const listed = await listGrantBundlesRoute(request("GET"), { params: Promise.resolve({ id: operatorId }) });
    const body = await listed.json();
    expect(body.data.items).toEqual([expect.objectContaining({
      bundleKey: "character_producer",
      state: "active",
      scope: { characterIds: [characterId] },
    })]);

    await prisma.adminUserPermission.create({
      data: {
        userId: operatorId,
        permissionKey: "character.project.write",
        effect: "revoke",
        reason: "Read-only production assignment",
        createdById: adminId,
      },
    });
    const overridden = await effectivePermissions(operatorId, "ops");
    expect(overridden).toContain("character.project.read");
    expect(overridden).not.toContain("character.project.write");

    const revokeKey = `character-revoke-${suffix}`;
    const revokeBody = {
      reason: "Production assignment ended",
      confirmation: `${operatorId}:character_producer:revoke`,
    } as const;
    const revoked = await revokeBundleRoute(request("DELETE", revokeBody, {
      key: revokeKey,
      bundleKey: "character_producer",
    }), {
      params: Promise.resolve({ id: operatorId, bundleKey: "character_producer" }),
    });
    expect(revoked.status).toBe(200);
    const revokedBody = await revoked.json();
    const revokeReplay = await revokeBundleRoute(request("DELETE", revokeBody, {
      key: revokeKey,
      bundleKey: "character_producer",
    }), { params: Promise.resolve({ id: operatorId, bundleKey: "character_producer" }) });
    expect(await revokeReplay.json()).toEqual(revokedBody);
    const revokeCollision = await revokeBundleRoute(request("DELETE", {
      ...revokeBody,
      reason: "A changed reason must not reuse the original revoke receipt",
    }, { key: revokeKey, bundleKey: "character_producer" }), {
      params: Promise.resolve({ id: operatorId, bundleKey: "character_producer" }),
    });
    expect(revokeCollision.status).toBe(409);
    expect(await effectivePermissions(operatorId, "ops")).not.toContain("character.project.read");
    expect(await prisma.adminAuditLog.count({
      where: { actorId: adminId, targetId: operatorId, action: { in: ["admin.grant_bundle.granted", "admin.grant_bundle.revoked"] } },
    })).toBe(2);
    expect(await prisma.mainOutboxEvent.count({
      where: { eventType: { in: ["admin.grant_bundle.granted.v2", "admin.grant_bundle.revoked.v2"] } },
    })).toBe(2);
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId: adminId, commandType: { in: ["admin.grant_bundle.grant", "admin.grant_bundle.revoke"] } },
    })).toBe(2);
  });
});
