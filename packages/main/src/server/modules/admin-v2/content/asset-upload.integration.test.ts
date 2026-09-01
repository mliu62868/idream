import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "@/server/lib/db";

const providerState = vi.hoisted(() => ({
  storedKeys: [] as string[],
  deletedKeys: [] as string[],
}));

vi.mock("@/server/providers", () => ({
  providers: {
    blob: {
      async putPrivate(input: { key: string; body: Uint8Array }) {
        providerState.storedKeys.push(input.key);
        return {
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        };
      },
      async delete(input: { key: string }) {
        providerState.deletedKeys.push(input.key);
        return { ok: true as const, data: { deleted: true as const } };
      },
    },
  },
}));

import { POST as uploadAsset } from "@/app/api/v2/admin/assets/route";
import { POST as createPlacement } from "@/app/api/v2/admin/content/placements/route";

describe("Admin platform asset upload", () => {
  const suffix = randomUUID();
  const actorId = `platform-upload-admin-${suffix}`;
  const uploadedAssetIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
  });

  afterAll(async () => {
    await prisma.mediaAssetPlacement.deleteMany({
      where: { mediaAssetId: { in: uploadedAssetIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: uploadedAssetIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("imports external artwork idempotently without inventing generation lineage, then permits a draft placement", async () => {
    providerState.storedKeys = [];
    providerState.deletedKeys = [];
    const png = Uint8Array.from(await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: { r: 18, g: 36, b: 64 },
      },
    }).png().toBuffer());
    const idempotencyKey = `platform-upload-${suffix}`;

    const first = await uploadAsset(uploadRequest(png, idempotencyKey, "first"));
    expect(first.status).toBe(200);
    const firstPayload = await first.json();
    expect(firstPayload).toMatchObject({
      ok: true,
      data: {
        asset: {
          type: "image",
          contentType: "image/png",
          width: 320,
          height: 180,
          sourceJobId: null,
          sourceJob: null,
          sourceBatch: null,
          platformStatus: "approved",
          purpose: "feed",
          customerPublishable: true,
          publishabilityReasons: [],
        },
      },
    });
    const assetId = firstPayload.data.asset.id as string;
    uploadedAssetIds.push(assetId);

    const replay = await uploadAsset(uploadRequest(png, idempotencyKey, "replay"));
    await expect(replay.json()).resolves.toEqual(firstPayload);
    expect(providerState.storedKeys).toHaveLength(1);
    expect(providerState.deletedKeys).toEqual([]);

    const persisted = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: assetId },
      include: { productionItems: true },
    });
    expect(persisted).toMatchObject({
      ownerId: actorId,
      sourceJobId: null,
      visibility: "private",
      safetyStatus: "passed",
      productionItems: [],
    });
    expect(persisted.metadata).toMatchObject({
      source: "admin_asset_upload",
      uploadAuthority: {
        kind: "operator_upload",
        assetId,
        uploadedById: actorId,
      },
      platformAsset: { status: "approved", purpose: "feed" },
    });

    const placement = await createPlacement(new Request(
      "http://localhost/api/v2/admin/content/placements",
      {
        method: "POST",
        headers: adminHeaders(`placement-${suffix}`, true),
        body: JSON.stringify({
          mediaAssetId: assetId,
          slot: "feed_card",
          targetType: "route_page",
          targetId: "home-feed",
          status: "draft",
          metadata: {},
          reason: "Stage imported artwork for the feed",
        }),
      },
    ));
    expect(placement.status).toBe(200);
    await expect(placement.json()).resolves.toMatchObject({
      ok: true,
      data: {
        placement: {
          mediaAssetId: assetId,
          slot: "feed_card",
          status: "draft",
          asset: { customerPublishable: true },
        },
        replayed: false,
      },
    });
  });

  function uploadRequest(
    png: Uint8Array,
    idempotencyKey: string,
    requestLabel: string,
  ) {
    const form = new FormData();
    form.set("purpose", "feed");
    form.set("image", new File([
      new Uint8Array(png).buffer,
    ], "external-feed-art.jpg", {
      type: "image/jpeg",
    }));
    return new Request("http://localhost/api/v2/admin/assets", {
      method: "POST",
      headers: adminHeaders(idempotencyKey, false, requestLabel),
      body: form,
    });
  }

  function adminHeaders(
    idempotencyKey: string,
    json: boolean,
    requestLabel = "request",
  ) {
    return {
      "x-idream-user-id": actorId,
      "x-idream-role": "admin",
      "x-request-id": `${requestLabel}-${suffix}`,
      "idempotency-key": idempotencyKey,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }
});
