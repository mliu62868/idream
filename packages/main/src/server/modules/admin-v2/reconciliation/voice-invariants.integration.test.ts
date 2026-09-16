import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { auditAdminCutoverInvariants } from "./invariants";

describe("Voice delivery and settlement invariants", () => {
  const prefix = `voice-invariant-${randomUUID()}`;
  const userIds: string[] = [];
  const characterIds: string[] = [];
  const asOf = new Date("2026-09-13T12:00:00Z");

  async function fixture(label: string, cost = 0) {
    const userId = `${prefix}-${label}`;
    const characterId = `${userId}-character`;
    const requestId = `${userId}-request`;
    const mediaId = `${userId}-media`;
    const messageId = `${userId}-message`;
    userIds.push(userId);
    characterIds.push(characterId);
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, dataClass: "fixture" } });
    await prisma.character.create({ data: {
      id: characterId, name: "Voice invariant fixture", age: 25,
      description: "Controlled reconciliation evidence", appearance: {}, advancedDetails: {},
    } });
    await prisma.mediaAsset.create({ data: {
      id: mediaId, ownerId: userId, characterId, type: "voice", url: "/fixture.wav",
      metadata: { requestId, messageId },
    } });
    await prisma.voiceClipRequest.create({ data: {
      id: requestId, userId, characterId, messageId, requestFingerprint: requestId,
      providerPayload: {}, status: "succeeded", attemptNo: 2, mediaAssetId: mediaId,
      completedAt: asOf,
    } });
    const usage = await prisma.voiceUsageFact.create({ data: {
      id: `${userId}-usage`, requestId, userId, characterId, attemptNo: 1,
      mediaAssetId: mediaId, durationMs: 1_000, costDreamcoins: cost, intent: "play",
    } });
    return { userId, characterId, requestId, mediaId, usage };
  }

  async function check(key: string) {
    const report = await auditAdminCutoverInvariants(prisma, asOf);
    const result = report.checks.find((entry) => entry.key === key);
    expect(result).toBeDefined();
    expect(result?.status).not.toBe("unavailable");
    return result!;
  }

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.$disconnect();
  });

  it("accepts historical delivery receipts, soft/hard media deletion and retryable failures", async () => {
    const restored = await fixture("restored");
    const deleted = await fixture("deleted");
    const failed = await fixture("failed");
    await prisma.mediaAsset.update({ where: { id: restored.mediaId }, data: { deletedAt: asOf } });
    await prisma.mediaAsset.delete({ where: { id: deleted.mediaId } });
    await prisma.voiceClipRequest.update({ where: { id: failed.requestId }, data: {
      status: "failed", mediaAssetId: null, errorCode: "provider_unavailable",
    } });
    for (const key of ["voice_succeeded_delivery_mismatch", "voice_usage_authority_mismatch", "voice_usage_debit_mismatch", "voice_request_requires_recovery"]) {
      const result = await check(key);
      for (const row of [restored, deleted, failed]) {
        expect(result.sampleIds).not.toContain(row.requestId);
        expect(result.sampleIds).not.toContain(row.usage.id);
      }
    }
  });

  it("reports a succeeded delivery pointing at another request's clip and missing receipts", async () => {
    const broken = await fixture("wrong-owner");
    const other = await fixture("other");
    const missing = await fixture("missing-receipt");
    await prisma.voiceClipRequest.update({ where: { id: broken.requestId }, data: { mediaAssetId: other.mediaId } });
    await prisma.voiceUsageFact.delete({ where: { id: missing.usage.id } });
    const foreignUsage = await prisma.voiceUsageFact.create({ data: {
      id: `${broken.requestId}-foreign-usage`, requestId: broken.requestId,
      userId: other.userId, characterId: other.characterId, attemptNo: 2,
      mediaAssetId: other.mediaId, durationMs: 0, costDreamcoins: 0, intent: "play",
    } });
    expect((await check("voice_usage_authority_mismatch")).sampleIds).toContain(foreignUsage.id);
    expect((await check("voice_succeeded_delivery_mismatch")).sampleIds).toEqual(
      expect.arrayContaining([broken.requestId, missing.requestId]),
    );
  });

  it("reconciles paid receipts and detects missing, wrong-amount and receiptless debits", async () => {
    const valid = await fixture("paid", 12);
    const missing = await fixture("missing-debit", 12);
    const wrong = await fixture("wrong-debit", 12);
    for (const row of [valid, wrong]) {
      await prisma.$transaction((tx) => postDreamcoinEntry(tx, {
        kind: "generation_spend", userId: row.userId,
        amount: row === valid ? 12 : 7, sourceId: row.mediaId,
        idempotencyKey: `voice:${row.requestId}:attempt:1:spend`,
      }));
    }
    const extra = await prisma.$transaction((tx) => postDreamcoinEntry(tx, {
      kind: "generation_spend", userId: valid.userId, amount: 4, sourceId: valid.mediaId,
      idempotencyKey: `voice:${valid.requestId}:attempt:2:spend`,
    }));
    const result = await check("voice_usage_debit_mismatch");
    expect(result.sampleIds).toEqual(expect.arrayContaining([missing.usage.id, wrong.usage.id, extra.id]));
    expect(result.sampleIds).not.toContain(valid.usage.id);
    expect(await prisma.generationSettlementLink.count({ where: { requestId: { in: [valid.mediaId, wrong.mediaId] } } })).toBe(0);
    // Hard deletion preserves the charge receipt; a null media FK must not
    // make its sourceId comparison claim that the debit is corrupt.
    await prisma.mediaAsset.delete({ where: { id: valid.mediaId } });
    expect((await check("voice_usage_debit_mismatch")).sampleIds).not.toContain(valid.usage.id);
    // Account erasure removes voice authority; leftover billing evidence must
    // not be reinterpreted as a missing voice usage receipt.
    await prisma.user.delete({ where: { id: valid.userId } });
    expect((await check("voice_usage_debit_mismatch")).sampleIds).not.toContain(extra.id);
  });

  it("exposes unknown outcomes and expired leases using the report observation time", async () => {
    const unknown = await fixture("unknown");
    const expired = await fixture("expired");
    const active = await fixture("active");
    await prisma.voiceClipRequest.update({ where: { id: unknown.requestId }, data: {
      status: "failed", errorCode: "provider_outcome_unknown", mediaAssetId: null,
    } });
    for (const row of [expired, active]) {
      await prisma.voiceClipRequest.update({ where: { id: row.requestId }, data: {
        status: "running", leaseOwner: "fixture", mediaAssetId: null,
        leaseExpiresAt: new Date(asOf.getTime() + (row === expired ? -1 : 60_000)),
      } });
    }
    const result = await check("voice_request_requires_recovery");
    expect(result.sampleIds).toEqual(expect.arrayContaining([unknown.requestId, expired.requestId]));
    expect(result.sampleIds).not.toContain(active.requestId);
  });
});
