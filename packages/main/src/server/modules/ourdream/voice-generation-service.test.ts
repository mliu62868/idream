import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-voicesvc-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

async function grantVoice(userId: string, minutes = 0) {
  await prisma.entitlement.create({
    data: { userId, key: "voice_enabled", value: true, source: "subscription" },
  });
  if (minutes > 0) {
    await prisma.entitlement.create({
      data: { userId, key: "voice_minutes", value: minutes, source: "subscription" },
    });
  }
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("voice generation service contract", () => {
  it("synthesizes on demand, charges once, and caches replays by message", async () => {
    const userId = `${P}play-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    const first = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-1`, sessionId: `${P}sess`, text: "Hello there" },
    });
    expectOk(first, 201);
    expect(typeof first.data.assetId).toBe("string");
    expect(first.data.contentUrl).toBe(`/api/v1/media/${first.data.assetId}/content`);
    expect(first.data.durationMs).toBeGreaterThan(0);
    expect(await dreamcoinBalance(userId)).toBe(98);

    // The clip is a real, fetchable artifact (mock persists a playable WAV) — not a
    // dangling key. This is the path that 404'd before the provider stored bytes.
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.data.assetId } });
    expect(asset.storageKey).toBeTruthy();
    const bytes = await readFile(resolveLocalBlobPath(asset.storageKey as string));
    expect(bytes.byteLength).toBeGreaterThan(44);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

    // Replay of the same message reuses the cached clip — no second charge.
    const second = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-1`, sessionId: `${P}sess`, text: "Hello there" },
    });
    expectOk(second, 200);
    expect(second.data.assetId).toBe(first.data.assetId);
    expect(await dreamcoinBalance(userId)).toBe(98);
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(1);
  });

  it("spends the plan voice-minute allowance before charging coins", async () => {
    const userId = `${P}allowance-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 30); // 30 minutes of free voice

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-allow`, text: "Within the free allowance" },
    });
    expectOk(res, 201);
    // Covered by the minute allowance → no Dreamcoins spent.
    expect(await dreamcoinBalance(userId)).toBe(100);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.data.assetId } });
    expect((asset.metadata as { costDreamcoins?: number }).costDreamcoins).toBe(0);
  });

  it("charges overflow when the remaining allowance cannot cover the new clip", async () => {
    const userId = `${P}allowance-overflow-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId, 0.01); // 600ms
    await prisma.mediaAsset.create({
      data: {
        id: `${P}used-voice`,
        ownerId: userId,
        type: "voice",
        url: `/api/v1/media/${P}used-voice/content`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { messageId: `${P}used-msg`, durationMs: 599 },
      },
    });

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-overflow`, text: "Hello" },
    });
    expectOk(res, 201);
    expect(await dreamcoinBalance(userId)).toBe(98);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: res.data.assetId } });
    expect((asset.metadata as { costDreamcoins?: number }).costDreamcoins).toBe(2);
  });

  it("is fully gated by the voice_gen feature flag (kill-switch)", async () => {
    const userId = `${P}flag-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await grantVoice(userId);

    await prisma.featureFlag.update({ where: { key: "voice_gen" }, data: { enabled: false } });
    try {
      const res = await api("POST", "generation/voice", {
        userId,
        ageGate: true,
        body: { characterId: CHAR, messageId: `${P}msg-flag`, text: "Should be blocked" },
      });
      expectError(res, 403, "forbidden");
      expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(0);
    } finally {
      await prisma.featureFlag.update({ where: { key: "voice_gen" }, data: { enabled: true } });
    }
  });

  it("requires the voice_enabled entitlement", async () => {
    const userId = `${P}nogate-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-2`, text: "No voice for you" },
    });
    expectError(res, 402, "payment_required");
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(0);
  });

  it("rejects when the wallet cannot cover the clip", async () => {
    const userId = `${P}broke-user`;
    await createUser({ id: userId });
    await grantVoice(userId);

    const res = await api("POST", "generation/voice", {
      userId,
      ageGate: true,
      body: { characterId: CHAR, messageId: `${P}msg-3`, text: "Too poor to talk" },
    });
    expectError(res, 402, "payment_required");
    expect(await prisma.mediaAsset.count({ where: { ownerId: userId, type: "voice" } })).toBe(0);
  });
});
