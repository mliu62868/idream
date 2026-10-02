import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { adminV2 } from "@/server/test/admin-v2-http";
import { toInputJson } from "../shared/prisma-json";
import * as placements from "./placements";

const actorId = "seed-admin-user";
const suffix = randomUUID();
const assetIds: string[] = [];
const placementIds: string[] = [];
const storageKeys: string[] = [];
const commandKeys: string[] = [];

function commandKey() {
  const key = `placement-receipt-${suffix}-${commandKeys.length}`;
  commandKeys.push(key);
  return key;
}

async function uploadedDraft() {
  const pixels = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + (i >>> 7)) % 256;
  const image = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  const form = new FormData();
  form.set("image", new File([new Uint8Array(image)], "receipt-regression.png", { type: "image/png" }));
  form.set("purpose", "campaign");
  const uploaded = await adminV2<{ asset: { id: string } }>("POST", "assets", { userId: actorId, role: "admin", form, idempotencyKey: commandKey() });
  expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(200);
  const assetId = uploaded.data.asset.id;
  assetIds.push(assetId);
  storageKeys.push((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).storageKey!);
  return {
    mediaAssetId: assetId, slot: "campaign", targetType: "campaign", targetId: `receipt-target-${assetId}`,
    status: "draft", metadata: { eyebrow: "Receipt regression", title: "Actual uploaded artwork" },
    reason: "Verify historical Placement command replay",
  } as const;
}

async function createDraft(body: Awaited<ReturnType<typeof uploadedDraft>>, key = commandKey()) {
  const created = await adminV2("POST", "content/placements", { userId: actorId, role: "admin", body, idempotencyKey: key });
  expect(created.status, JSON.stringify(created.error)).toBe(200);
  placementIds.push(created.data.placement.id);
  return created.data.placement;
}

async function storeOldReceipt(key: string) {
  const command = await prisma.controlPlaneCommand.findUniqueOrThrow({
    where: { scope_idempotencyKey: { scope: `test:${actorId}`, idempotencyKey: key } },
  });
  // This is the persisted DTO emitted before canPublish was added to the response contract.
  const result = JSON.parse(JSON.stringify(command.result));
  expect(result.placement).toHaveProperty("canPublish");
  Reflect.deleteProperty(result.placement, "canPublish");
  await prisma.controlPlaneCommand.update({ where: { id: command.id }, data: { result: toInputJson(result) } });
  return command.id;
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId, idempotencyKey: { in: commandKeys } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: [...placementIds, ...assetIds] } } });
  await prisma.mediaAssetPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
  for (const key of storageKeys) await providers.blob.delete({ key });
  await prisma.$disconnect();
});

describe("Placement persisted receipt upgrade", () => {
  it.each(["create", "patch"] as const)("replays an actual stored old %s result without re-running its mutation", async (operation) => {
    const body = await uploadedDraft();
    const key = commandKey();
    const placement = await createDraft(body, operation === "create" ? key : commandKey());
    const patch = { status: "paused", reason: "Pause the historical receipt fixture", confirmation: placement.id } as const;
    if (operation === "patch") {
      expect((await adminV2("PATCH", `content/placements/${placement.id}`, {
        userId: actorId, role: "admin", body: patch, ifMatch: placement.version, idempotencyKey: key,
      })).status).toBe(200);
    }
    const before = await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: placement.id } });
    const commandId = await storeOldReceipt(key);
    const replay = await adminV2(operation === "create" ? "POST" : "PATCH", operation === "create" ? "content/placements" : `content/placements/${placement.id}`, {
      userId: actorId, role: "admin", body: operation === "create" ? body : patch,
      ...(operation === "patch" ? { ifMatch: placement.version } : {}), idempotencyKey: key,
    });
    expect(replay.status, JSON.stringify(replay.error)).toBe(200);
    expect(replay.data).toMatchObject({ replayed: true, placement: { id: placement.id, version: before.version, canPublish: false } });
    expect(await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: placement.id } })).toEqual(before);
    expect(await prisma.controlPlaneCommand.count({ where: { actorId, idempotencyKey: key } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { targetId: placement.id, action: operation === "create" ? "content.placement.create" : "content.placement.paused" } })).toBe(1);
    const stored = await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(JSON.parse(JSON.stringify(stored.result)).placement).not.toHaveProperty("canPublish");
    const detail = await adminV2("GET", `content/placements/${placement.id}`, { userId: actorId, role: "admin" });
    expect(detail.status).toBe(200);
    expect(detail.data.placement.canPublish).toBe(true);
    const collision = await adminV2(operation === "create" ? "POST" : "PATCH", operation === "create" ? "content/placements" : `content/placements/${placement.id}`, {
      userId: actorId, role: "admin", body: { ...(operation === "create" ? body : patch), reason: "A different payload must still be rejected" },
      ...(operation === "patch" ? { ifMatch: placement.version } : {}), idempotencyKey: key,
    });
    expect(collision.status).toBe(409);
  });

  it.each(["create", "patch"] as const)("still rejects and rolls back a fresh %s result missing the required field", async (operation) => {
    const body = await uploadedDraft();
    const key = commandKey();
    if (operation === "create") {
      const original = placements.createPlacement;
      vi.spyOn(placements, "createPlacement").mockImplementationOnce(async input => {
        const result = await original(input);
        placementIds.push(result.placement.id);
        Reflect.deleteProperty(result.placement, "canPublish");
        return result;
      });
      const failed = await adminV2("POST", "content/placements", { userId: actorId, role: "admin", body, idempotencyKey: key });
      expect(failed.status).toBe(400);
      expect(await prisma.mediaAssetPlacement.count({ where: { targetId: body.targetId } })).toBe(0);
      expect(await prisma.adminAuditLog.count({ where: { targetId: placementIds.at(-1), action: "content.placement.create" } })).toBe(0);
    } else {
      const placement = await createDraft(body);
      const original = placements.patchPlacement;
      vi.spyOn(placements, "patchPlacement").mockImplementationOnce(async input => {
        const result = await original(input);
        Reflect.deleteProperty(result.placement, "canPublish");
        return result;
      });
      const failed = await adminV2("PATCH", `content/placements/${placement.id}`, {
        userId: actorId, role: "admin", idempotencyKey: key, ifMatch: placement.version,
        body: { status: "paused", reason: "Reject a malformed fresh response", confirmation: placement.id },
      });
      expect(failed.status).toBe(400);
      expect(await prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: placement.id } })).toMatchObject({ status: "draft", version: placement.version });
      expect(await prisma.adminAuditLog.count({ where: { targetId: placement.id, action: "content.placement.paused" } })).toBe(0);
    }
    expect(await prisma.controlPlaneCommand.count({ where: { actorId, idempotencyKey: key } })).toBe(0);
  });
});
