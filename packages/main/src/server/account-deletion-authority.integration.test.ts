import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  CHAT_TO_MAIN_EVENTS,
  MAIN_TO_CHAT_EVENTS,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { hashPassword } from "@/server/lib/auth";
import {
  prismaPgSchema,
  prismaPgSearchPath,
} from "@/server/lib/prisma-adapter";
import {
  api,
  createUser,
  createCharacter,
  grantCoins,
  voiceReplyBody,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";
import {
  ACCOUNT_DELETION_GRACE_PERIOD_MS,
  accountDeletionSubjectHash,
  dispatchPendingAccountDeletionBlobDeletes,
  requestAccountDeletion,
} from "@/server/account-deletion-authority";
import {
  ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
  applyChatEvent,
} from "@/processes/event-consumer";
import type { BlobStore, VoiceClipPort, VoiceProviderKey } from "@/server/providers/types";
import { voiceArtifactKey } from "@/server/providers/voice/idempotency";
import { providers } from "@/server/providers";
import { reclaimExpiredVoiceClip } from "@/server/modules/ourdream/voice-clip";

const P = "zt-account-erasure-";
const PUBLISHED_QUALIFICATION_ID = `${P}published-qualification`;
const QUALIFICATION_DELETE_TRIGGER = "zt_account_erasure_qualification_no_delete";
const TEST_USER_IDS = [
  `${P}request-user`,
  `${P}chat-user`,
  `${P}legacy-forward-user`,
  `${P}no-blob-user`,
  `${P}published-user`,
  `${P}late-generation-user`,
  `${P}generation-race-user`,
  `${P}legal-hold-user`,
  `${P}terminal-user`,
  `${P}voice-user`,
  `${P}voice-operator`,
  `${P}voice-creator`,
  `${P}voice-orphan-failed`,
  `${P}voice-orphan-revoked`,
  `${P}voice-late-before-put`,
  `${P}voice-late-put-inflight`,
  `${P}voice-put-takeover`,
  `${P}voice-expired-running`,
];

async function purgeAccountDeletionTestData() {
  await prisma.accountDeletion.deleteMany({
    where: {
      OR: [
        { userId: { startsWith: P } },
        {
          subjectHash: {
            in: TEST_USER_IDS.map(accountDeletionSubjectHash),
          },
        },
      ],
    },
  });
  await purgeTestData(P);
}

async function installPublishedQualificationNoDeleteTrigger() {
  // Prisma db push cannot install hand-written migration triggers. Reproduce
  // the production deferred-delete invariant on this exact fixture so the
  // regression exercises transaction commit rather than a source-code mock.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${QUALIFICATION_DELETE_TRIGGER}()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'public catalog qualification cannot be deleted; revoke it instead';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW."releaseId" IS DISTINCT FROM OLD."releaseId"
        OR NEW."releaseSnapshotHash" IS DISTINCT FROM OLD."releaseSnapshotHash"
        OR NEW.kind IS DISTINCT FROM OLD.kind
        OR NEW."validationRunId" IS DISTINCT FROM OLD."validationRunId"
        OR NEW.evidence IS DISTINCT FROM OLD.evidence
        OR NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
        OR OLD."revokedAt" IS NOT NULL
        OR NEW."revokedAt" IS NULL
      THEN
        RAISE EXCEPTION
          'public catalog qualification is immutable except for one-way revocation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER ${QUALIFICATION_DELETE_TRIGGER}
    AFTER UPDATE OR DELETE ON public_catalog_qualifications
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.id = '${PUBLISHED_QUALIFICATION_ID}')
    EXECUTE FUNCTION ${QUALIFICATION_DELETE_TRIGGER}()
  `);
}

async function dropPublishedQualificationNoDeleteTrigger() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS ${QUALIFICATION_DELETE_TRIGGER}
    ON public_catalog_qualifications
  `);
  await prisma.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS ${QUALIFICATION_DELETE_TRIGGER}()
  `);
}

async function requestDeletionPastGrace(userId: string) {
  const requestedAt = new Date(
    Date.now() - ACCOUNT_DELETION_GRACE_PERIOD_MS - 10_000,
  );
  return prisma.$transaction((tx) => requestAccountDeletion(tx, {
    userId,
    now: requestedAt,
  }));
}

function chatCompletionPayload(userId: string, fileMutationId: string) {
  return {
    version: 2 as const,
    binding: "request_bound" as const,
    userId,
    fileMutationId,
    deletionRequestEventId: `user_deleted_${userId}`,
  };
}

beforeAll(async () => {
  await purgeAccountDeletionTestData();
});

afterAll(async () => {
  await purgeAccountDeletionTestData();
});

afterEach(async () => {
  await dropPublishedQualificationNoDeleteTrigger();
});

describe("account deletion authority", () => {
  it("revokes access immediately and durably waits through the erasure grace period", async () => {
    const user = await createUser({
      id: `${P}request-user`,
      email: `${P}request@example.com`,
      dataClass: "customer",
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        token: `${P}request-session`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.account.create({ data: { userId: user.id, providerId: "credential", accountId: user.email, password: hashPassword("Deletion-password-0905!") } });
    const requested = await api("POST", "account/delete-request", {
      userId: user.id,
      body: { password: "Deletion-password-0905!", confirmation: "DELETE", expectedUserId: user.id },
    });

    expectOk(requested);
    expect(requested.data).toMatchObject({
      requested: true,
      deletion: {
        status: "awaiting_chat",
        gracePeriodMs: ACCOUNT_DELETION_GRACE_PERIOD_MS,
        graceEndsAt: expect.any(String),
      },
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).resolves.toMatchObject({ status: "deleted", deletedAt: expect.any(Date) });
    await expect(
      prisma.session.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
    const deletion = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(deletion).toMatchObject({
      status: "awaiting_chat",
      requestedAt: expect.any(Date),
      graceEndsAt: new Date(
        deletion.requestedAt.getTime() + ACCOUNT_DELETION_GRACE_PERIOD_MS,
      ),
      completedAt: null,
    });
    await expect(
      prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: `user_deleted_${user.id}` },
      }),
    ).resolves.toMatchObject({
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      status: expect.stringMatching(/pending|delivered/),
      nextRunAt: deletion.graceEndsAt,
      payload: expect.objectContaining({
        eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
        schemaVersion: 2,
      }),
    });
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: {
        status: "delivered",
        deliveredAt: new Date(),
      },
    });
    await expect(applyChatEvent({
      eventId: `${P}premature-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(
        user.id,
        `${P}premature-file-mutation`,
      ),
    })).rejects.toThrow("before graceEndsAt");
    await expect(prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
    })).resolves.toMatchObject({
      status: "awaiting_chat",
      chatCompletionEventId: null,
    });
  });

  it("does not issue a credential session when deletion commits after login read", async () => {
    const email = `${P}login-race@example.com`;
    const password = "Fixture-pass-1004";
    const signup = await api("POST", "auth/signup", {
      body: { email, password, name: "Login deletion race" },
    });
    expectOk(signup);
    const userId = signup.data.user.id as string;
    const schema = prismaPgSchema(env.DATABASE_URL);
    const deletion = new pg.Client({
      connectionString: env.DATABASE_URL,
      ...(schema ? { options: prismaPgSearchPath(schema) } : {}),
    });
    await deletion.connect();
    try {
      await deletion.query("BEGIN");
      await deletion.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const login = api("POST", "auth/login", {
        body: { email, password },
      });
      await waitForAnotherTransactionBlockedOnLock(deletion);
      await deletion.query(
        `UPDATE users
         SET status = 'deleted', "deletedAt" = NOW(), "updatedAt" = NOW()
         WHERE id = $1`,
        [userId],
      );
      await deletion.query('DELETE FROM sessions WHERE "userId" = $1', [userId]);
      await deletion.query("COMMIT");

      expectError(await login, 403, "forbidden");
    } finally {
      await deletion.query("ROLLBACK").catch(() => undefined);
      await deletion.end();
    }
    await expect(prisma.session.count({ where: { userId } })).resolves.toBe(0);
  });

  it("accepts only the exact post-grace Chat completion and durably queues owned Blob deletion", async () => {
    const user = await createUser({
      id: `${P}chat-user`,
      email: `${P}chat@example.com`,
      dataClass: "customer",
    });
    const asset = await prisma.mediaAsset.create({
      data: {
        id: `${P}chat-asset`,
        ownerId: user.id,
        type: "image",
        url: `/user-content/${P}chat-asset/content.webp`,
        storageKey: `${P}chat-user/private.webp`,
        metadata: {},
      },
    });
    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
    // Dedicated completion is projected before Chat's HTTP response advances
    // the exact leased request transport from processing to delivered.
    data: {
      status: "processing",
      nextRunAt: now,
      leaseToken: `${P}chat-request-lease`,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
    },
    });

    await expect(applyChatEvent({
      eventId: `${P}legacy-chat-completion`,
      eventType: "chat.account_erasure.completed",
      aggregateId: user.id,
      payload: {
        userId: user.id,
        fileMutationId: `${P}legacy-file-mutation`,
      },
    })).resolves.toEqual({ status: "applied" });
    await expect(
      prisma.accountDeletion.findUniqueOrThrow({ where: { userId: user.id } }),
    ).resolves.toMatchObject({
      status: "awaiting_chat",
      chatCompletionEventId: null,
    });

    await expect(
      applyChatEvent({
        eventId: `${P}wrong-chat-completion`,
        eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
        schemaVersion: 2,
        sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
        aggregateId: `${P}wrong-user`,
        payload: chatCompletionPayload(user.id, `${P}file-mutation`),
      }),
    ).rejects.toThrow("aggregateId");
    await expect(
      prisma.accountDeletion.findUniqueOrThrow({ where: { userId: user.id } }),
    ).resolves.toMatchObject({ status: "awaiting_chat" });

    await expect(
      applyChatEvent({
        eventId: `${P}wrong-request-chat-completion`,
        eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
        schemaVersion: 2,
        sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
        aggregateId: user.id,
        payload: {
          ...chatCompletionPayload(user.id, `${P}wrong-request-file-mutation`),
          deletionRequestEventId: `${P}wrong-deletion-request`,
        },
      }),
    ).rejects.toThrow("request authority changed");

    const eventId = `${P}chat-completion`;
    // Simulate the rollback window where an older Main successfully consumed
    // the same source event through the generic projector but performed no v2
    // deletion effect. The dedicated namespace must still apply it.
    await prisma.inboundEventReceipt.create({
      data: {
        sourceService: "main.product_projection:chat",
        sourceEventId: eventId,
        payloadHash: `${P}legacy-generic-no-op-hash`,
        processingState: "processed",
        processedAt: new Date(),
      },
    });
    await expect(
      applyChatEvent({
        eventId,
        eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
        schemaVersion: 2,
        sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
        aggregateId: user.id,
        payload: chatCompletionPayload(user.id, `${P}file-mutation`),
      }),
    ).resolves.toEqual({ status: "applied" });
    await expect(prisma.inboundEventReceipt.findMany({
      where: { sourceEventId: eventId },
      orderBy: { sourceService: "asc" },
      select: { sourceService: true, processingState: true },
    })).resolves.toEqual([
      {
        sourceService: "main.product_projection:chat",
        processingState: "processed",
      },
      {
        sourceService: `main.product_projection:${ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE}`,
        processingState: "processed",
      },
    ]);

    await expect(
      prisma.accountDeletion.findUniqueOrThrow({ where: { userId: user.id } }),
    ).resolves.toMatchObject({
      status: "deleting_blobs",
      chatCompletionEventId: eventId,
      chatFileMutationId: `${P}file-mutation`,
      chatCompletedAt: expect.any(Date),
      blobExpectedCount: 1,
      blobDeletedCount: 0,
      completedAt: null,
    });
    await expect(
      prisma.accountDeletionBlobReceipt.findMany({
        where: { deletion: { userId: user.id } },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        storageKey: asset.storageKey,
        storageKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: "pending",
        attempts: 0,
        deletedAt: null,
      }),
    ]);
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.not.toBeNull();
    await expect(prisma.mediaAsset.findUnique({ where: { id: asset.id } })).resolves.not.toBeNull();
  });

  it("ACKs a forward v2 proof after a legacy binary already completed deletion", async () => {
    const user = await createUser({
      id: `${P}legacy-forward-user`,
      email: `${P}legacy-forward@example.com`,
      dataClass: "customer",
    });
    const requested = await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: now, nextRunAt: now },
    });
    await prisma.accountDeletion.update({
      where: { id: requested.id },
      data: {
        status: "finalizing",
        chatCompletionEventId: `${P}legacy-forward-completion`,
        chatFileMutationId: `${P}legacy-forward-mutation`,
        chatCompletedAt: now,
        version: { increment: 1 },
      },
    });
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      now,
      deletionIds: [requested.id],
    })).resolves.toMatchObject({ completed: 1 });

    await expect(applyChatEvent({
      eventId: `${P}forward-request-bound-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(user.id, `${P}forward-request-bound-mutation`),
    })).resolves.toEqual({ status: "applied" });
    await expect(prisma.accountDeletion.findUniqueOrThrow({
      where: { subjectHash: accountDeletionSubjectHash(user.id) },
    })).resolves.toMatchObject({
      status: "completed",
      userId: null,
      chatCompletionEventId: `${P}legacy-forward-completion`,
      chatFileMutationId: `${P}legacy-forward-mutation`,
    });

    await expect(applyChatEvent({
      eventId: `${P}wrong-forward-request-bound-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: {
        ...chatCompletionPayload(user.id, `${P}wrong-forward-mutation`),
        deletionRequestEventId: `${P}wrong-forward-request`,
      },
    })).rejects.toThrow("request authority changed");
  });

  it("waits for both historical voice providers and resumes only their unfinished erasure receipt", async () => {
    const user = await createUser({ id: `${P}voice-user`, dataClass: "customer" });
    const character = await createCharacter({ id: `${P}voice-character`, creatorId: user.id });
    for (const providerKey of ["pocket_tts", "fish_audio"]) {
      await prisma.voiceClipRequest.create({ data: {
        id: `${P}${providerKey}`, userId: user.id, characterId: character.id,
        messageId: `${P}${providerKey}-message`, requestFingerprint: "controlled-voice-request",
        providerPayload: { providerKey }, status: "failed", provider: providerKey,
      } });
    }
    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${user.id}` }, data: { status: "delivered", deliveredAt: now, nextRunAt: now } });
    await applyChatEvent({ eventId: `${P}voice-completion`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2, sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: user.id,
      payload: chatCompletionPayload(user.id, `${P}voice-file-mutation`) });
    const deletion = await prisma.accountDeletion.findUniqueOrThrow({ where: { userId: user.id } });
    const pocket = vi.fn<NonNullable<VoiceClipPort["eraseAccount"]>>().mockResolvedValue({ ok: true, data: { erased: true } });
    const fish = vi.fn<NonNullable<VoiceClipPort["eraseAccount"]>>()
      .mockResolvedValueOnce({ ok: false, error: { code: "voice_timeout", message: "Controlled gateway outage", retryable: true } })
      .mockResolvedValue({ ok: true, data: { erased: true } });
    const voice = (provider: VoiceProviderKey): VoiceClipPort => ({ providerKey: provider, synthesize: async () => { throw new Error("Erasure must not synthesize"); }, eraseAccount: provider === "pocket_tts" ? pocket : fish });
    const first = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], voice });
    expect.soft(first.completed).toBe(0);
    expect.soft(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect.soft(pocket).toHaveBeenCalledExactlyOnceWith({ subjectHash: accountDeletionSubjectHash(user.id), requestKeys: [`voice:${P}pocket_tts:provider`], voiceIds: [] });
    expect.soft(fish).toHaveBeenCalledExactlyOnceWith({ subjectHash: accountDeletionSubjectHash(user.id), requestKeys: [`voice:${P}fish_audio:provider`], voiceIds: [] });
    expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], voice })).completed).toBe(1);
    expect(pocket).toHaveBeenCalledTimes(1); expect(fish).toHaveBeenCalledTimes(2);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    const receipt = await prisma.accountDeletion.findUniqueOrThrow({ where: { id: deletion.id } });
    expect(receipt.voiceErasure).toMatchObject({ version: 1, providers: [
      { providerKey: "fish_audio", completedAt: expect.any(String), requestKeys: [], voiceIds: [] },
      { providerKey: "pocket_tts", completedAt: expect.any(String), requestKeys: [], voiceIds: [] },
    ] });
  });

  it("preserves platform voice profiles when their operator is erased and erases a private creator's aliases", async () => {
    const operator = await createUser({ id: `${P}voice-operator`, role: "admin", dataClass: "internal" });
    const creator = await createUser({ id: `${P}voice-creator`, dataClass: "customer" });
    const official = await createCharacter({ id: `${P}official-voice`, source: "official", creatorId: "seed-system-creator" });
    const personal = await createCharacter({ id: `${P}private-voice`, source: "user", creatorId: creator.id });
    for (const [character, ownerId] of [[official, "seed-system-creator"], [personal, creator.id]] as const) {
      const voiceId = `${character.id}-alias`, referenceId = `${character.id}-reference`;
      await prisma.mediaAsset.create({ data: { id: referenceId, ownerId, characterId: character.id, type: "voice", url: "blob:controlled-reference",
        storageKey: `voice-references/${character.id}/${voiceId}.json`, metadata: { purpose: "voice_preset_reference", providerVoiceId: voiceId, ownership: character.source === "official" ? "platform_official" : "user" } } });
      await prisma.characterVoiceProfile.create({ data: { id: `${character.id}-profile`, characterId: character.id, version: 1, provider: "pocket_tts", providerVoiceId: voiceId,
        model: "pocket-tts", language: "english", referenceAssetId: referenceId, sampleText: "Controlled profile", createdById: operator.id, status: "active" } });
    }
    const erase = vi.fn<NonNullable<VoiceClipPort["eraseAccount"]>>().mockResolvedValue({ ok: true, data: { erased: true } });
    const voice = (providerKey: VoiceProviderKey): VoiceClipPort => ({ providerKey, eraseAccount: erase, synthesize: async () => { throw new Error("Erasure must not synthesize"); } });
    for (const user of [operator, creator]) {
      const requested = await requestDeletionPastGrace(user.id), now = new Date();
      await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${user.id}` }, data: { status: "delivered", deliveredAt: now, nextRunAt: now } });
      await applyChatEvent({ eventId: `${user.id}-completion`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2, schemaVersion: 2,
        sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: user.id, payload: chatCompletionPayload(user.id, `${user.id}-file-mutation`) });
      expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], voice })).completed).toBe(1);
      expect(await prisma.characterVoiceProfile.findUnique({ where: { id: `${official.id}-profile` } })).not.toBeNull();
      expect(await prisma.mediaAsset.findUnique({ where: { id: `${official.id}-reference` } })).not.toBeNull();
      if (user.id === operator.id) expect(erase).not.toHaveBeenCalled();
    }
    expect(erase).toHaveBeenCalledExactlyOnceWith({ subjectHash: accountDeletionSubjectHash(creator.id), requestKeys: [], voiceIds: [`${personal.id}-alias`] });
    expect(await prisma.characterVoiceProfile.findUnique({ where: { id: `${personal.id}-profile` } })).toBeNull();
    expect(await prisma.mediaAsset.findUnique({ where: { id: `${personal.id}-reference` } })).toBeNull();
    await prisma.characterVoiceProfile.deleteMany({ where: { characterId: official.id } });
    await prisma.mediaAsset.deleteMany({ where: { characterId: official.id } });
    await prisma.character.delete({ where: { id: official.id } });
  });

  it("applies the actual voice ownership migration only to official dedicated copies", async () => {
    const operatorId = `${P}legacy-voice-operator`, characterId = `${P}legacy-official-voice`;
    await createUser({ id: operatorId, role: "admin", dataClass: "internal" });
    await createCharacter({ id: characterId, source: "official", creatorId: "seed-system-creator" });
    const dedicatedAlias = `${P}legacy-dedicated`, privateAlias = `${P}legacy-private-source`;
    const referenceId = `${P}legacy-reference`, previewId = `${P}legacy-preview`, privateId = `${P}private-upload`;
    await prisma.mediaAsset.createMany({ data: [
      { id: referenceId, ownerId: operatorId, characterId, type: "voice", url: "blob:reference", storageKey: `voice-references/${characterId}/${dedicatedAlias}.wav`, metadata: { purpose: "voice_clone_reference", providerVoiceId: dedicatedAlias } },
      { id: previewId, ownerId: operatorId, characterId, type: "voice", url: "blob:preview", storageKey: `voice-previews/${characterId}/${dedicatedAlias}.wav`, metadata: { purpose: "voice_clone_preview", providerVoiceId: dedicatedAlias } },
      // A user source pointed to by an official profile is still private. Its
      // loose association/purpose does not grant platform ownership.
      { id: privateId, ownerId: operatorId, characterId, type: "voice", url: "blob:private", storageKey: `user-uploads/${operatorId}/original.wav`, metadata: { purpose: "voice_clone_reference", providerVoiceId: privateAlias } },
    ] });
    await prisma.characterVoiceProfile.createMany({ data: [
      { id: `${P}legacy-dedicated-profile`, characterId, version: 1, provider: "pocket_tts", providerVoiceId: dedicatedAlias, model: "pocket-tts", language: "english", referenceAssetId: referenceId, previewAssetId: previewId, sampleText: "Dedicated platform copy", createdById: operatorId },
      { id: `${P}legacy-private-profile`, characterId, version: 2, provider: "pocket_tts", providerVoiceId: privateAlias, model: "pocket-tts", language: "english", referenceAssetId: privateId, sampleText: "Private source upload", createdById: operatorId },
    ] });
    const migration = await readFile(new URL("../../../../db/sql/2026-10-05-account-voice-erasure.sql", import.meta.url), "utf8");
    try {
      await prisma.$transaction(async tx => {
        for (const statement of migration.split(";").map(value => value.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
      });
      for (const id of [referenceId, previewId]) expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({ ownerId: "seed-system-creator", metadata: { ownership: "platform_official" } });
      expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: privateId } })).toMatchObject({ ownerId: operatorId });
    } finally {
      await prisma.characterVoiceProfile.deleteMany({ where: { characterId } });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: [referenceId, previewId, privateId] } } });
      await prisma.character.delete({ where: { id: characterId } });
      await prisma.user.delete({ where: { id: operatorId } });
    }
  });

  it.each(["failed", "revoked"])("keeps an account until its undelivered %s Voice WAV and MP3 bytes are actually deleted", async outcome => {
    const user = await createUser({ id: `${P}voice-orphan-${outcome}`, dataClass: "customer" });
    const character = await createCharacter({ id: `${user.id}-character`, creatorId: user.id });
    const requestId = `${user.id}-request`, providerKey = `voice:${requestId}:provider`;
    await prisma.voiceClipRequest.create({ data: { id: requestId, userId: user.id, characterId: character.id, messageId: `${user.id}-message`,
      requestFingerprint: "controlled-orphan-request", providerPayload: { providerKey: "mock" }, status: "failed",
      errorCode: outcome === "revoked" ? "voice_reply_delivery_revoked" : "voice_commit_failed" } });
    const waveKey = voiceArtifactKey(providerKey, ".wav"), mp3Key = voiceArtifactKey(providerKey, ".mp3");
    const stored = new Map([[waveKey, Uint8Array.from([82, 73, 70, 70, 1, 2, 3])], [mp3Key, Uint8Array.from([73, 68, 51, 4, 5, 6])]]);
    let failDelete = true;
    const blob: BlobStore = {
      putPrivate: async () => { throw new Error("Erasure must not upload"); },
      signGetUrl: async () => { throw new Error("Erasure must not publish"); },
      delete: async ({ key }) => {
        if (failDelete && key === waveKey) return { ok: false, error: { code: "controlled_delete_failure", message: "Controlled store outage", retryable: true } };
        stored.delete(key); return { ok: true, data: { deleted: true } };
      },
    };
    const requested = await requestDeletionPastGrace(user.id), chatAckAt = new Date();
    await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${user.id}` }, data: { status: "delivered", deliveredAt: chatAckAt, nextRunAt: chatAckAt } });
    await applyChatEvent({ eventId: `${user.id}-completion`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2, schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: user.id, payload: chatCompletionPayload(user.id, `${user.id}-file-mutation`) });
    // The ACK creates due Blob receipts; the worker tick must follow that write.
    const now = new Date();
    const first = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob, now });
    expect.soft(first).toMatchObject({ failed: 1, completed: 0 });
    expect.soft(stored.has(waveKey)).toBe(true); expect.soft(stored.has(mp3Key)).toBe(false);
    expect.soft(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect.soft(await prisma.accountDeletionBlobReceipt.count({ where: { deletionId: requested.id } })).toBe(5);
    failDelete = false;
    expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob, now: new Date(now.getTime() + 300_000) })).completed).toBe(1);
    expect(stored.size).toBe(0); expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it.each(["before-put", "put-inflight"])("blocks account erasure while a real Voice invocation is paused %s and refuses late delivery", async stage => {
    const userId = `${P}voice-late-${stage}`, characterId = `${userId}-character`;
    await createUser({ id: userId, dataClass: "customer" });
    await createCharacter({ id: characterId, creatorId: userId, visibility: "private" });
    await grantCoins(userId, 4, "voice-erasure-test");
    await prisma.entitlement.create({ data: { userId, key: "voice_enabled", value: true, source: "subscription" } });
    await prisma.featureFlag.upsert({ where: { key: "voice_gen" }, create: { key: "voice_gen", label: "Voice", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] }, update: { enabled: true, rolloutPercent: 100 } });
    const body = await voiceReplyBody(userId, { characterId, messageId: `${userId}-message`, text: "This private reply must not survive account erasure." });
    const stored = new Map<string, Uint8Array>();
    const remove = vi.fn(async ({ key }: { key: string }) => { stored.delete(key); return { ok: true as const, data: { deleted: true as const } }; });
    const blob: BlobStore = { putPrivate: async () => { throw new Error("Worker must not upload"); }, signGetUrl: async () => { throw new Error("Worker must not publish"); }, delete: remove };
    const erase = vi.fn<NonNullable<VoiceClipPort["eraseAccount"]>>().mockResolvedValue({ ok: true, data: { erased: true } });
    const voice = (providerKey: VoiceProviderKey): VoiceClipPort => ({ providerKey, eraseAccount: erase, synthesize: async () => { throw new Error("Worker must not synthesize"); } });
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const originalSynthesize = providers.voice.clip.synthesize.bind(providers.voice.clip);
    const synthesize = vi.spyOn(providers.voice.clip, "synthesize").mockImplementation(async input => {
      const result = await originalSynthesize(input);
      if (stage === "before-put") { ready(); await releasePromise; }
      return result;
    });
    const put = vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      stored.set(input.key, input.body);
      if (stage === "put-inflight") { ready(); await releasePromise; }
      return { ok: true, data: { key: input.key, size: input.body.byteLength } };
    });
    const compensation = vi.spyOn(providers.blob, "delete").mockImplementation(remove);
    const pending = api("POST", "generation/voice", { userId, ageGate: true, body });
    try {
      await Promise.race([readyPromise, pending.then(() => { throw new Error("Voice did not reach the controlled pause"); })]);
      const requested = await requestDeletionPastGrace(userId), now = new Date();
      await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${userId}` }, data: { status: "delivered", deliveredAt: now, nextRunAt: now } });
      await applyChatEvent({ eventId: `${userId}-completion`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2, schemaVersion: 2,
        sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: userId, payload: chatCompletionPayload(userId, `${userId}-file-mutation`) });
      expect.soft((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob, voice })).completed).toBe(0);
      expect.soft(remove).not.toHaveBeenCalled(); expect.soft(erase).not.toHaveBeenCalled();
      expect.soft(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
      release();
      expect.soft((await pending).status).toBe(410);
      if (stage === "before-put") expect.soft(put).not.toHaveBeenCalled();
      expect.soft(await prisma.mediaAsset.count({ where: { ownerId: userId } })).toBe(0);
      expect.soft(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
      expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob, voice, now: new Date(now.getTime() + 300_000) })).completed).toBe(1);
      expect(stored.size).toBe(0);
    } finally { release(); await pending; synthesize.mockRestore(); put.mockRestore(); compensation.mockRestore(); }
  });

  it("waits for an old Voice PUT owner after takeover has already delivered a new owner", async () => {
    const userId = `${P}voice-put-takeover`, characterId = `${userId}-character`;
    await createUser({ id: userId, dataClass: "customer" });
    const character = await createCharacter({ id: characterId, creatorId: userId, visibility: "private" });
    await grantCoins(userId, 4, "voice-erasure-test");
    await prisma.entitlement.create({ data: { userId, key: "voice_enabled", value: true, source: "subscription" } });
    await prisma.featureFlag.upsert({ where: { key: "voice_gen" }, create: { key: "voice_gen", label: "Voice", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] }, update: { enabled: true, rolloutPercent: 100 } });
    const body = await voiceReplyBody(userId, { characterId, messageId: `${userId}-message`, text: "The old uploader must finish before erasure." });
    const stored = new Map<string, Uint8Array>();
    const remove = vi.fn(async ({ key }: { key: string }) => { stored.delete(key); return { ok: true as const, data: { deleted: true as const } }; });
    const blob: BlobStore = { putPrivate: async () => { throw new Error("Worker must not upload"); }, signGetUrl: async () => { throw new Error("Worker must not publish"); }, delete: remove };
    let ready!: () => void, release!: () => void, firstPut = true;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const put = vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      if (firstPut) { firstPut = false; ready(); await releasePromise; }
      stored.set(input.key, input.body);
      return { ok: true, data: { key: input.key, size: input.body.byteLength } };
    });
    const compensation = vi.spyOn(providers.blob, "delete").mockImplementation(remove);
    const pending = api("POST", "generation/voice", { userId, ageGate: true, body });
    try {
      await Promise.race([readyPromise, pending.then(() => { throw new Error("Voice did not reach the old PUT pause"); })]);
      const request = await prisma.voiceClipRequest.findFirstOrThrow({ where: { userId, messageId: body.messageId } });
      await prisma.voiceClipRequest.update({ where: { id: request.id }, data: { leaseExpiresAt: new Date(0) } });
      await expect(reclaimExpiredVoiceClip({ characterId, requestId: request.id, deps: {
        entitlementMap: async () => ({ voice_enabled: true, voice_minutes: 0 }),
        readableCharacter: async () => character,
      } })).resolves.toMatchObject({ status: "succeeded", attemptNo: 2 });
      const requested = await requestDeletionPastGrace(userId), chatAckAt = new Date();
      await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${userId}` }, data: { status: "delivered", deliveredAt: chatAckAt, nextRunAt: chatAckAt } });
      await applyChatEvent({ eventId: `${userId}-completion`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2, schemaVersion: 2,
        sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: userId, payload: chatCompletionPayload(userId, `${userId}-file-mutation`) });
      const now = new Date();
      expect.soft((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob })).completed).toBe(0);
      expect.soft(remove).not.toHaveBeenCalled();
      expect.soft(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
      release();
      expect.soft((await pending).status).toBe(409);
      expect.soft(await prisma.voiceClipRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: "succeeded", attemptNo: 2 });
      expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob, now: new Date(now.getTime() + 300_000) })).completed).toBe(1);
      expect(stored.size).toBe(0);
    } finally { release(); await pending; put.mockRestore(); compensation.mockRestore(); }
  });

  it("keeps expired running Voice authority pending without deleting bytes or invoking provider erasure", async () => {
    const user = await createUser({ id: `${P}voice-expired-running`, dataClass: "customer" });
    const character = await createCharacter({ id: `${user.id}-character`, creatorId: user.id });
    await prisma.voiceClipRequest.create({ data: { id: `${user.id}-request`, userId: user.id, characterId: character.id, messageId: `${user.id}-message`,
      requestFingerprint: "controlled-unknown-writer", providerPayload: { providerKey: "pocket_tts" }, status: "running", leaseExpiresAt: new Date(0) } });
    const requested = await requestDeletionPastGrace(user.id), now = new Date();
    await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${user.id}` }, data: { status: "delivered", deliveredAt: now, nextRunAt: now } });
    await applyChatEvent({ eventId: `${user.id}-completion`, eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2, schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE, aggregateId: user.id, payload: chatCompletionPayload(user.id, `${user.id}-file-mutation`) });
    const remove = vi.fn(async () => ({ ok: true as const, data: { deleted: true as const } }));
    const blob: BlobStore = { putPrivate: async () => { throw new Error("Worker must not upload"); }, signGetUrl: async () => { throw new Error("Worker must not publish"); }, delete: remove };
    const erase = vi.fn<NonNullable<VoiceClipPort["eraseAccount"]>>().mockResolvedValue({ ok: true, data: { erased: true } });
    expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [requested.id], blob, voice: providerKey => ({ providerKey, eraseAccount: erase, synthesize: async () => { throw new Error("Worker must not synthesize"); } }) })).completed).toBe(0);
    expect(remove).not.toHaveBeenCalled(); expect(erase).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it("finalizes a no-media account without requiring a Blob receipt to be touched", async () => {
    const user = await createUser({
      id: `${P}no-blob-user`,
      email: `${P}no-blob@example.com`,
      dataClass: "customer",
    });
    // FK-free companion memory authority keyed by the user id.
    await prisma.companionMemoryAuthority.create({
      data: { aggregateId: `${user.id}:${P}character`, version: BigInt(3) },
    });
    const otherAuthority = `${P}no-blob-user-other:${P}character`;
    await prisma.companionMemoryAuthority.create({ data: { aggregateId: otherAuthority } });
    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: now, nextRunAt: now },
    });
    await applyChatEvent({
      eventId: `${P}no-blob-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(
        user.id,
        `${P}no-blob-file-mutation`,
      ),
    });
    const deletion = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
      select: { id: true, status: true, blobExpectedCount: true },
    });
    expect(deletion).toMatchObject({ status: "finalizing", blobExpectedCount: 0 });

    await expect(dispatchPendingAccountDeletionBlobDeletes({
      now: new Date(now.getTime() + 1_000),
      deletionIds: [deletion.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 1 });
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
    await expect(prisma.accountDeletion.findUniqueOrThrow({
      where: { subjectHash: accountDeletionSubjectHash(user.id) },
    })).resolves.toMatchObject({
      status: "completed",
      blobExpectedCount: 0,
      blobDeletedCount: 0,
    });
    await expect(prisma.companionMemoryAuthority.count({
      where: { aggregateId: { startsWith: `${user.id}:` } },
    })).resolves.toBe(0);
    // A user id that merely extends this one is a different subject.
    await expect(prisma.companionMemoryAuthority.count({ where: { aggregateId: otherAuthority } })).resolves.toBe(1);
    await prisma.companionMemoryAuthority.delete({ where: { aggregateId: otherAuthority } });
  });

  it("completes deletion for an owner whose published Character has immutable qualification evidence", async () => {
    const userId = `${P}published-user`;
    const characterId = `${P}published-character`;
    const projectId = `${P}published-project`;
    const revisionId = `${P}published-revision`;
    const contentVersionId = `${P}published-content`;
    const releaseId = `${P}published-release`;
    const validationRunId = `${P}published-validation`;
    const qualificationId = PUBLISHED_QUALIFICATION_ID;
    const assetIds = ["avatar", "hero", "chat"].map(
      (slot) => `${P}published-${slot}`,
    );
    const user = await createUser({
      id: userId,
      email: `${P}published@example.com`,
      dataClass: "customer",
    });

    await prisma.$transaction(async (tx) => {
      await tx.character.create({
        data: {
          id: characterId,
          creatorId: user.id,
          source: "user",
          name: "Published private persona",
          age: 28,
          description: "published private description",
          appearance: {},
          advancedDetails: {},
          visibility: "public",
          status: "approved",
        },
      });
      await tx.mediaAsset.createMany({
        data: assetIds.map((id, index) => ({
          id,
          ownerId: user.id,
          characterId,
          type: "image",
          url: `https://assets.test.invalid/${id}.webp`,
          visibility: "public_pack",
          safetyStatus: "passed",
          metadata: { synthetic: false, slot: index },
        })),
      });
      await tx.characterContentVersion.create({
        data: {
          id: contentVersionId,
          characterId,
          version: 1,
          contentHash: `${P}published-content-hash`,
          personaSnapshot: { private: "persona" },
          openingSnapshot: { private: "opening" },
          appearanceSnapshot: { private: "appearance" },
          sourceType: "user",
          createdById: user.id,
        },
      });
      await tx.character.update({
        where: { id: characterId },
        data: {
          imageAssetId: assetIds[0],
          currentContentVersionId: contentVersionId,
        },
      });
      await tx.characterProject.create({
        data: {
          id: projectId,
          characterId,
          draftImageAssetId: assetIds[0],
          draftAssetPack: { private: "draft pack" },
          activeKey: `${P}published-active-key`,
        },
      });
      await tx.characterRevision.create({
        data: {
          id: revisionId,
          projectId,
          revision: 1,
          characterContentVersionId: contentVersionId,
          projectSnapshot: { private: "revision" },
          createdById: user.id,
        },
      });
      await tx.characterRelease.create({
        data: {
          id: releaseId,
          projectId,
          revisionId,
          characterContentVersionId: contentVersionId,
          generationProvenance: {
            schemaVersion: "character-release-generation-provenance-v2",
            policyVersion: "character-release-policy-v2",
            requiredReleaseRoute: {
              routeFingerprint: `${releaseId}:route`,
              matrixKey: "account-deletion-published-character",
              generationProfileKey: "account-deletion-profile",
              generationProfileVersion: 1,
              workflowKey: "account-deletion-workflow",
              workflowVersion: 1,
            },
            placements: assetIds.map((assetId, index) => ({
              slotKey: ["character_avatar", "character_hero", "character_chat"][index],
              assetId,
              provider: "pipeline",
            })),
          },
          releasePlacementManifest: {
            schemaVersion: 2,
            placements: assetIds.map((assetId, index) => {
              const slot = ["avatar", "hero", "chat"][index];
              return {
                slotKey: `character_${slot}`,
                assetId,
                slotVersion: 1,
                runId: `${releaseId}:${slot}:run`,
                itemId: `${releaseId}:${slot}:item`,
                reviewDecisionId: `${releaseId}:${slot}:decision`,
                generationJobId: `${releaseId}:${slot}:job`,
              };
            }),
          },
          snapshotHash: `${releaseId}:snapshot`,
          readiness: "ready",
          status: "published",
          publishedAt: new Date(),
        },
      });
      await tx.releaseValidationRun.create({
        data: {
          id: validationRunId,
          releaseId,
          snapshotHash: `${releaseId}:snapshot`,
          policyVersion: "character-release-policy-v2",
          result: "passed",
          finishedAt: new Date(),
        },
      });
      await tx.releaseCheckResult.create({
        data: {
          id: `${P}published-check`,
          validationRunId,
          checkKey: "published_character_fixture",
          result: "passed",
          evidence: { immutable: true },
        },
      });
      await tx.publicCatalogQualification.create({
        data: {
          id: qualificationId,
          releaseId,
          releaseSnapshotHash: `${releaseId}:snapshot`,
          kind: "generated_release",
          validationRunId,
          evidence: {
            schemaVersion: "public-catalog-qualification-v1",
            policyVersion: "character-release-policy-v2",
          },
        },
      });
      await tx.characterServing.create({
        data: {
          id: `${P}published-serving`,
          characterId,
          currentReleaseId: releaseId,
          state: "live",
        },
      });
    });

    await installPublishedQualificationNoDeleteTrigger();

    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: now, nextRunAt: now },
    });
    await applyChatEvent({
      eventId: `${P}published-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(user.id, `${P}published-file-mutation`),
    });
    const deletion = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
      select: { id: true },
    });

    await expect(dispatchPendingAccountDeletionBlobDeletes({
      now: new Date(now.getTime() + 1_000),
      deletionIds: [deletion.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 1 });

    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
    await expect(prisma.character.findUnique({ where: { id: characterId } })).resolves.toBeNull();
    await expect(prisma.mediaAsset.count({ where: { id: { in: assetIds } } })).resolves.toBe(0);
    await expect(prisma.characterContentVersion.findUnique({
      where: { id: contentVersionId },
    })).resolves.toBeNull();
    await expect(prisma.characterRevision.findUnique({
      where: { id: revisionId },
    })).resolves.toBeNull();
    await expect(prisma.characterServing.findUnique({
      where: { characterId },
    })).resolves.toBeNull();
    await expect(prisma.publicCatalogQualification.findUniqueOrThrow({
      where: { id: qualificationId },
    })).resolves.toMatchObject({
      releaseId,
      releaseSnapshotHash: `${releaseId}:snapshot`,
      kind: "generated_release",
      validationRunId,
      evidence: {
        schemaVersion: "public-catalog-qualification-v1",
        policyVersion: "character-release-policy-v2",
      },
      revokedAt: expect.any(Date),
    });
    await expect(prisma.characterRelease.findUniqueOrThrow({
      where: { id: releaseId },
    })).resolves.toMatchObject({
      projectId,
      revisionId,
      characterContentVersionId: contentVersionId,
      snapshotHash: `${releaseId}:snapshot`,
      status: "published",
    });
    await expect(prisma.releaseValidationRun.findUniqueOrThrow({
      where: { id: validationRunId },
    })).resolves.toMatchObject({ result: "passed" });
    await expect(prisma.releaseCheckResult.findUniqueOrThrow({
      where: { id: `${P}published-check` },
    })).resolves.toMatchObject({ evidence: { immutable: true } });
    await expect(prisma.characterProject.findUniqueOrThrow({
      where: { id: projectId },
    })).resolves.toMatchObject({
      characterId: expect.stringMatching(/^erased:[a-f0-9]{64}$/),
      draftImageAssetId: null,
      draftAssetPack: {},
      activeKey: null,
    });
  });

  it("retains held evidence and resumes erasure only after the legal hold is released", async () => {
    const user = await createUser({
      id: `${P}legal-hold-user`,
      email: `${P}legal-hold@example.com`,
      dataClass: "customer",
    });
    const storageKey = `${P}legal-hold-user/held.webp`;
    const asset = await prisma.mediaAsset.create({
      data: {
        id: `${P}legal-hold-asset`,
        ownerId: user.id,
        type: "image",
        url: `/user-content/${P}legal-hold-asset/content.webp`,
        storageKey,
        metadata: {},
      },
    });
    const hold = await prisma.legalHold.create({
      data: {
        id: `${P}legal-hold`,
        targetType: "media",
        targetId: asset.id,
        caseNumber: `${P}legal-case`,
        reason: "retain exact evidence until explicit release",
        approvedById: `${P}retained-admin`,
        createdById: `${P}retained-admin`,
      },
    });
    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: now, nextRunAt: now },
    });
    await applyChatEvent({
      eventId: `${P}legal-hold-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(user.id, `${P}legal-hold-file-mutation`),
    });

    const blocked = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(blocked).toMatchObject({
      status: "finalizing",
      blobExpectedCount: 0,
      lastError: expect.objectContaining({
        code: "account_deletion_active_legal_hold",
        legalHoldId: hold.id,
      }),
    });
    await expect(prisma.accountDeletionBlobReceipt.count({
      where: { deletionId: blocked.id },
    })).resolves.toBe(0);

    let deleteCalls = 0;
    const blob: BlobStore = {
      async putPrivate() { throw new Error("not used"); },
      async signGetUrl() { throw new Error("not used"); },
      async delete(input) {
        expect(input.key).toBe(storageKey);
        deleteCalls += 1;
        return { ok: true as const, data: { deleted: true as const } };
      },
    };
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now,
      deletionIds: [blocked.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 0 });
    expect(deleteCalls).toBe(0);
    await expect(prisma.mediaAsset.findUnique({ where: { id: asset.id } })).resolves.not.toBeNull();

    await prisma.legalHold.update({
      where: { id: hold.id },
      data: {
        status: "released",
        releasedById: `${P}retained-admin`,
        releasedAt: now,
      },
    });
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now: new Date(now.getTime() + 1_000),
      deletionIds: [blocked.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 0 });
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now: new Date(now.getTime() + 2_000),
      deletionIds: [blocked.id],
    })).resolves.toEqual({ deleted: 1, failed: 0, completed: 1 });
    expect(deleteCalls).toBe(1);
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
  });

  it("waits for Generation authority and captures a late suppressed provider Blob", async () => {
    const user = await createUser({
      id: `${P}late-generation-user`,
      email: `${P}late-generation@example.com`,
      dataClass: "customer",
    });
    const requestId = `${P}late-generation-request`;
    const attemptId = `${P}late-generation-attempt`;
    const lateStorageKey = `${P}late-generation/private.webp`;
    const terminalRecordKey = `gen/terminal-records/${attemptId}/terminal.json`;
    await prisma.generationJob.create({
      data: {
        id: requestId,
        userId: user.id,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "running",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: attemptId,
        requestId,
        attemptNo: 1,
        status: "running",
        startedAt: new Date(),
      },
    });
    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: now, nextRunAt: now },
    });
    await applyChatEvent({
      eventId: `${P}late-generation-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(
        user.id,
        `${P}late-generation-file-mutation`,
      ),
    });
    const deletion = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
      select: { id: true },
    });

    await expect(dispatchPendingAccountDeletionBlobDeletes({
      now,
      deletionIds: [deletion.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 0 });
    await expect(prisma.accountDeletion.findUniqueOrThrow({
      where: { id: deletion.id },
    })).resolves.toMatchObject({
      status: "finalizing",
      lastError: expect.objectContaining({
        code: "account_deletion_generation_authority_pending",
      }),
    });

    await prisma.generationJob.update({
      where: { id: requestId },
      data: { status: "cancelled", finishedAt: now },
    });
    await prisma.generationAttempt.update({
      where: { id: attemptId },
      data: {
        status: "cancelled",
        finishedAt: now,
        terminalRecordRef: terminalRecordKey,
      },
    });
    await prisma.generationJobEvent.create({
      data: {
        id: `${P}late-generation-event`,
        jobId: requestId,
        type: "late_artifact_archived",
        message: "late provider success suppressed",
        metadata: {
          recoveredSuccess: {
            kind: "generation.completed",
            assets: [{ key: lateStorageKey, contentType: "image/webp" }],
          },
        },
      },
    });
    const terminalOutboxId = `${P}late-generation-terminal-outbox`;
    await prisma.mainOutboxEvent.create({
      data: {
        id: terminalOutboxId,
        eventType: "generation.terminal_record.accepted.v1",
        aggregateType: "generation_attempt",
        aggregateId: attemptId,
        payload: {
          kind: "generation.completed",
          generationJobId: requestId,
          attemptId,
          terminalRecordRef: terminalRecordKey,
          assets: [{ key: lateStorageKey }],
        },
      },
    });

    await expect(dispatchPendingAccountDeletionBlobDeletes({
      now: new Date(now.getTime() + 1_000),
      deletionIds: [deletion.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 0 });
    await expect(prisma.accountDeletionBlobReceipt.findMany({
      where: { deletionId: deletion.id },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ storageKey: lateStorageKey, status: "pending" }),
      expect.objectContaining({ storageKey: terminalRecordKey, status: "pending" }),
    ]));

    const deletedKeys: string[] = [];
    const blob: BlobStore = {
      async putPrivate() {
        throw new Error("not used");
      },
      async signGetUrl() {
        throw new Error("not used");
      },
      async delete(input) {
        deletedKeys.push(input.key);
        return { ok: true as const, data: { deleted: true as const } };
      },
    };
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now: new Date(now.getTime() + 2_000),
      deletionIds: [deletion.id],
    })).resolves.toEqual({ deleted: 2, failed: 0, completed: 1 });
    expect(deletedKeys.sort()).toEqual([lateStorageKey, terminalRecordKey].sort());
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
    await expect(prisma.generationJob.findUnique({
      where: { id: requestId },
    })).resolves.toBeNull();
    await expect(prisma.mainOutboxEvent.findUnique({
      where: { id: terminalOutboxId },
    })).resolves.toBeNull();
  });

  it("serializes terminal purge against a concurrent Generation retry reservation", async () => {
    const user = await createUser({
      id: `${P}generation-race-user`,
      email: `${P}generation-race@example.com`,
      dataClass: "customer",
    });
    const requestId = `${P}generation-race-request`;
    const attemptId = `${P}generation-race-attempt`;
    await prisma.generationJob.create({
      data: {
        id: requestId,
        userId: user.id,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        finishedAt: new Date(),
      },
    });
    await requestDeletionPastGrace(user.id);
    const now = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: now, nextRunAt: now },
    });
    await applyChatEvent({
      eventId: `${P}generation-race-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(
        user.id,
        `${P}generation-race-file-mutation`,
      ),
    });
    const deletion = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
      select: { id: true },
    });
    const schema = prismaPgSchema(env.DATABASE_URL);
    const retry = new pg.Client({
      connectionString: env.DATABASE_URL,
      ...(schema ? { options: prismaPgSearchPath(schema) } : {}),
    });
    await retry.connect();
    try {
      await retry.query("BEGIN");
      await retry.query(
        'SELECT id FROM generation_jobs WHERE id = $1 FOR UPDATE',
        [requestId],
      );
      const finalizing = dispatchPendingAccountDeletionBlobDeletes({
        now: new Date(now.getTime() + 1_000),
        deletionIds: [deletion.id],
      });
      await waitForAnotherTransactionBlockedOnLock(retry);
      await retry.query(
        'UPDATE generation_jobs SET status = \'running\', "updatedAt" = NOW() WHERE id = $1',
        [requestId],
      );
      await retry.query(
        `INSERT INTO generation_attempts
          (id, "requestId", "attemptNo", status)
         VALUES ($1, $2, 1, 'running')`,
        [attemptId, requestId],
      );
      await retry.query("COMMIT");

      await expect(finalizing).resolves.toEqual({
        deleted: 0,
        failed: 0,
        completed: 0,
      });
    } finally {
      await retry.query("ROLLBACK").catch(() => undefined);
      await retry.end();
    }
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.not.toBeNull();
    await expect(prisma.generationAttempt.findUnique({
      where: { id: attemptId },
    })).resolves.toMatchObject({ status: "running" });
    await expect(prisma.accountDeletion.findUniqueOrThrow({
      where: { id: deletion.id },
    })).resolves.toMatchObject({
      status: "finalizing",
      lastError: expect.objectContaining({
        code: "account_deletion_generation_authority_pending",
      }),
    });
  });

  it("retries Blob deletion and completes only after hard-delete plus anonymous ledger archival", async () => {
    const user = await createUser({
      id: `${P}terminal-user`,
      email: `${P}terminal@example.com`,
      dataClass: "customer",
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { name: "Private deletion name", displayName: "Private display name" },
    });
    await prisma.account.create({
      data: {
        id: `${P}terminal-account`,
        userId: user.id,
        providerId: "credential",
        accountId: user.email,
        password: "private-password-hash",
      },
    });
    const character = await prisma.character.create({
      data: {
        id: `${P}terminal-character`,
        creatorId: user.id,
        name: "Private Character",
        age: 28,
        description: "private description",
        appearance: {},
        advancedDetails: {},
      },
    });
    const storageKey = `${P}terminal-user/private.webp`;
    const asset = await prisma.mediaAsset.create({
      data: {
        id: `${P}terminal-asset`,
        ownerId: user.id,
        characterId: character.id,
        type: "image",
        url: `/user-content/${P}terminal-asset/content.webp`,
        storageKey,
        metadata: {},
      },
    });
    await prisma.dreamcoinLedger.createMany({
      data: [
        {
          id: `${P}terminal-ledger-1`,
          userId: user.id,
          delta: 250,
          balanceAfter: 250,
          reason: "signup_bonus",
          sourceId: `${P}private-source-1`,
        },
        {
          id: `${P}terminal-ledger-2`,
          userId: user.id,
          delta: -8,
          balanceAfter: 242,
          reason: "generation_spend",
          sourceId: `${P}private-source-2`,
        },
      ],
    });
    await prisma.supportRequest.create({
      data: {
        id: `${P}terminal-support`,
        ticketId: `${P}terminal-ticket`,
        userId: user.id,
        category: "account",
        subject: "private support subject",
        description: "private support body",
      },
    });
    await prisma.analyticsEvent.create({
      data: {
        id: `${P}terminal-analytics`,
        userId: user.id,
        name: "private_event",
        props: { private: "value" },
      },
    });
    await prisma.legalHold.create({
      data: {
        id: `${P}terminal-hold`,
        targetType: "user",
        targetId: user.id,
        caseNumber: `${P}case-number`,
        reason: "required retained evidence",
        status: "released",
        approvedById: user.id,
        createdById: user.id,
        releasedById: user.id,
        releasedAt: new Date(),
      },
    });
    await prisma.adminAuditLog.createMany({
      data: [
        {
          id: `${P}terminal-audit-target`,
          actorId: `${P}retained-admin`,
          actorRole: "admin",
          action: "compliance.erase",
          targetType: "user",
          targetId: user.id,
          reason: "required retained account-erasure evidence",
        },
        {
          id: `${P}terminal-audit-actor`,
          actorId: user.id,
          actorRole: "admin",
          action: "character.reviewed",
          targetType: "character",
          targetId: character.id,
          reason: "required retained operator evidence",
        },
      ],
    });
    await prisma.contentReport.create({
      data: {
        id: `${P}terminal-report`,
        reporterId: user.id,
        targetType: "character",
        targetId: `${P}reported-character`,
        category: "other_prohibited_content",
        description: "retained report evidence",
      },
    });
    await requestDeletionPastGrace(user.id);
    const afterGrace = new Date();
    await prisma.mainOutboxEvent.update({
      where: { id: `user_deleted_${user.id}` },
      data: { status: "delivered", deliveredAt: afterGrace, nextRunAt: afterGrace },
    });
    const event = {
      eventId: `${P}terminal-chat-completion`,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      aggregateId: user.id,
      payload: chatCompletionPayload(user.id, `${P}terminal-file-mutation`),
    };
    await applyChatEvent(event);
    await expect(applyChatEvent(event)).resolves.toEqual({
      status: "duplicate",
      outcome: "applied",
    });
    const activeDeletion = await prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
      select: { id: true },
    });
    const firstDispatchAt = new Date(afterGrace.getTime() + 10_000);

    let deleteCalls = 0;
    const blob: BlobStore = {
      async putPrivate() {
        throw new Error("not used");
      },
      async signGetUrl() {
        throw new Error("not used");
      },
      async delete(input) {
        expect(input.key).toBe(storageKey);
        deleteCalls += 1;
        if (deleteCalls === 1) {
          return {
            ok: false as const,
            error: {
              code: "temporary_blob_failure",
              message: "temporary Blob outage",
              retryable: true,
            },
          };
        }
        return { ok: true as const, data: { deleted: true as const } };
      },
    };

    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now: firstDispatchAt,
      workerId: `${P}worker-1`,
      deletionIds: [activeDeletion.id],
    })).resolves.toEqual({ deleted: 0, failed: 1, completed: 0 });
    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.not.toBeNull();
    await expect(prisma.accountDeletion.findUniqueOrThrow({
      where: { userId: user.id },
    })).resolves.toMatchObject({
      status: "deleting_blobs",
      blobDeletedCount: 0,
      completedAt: null,
    });

    const retryAt = new Date(firstDispatchAt.getTime() + 5 * 60_000);
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now: retryAt,
      workerId: `${P}worker-2`,
      deletionIds: [activeDeletion.id],
    })).resolves.toEqual({ deleted: 1, failed: 0, completed: 1 });
    await expect(dispatchPendingAccountDeletionBlobDeletes({
      blob,
      now: new Date(retryAt.getTime() + 5 * 60_000),
      workerId: `${P}worker-3`,
      deletionIds: [activeDeletion.id],
    })).resolves.toEqual({ deleted: 0, failed: 0, completed: 0 });
    expect(deleteCalls).toBe(2);

    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
    await expect(prisma.account.findUnique({ where: { id: `${P}terminal-account` } })).resolves.toBeNull();
    await expect(prisma.character.findUnique({ where: { id: character.id } })).resolves.toBeNull();
    await expect(prisma.mediaAsset.findUnique({ where: { id: asset.id } })).resolves.toBeNull();
    await expect(prisma.supportRequest.findUnique({ where: { id: `${P}terminal-support` } })).resolves.toBeNull();
    await expect(prisma.analyticsEvent.findUnique({ where: { id: `${P}terminal-analytics` } })).resolves.toBeNull();
    await expect(prisma.dreamcoinLedger.count({ where: { userId: user.id } })).resolves.toBe(0);

    const terminal = await prisma.accountDeletion.findUniqueOrThrow({
      where: { subjectHash: accountDeletionSubjectHash(user.id) },
    });
    expect(terminal).toMatchObject({
      userId: null,
      status: "completed",
      mainPurgedAt: expect.any(Date),
      completedAt: expect.any(Date),
      blobExpectedCount: 1,
      blobDeletedCount: 1,
    });
    const erasedSubjectRef = `erased:${terminal.subjectHash}`;
    await expect(prisma.legalHold.findUnique({
      where: { id: `${P}terminal-hold` },
    })).resolves.toMatchObject({
      targetId: erasedSubjectRef,
      approvedById: erasedSubjectRef,
      createdById: erasedSubjectRef,
      releasedById: erasedSubjectRef,
      reason: "required retained evidence",
    });
    await expect(prisma.contentReport.findUnique({
      where: { id: `${P}terminal-report` },
    })).resolves.toMatchObject({
      reporterId: null,
      description: "retained report evidence",
    });
    await expect(prisma.adminAuditLog.findMany({
      where: { id: { in: [`${P}terminal-audit-target`, `${P}terminal-audit-actor`] } },
      orderBy: { id: "asc" },
    })).resolves.toEqual([
      expect.objectContaining({
        id: `${P}terminal-audit-actor`,
        actorId: erasedSubjectRef,
        targetType: "character",
        targetId: character.id,
        action: "character.reviewed",
      }),
      expect.objectContaining({
        id: `${P}terminal-audit-target`,
        actorId: `${P}retained-admin`,
        targetType: "user",
        targetId: erasedSubjectRef,
        action: "compliance.erase",
      }),
    ]);
    await expect(prisma.accountDeletionBlobReceipt.findMany({
      where: { deletionId: terminal.id },
    })).resolves.toEqual([
      expect.objectContaining({
        status: "deleted",
        storageKey: null,
        storageKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        deletedAt: expect.any(Date),
      }),
    ]);
    await expect(prisma.erasedDreamcoinLedgerEntry.findMany({
      where: { deletionId: terminal.id },
      orderBy: { occurredAt: "asc" },
    })).resolves.toEqual([
      expect.objectContaining({
        delta: 250,
        balanceAfter: 250,
        reason: "signup_bonus",
        sourceEntryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        delta: -8,
        balanceAfter: 242,
        reason: "generation_spend",
        sourceEntryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });
});

async function waitForAnotherTransactionBlockedOnLock(client: pg.Client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Account deletion finalizer did not reach the Generation lock");
}
