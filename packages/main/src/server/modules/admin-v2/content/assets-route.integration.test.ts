import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listAssets } from "@/app/api/v2/admin/assets/route";
import {
  GET as getAsset,
  PATCH as patchAsset,
} from "@/app/api/v2/admin/assets/[id]/route";
import { POST as preflightAssets } from "@/app/api/v2/admin/assets/bulk/preflight/route";
import { POST as bulkPatchAssets } from "@/app/api/v2/admin/assets/bulk/route";
import { prisma } from "@/server/lib/db";

describe("Admin v2 Image Library route authority", () => {
  const suffix = randomUUID();
  const actorId = `asset-v2-route-admin-${suffix}`;
  const assetIds = [
    `asset-v2-route-a-${suffix}`,
    `asset-v2-route-b-${suffix}`,
  ].sort();

  function request(
    method: "GET" | "PATCH" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: assetIds.map((id) => ({
        id,
        ownerId: actorId,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        metadata: {
          platformAsset: {
            status: "approved",
            purpose: "feed",
            tags: ["v2-route"],
          },
        },
      })),
    });
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  describe("prompt text on customer-owned media", () => {
    const customerId = `asset-v2-customer-${suffix}`;
    const jobId = `asset-v2-customer-job-${suffix}`;
    const customerAssetId = `asset-v2-customer-asset-${suffix}`;
    const platformAssetId = `asset-v2-platform-asset-${suffix}`;
    const privatePrompt = `PRIVATE_CUSTOMER_PROMPT_${suffix}`;

    beforeAll(async () => {
      await prisma.user.create({
        data: { id: customerId, email: `${customerId}@example.test`, role: "user", status: "active", dataClass: "customer" },
      });
      await prisma.generationJob.create({
        data: {
          id: jobId,
          userId: customerId,
          mode: "image",
          prompt: privatePrompt,
          controls: {},
          presetIds: [],
          sourceType: "chat_handoff",
          sourceMeta: { promptHint: privatePrompt, conversationContext: privatePrompt, sessionId: "session-1" },
        },
      });
      await prisma.mediaAsset.createMany({
        data: [
          {
            id: customerAssetId,
            ownerId: customerId,
            sourceJobId: jobId,
            type: "image",
            url: `memory://${customerAssetId}`,
            safetyStatus: "passed",
            prompt: privatePrompt,
            metadata: { provider: "mock", prompt: privatePrompt, nested: { promptHint: privatePrompt } },
          },
          {
            id: platformAssetId,
            ownerId: actorId,
            type: "image",
            url: `memory://${platformAssetId}`,
            safetyStatus: "passed",
            prompt: "Operator-authored direction",
            metadata: { platformAsset: { status: "approved", purpose: "feed" } },
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.mediaAsset.deleteMany({ where: { id: { in: [customerAssetId, platformAssetId] } } });
      await prisma.generationJob.deleteMany({ where: { id: jobId } });
      await prisma.user.deleteMany({ where: { id: customerId } });
    });

    it("omits every copy of the prompt for a reader with only creative.asset.read", async () => {
      const response = await getAsset(
        request("GET", `/api/v2/admin/assets/${customerAssetId}`),
        { params: Promise.resolve({ id: customerAssetId }) },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(privatePrompt);
      expect(JSON.parse(text)).toMatchObject({
        data: {
          asset: {
            id: customerAssetId,
            promptSummary: null,
            metadata: { provider: "mock", nested: {} },
            sourceJob: { id: jobId, sourceMeta: null },
          },
        },
      });
    });

    it("keeps the prompt summary on operator-authored platform assets", async () => {
      const response = await getAsset(
        request("GET", `/api/v2/admin/assets/${platformAssetId}`),
        { params: Promise.resolve({ id: platformAssetId }) },
      );
      await expect(response.json()).resolves.toMatchObject({
        data: { asset: { promptSummary: "Operator-authored direction" } },
      });
    });
  });

  it("executes list, detail, idempotent patch, preflight, and bulk archive through the manifest seam", async () => {
    const listed = await listAssets(request(
      "GET",
      `/api/v2/admin/assets?status=approved&purpose=feed&search=${assetIds[0]}`,
    ));
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ id: assetIds[0], platformStatus: "approved" }],
      },
    });

    const detail = await getAsset(
      request("GET", `/api/v2/admin/assets/${assetIds[0]}`),
      { params: Promise.resolve({ id: assetIds[0] }) },
    );
    await expect(detail.json()).resolves.toMatchObject({
      ok: true,
      data: {
        asset: {
          id: assetIds[0],
          authorityDependencies: [],
        },
      },
    });

    const patchBody = {
      description: "v2 route metadata",
      reason: "verify the manifest-governed asset mutation",
      confirmation: assetIds[0],
    };
    const patchKey = `asset-v2-patch-${suffix}`;
    const firstPatch = await patchAsset(
      request("PATCH", `/api/v2/admin/assets/${assetIds[0]}`, patchBody, {
        "idempotency-key": patchKey,
        "x-request-id": `asset-v2-patch-first-${suffix}`,
      }),
      { params: Promise.resolve({ id: assetIds[0] }) },
    );
    const firstPatchPayload = await firstPatch.json();
    expect(firstPatchPayload).toMatchObject({
      ok: true,
      data: { asset: { id: assetIds[0], description: "v2 route metadata" } },
    });
    const replay = await patchAsset(
      request("PATCH", `/api/v2/admin/assets/${assetIds[0]}`, patchBody, {
        "idempotency-key": patchKey,
        "x-request-id": `asset-v2-patch-replay-${suffix}`,
      }),
      { params: Promise.resolve({ id: assetIds[0] }) },
    );
    await expect(replay.json()).resolves.toEqual(firstPatchPayload);
    await expect(prisma.adminAuditLog.count({
      where: { actorId, action: "content.asset.update", targetId: assetIds[0] },
    })).resolves.toBe(1);

    const preflight = await preflightAssets(request(
      "POST",
      "/api/v2/admin/assets/bulk/preflight",
      { assetIds: [assetIds[1], assetIds[0], assetIds[0]] },
    ));
    await expect(preflight.json()).resolves.toEqual({
      ok: true,
      data: { assetIds, blockers: [] },
    });

    const bulkKey = `asset-v2-bulk-${suffix}`;
    const archived = await bulkPatchAssets(request(
      "POST",
      "/api/v2/admin/assets/bulk",
      {
        assetIds,
        status: "archived",
        reason: "archive assets after the authority preflight passed",
        confirmation: assetIds.join(","),
      },
      {
        "idempotency-key": bulkKey,
        "x-request-id": `asset-v2-bulk-request-${suffix}`,
      },
    ));
    await expect(archived.json()).resolves.toEqual({
      ok: true,
      data: { updatedIds: assetIds },
    });
    const rows = await prisma.mediaAsset.findMany({
      where: { id: { in: assetIds } },
      orderBy: { id: "asc" },
      select: { metadata: true },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.metadata).toMatchObject({
        platformAsset: { status: "archived" },
      });
    }
  });
});
