// P0-4 + P0-5 acceptance: inbox idempotency, reconcile convergence, maintain
// rolling/TTL, privacy deletion across PG + files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { consumeInbound, persistInboundEvent, reprocessPendingInbox } from "../src/inbox.js";
import { reconcile } from "../src/reconcile.js";
import { rollSessionLog, pruneExpiredSegments } from "../src/maintain.js";
import { deleteMessage, deleteSession, deleteAccount } from "../src/privacy.js";
import { appendLine, chatFsPaths, listPrefix } from "../src/chat-fs.js";
import { drainQueue, obliterate } from "../src/queue.js";
import { CHAT_QUEUES, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;
const USER = "u_rel";
const STARVATION_USER = "u_rel_memory_starvation";
const CHAR = "c_rel";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-rel-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "rel@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [STARVATION_USER, "rel-memory-starvation@test.dev"],
  );
  await acceptAgeGate(superPool, [USER, STARVATION_USER]);
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'Rel',24,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("inbox (P0-4 main→chat, idempotent)", () => {
  it("durably acknowledges an exact replay and quarantines a conflicting payload", async () => {
    const event = {
      sourceService: "main",
      sourceEventId: "rel_durable_evt_1",
      eventType: MAIN_TO_CHAT_EVENTS.entitlementUpdated,
      schemaVersion: 1,
      occurredAt: "2026-07-11T12:00:00.000Z",
      aggregateType: "user",
      aggregateId: USER,
      payload: { userId: USER, tier: "premium" },
    };
    expect(await persistInboundEvent(event, prisma)).toMatchObject({ acknowledged: true, status: "persisted" });
    const receipt = await prisma.chatInboxEvent.findUnique({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId: event.sourceEventId } },
    });
    expect(receipt).toMatchObject({
      sourceService: "main",
      sourceEventId: event.sourceEventId,
      status: "pending",
    });
    if (!receipt) throw new Error("durable receipt was not persisted");
    expect(receipt?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await persistInboundEvent(event, prisma)).toMatchObject({ acknowledged: true, status: "duplicate" });
    expect(await persistInboundEvent({ ...event, payload: { ...event.payload, tier: "free" } }, prisma))
      .toMatchObject({ acknowledged: false, status: "quarantined" });
    expect(await persistInboundEvent(event, prisma))
      .toMatchObject({ acknowledged: false, status: "quarantined" });
    const quarantined = await prisma.chatInboxEvent.findUnique({ where: { id: receipt.id } });
    expect(quarantined?.processedAt).toBeInstanceOf(Date);
  });

  it("character.removed archives active sessions; re-consume is a no-op", async () => {
    const s = await prisma.chatSession.create({
      data: { id: "rel_s1", userId: USER, characterId: CHAR, status: "active" },
    });
    const event = {
      eventId: "rel_evt_1",
      eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
      payload: { characterId: CHAR },
    };
    const first = await consumeInbound(event, prisma);
    expect(first.applied).toBe(true);
    expect((await prisma.chatSession.findUnique({ where: { id: s.id } }))?.status).toBe("archived");

    const second = await consumeInbound(event, prisma);
    expect(second.applied).toBe(false); // idempotent on eventId
  });

  it("atomically claims concurrent deliveries so only one worker applies the event", async () => {
    const event = {
      eventId: `rel_concurrent_${Date.now()}`,
      eventType: MAIN_TO_CHAT_EVENTS.entitlementUpdated,
      payload: { userId: USER, tier: "premium" },
    };

    const results = await Promise.all([
      consumeInbound(event, prisma),
      consumeInbound(event, prisma),
    ]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => !result.applied)).toHaveLength(1);
    expect(await prisma.chatInboxEvent.findUnique({ where: { id: `main:${event.eventId}` } }))
      .toMatchObject({ status: "consumed", attempts: 0 });
  });
});

describe("reconcile (P0-4 convergence)", () => {
  it("marks long-stuck generating messages failed", async () => {
    const s = await prisma.chatSession.create({
      data: { id: "rel_s2", userId: USER, characterId: CHAR, status: "active" },
    });
    await prisma.message.create({
      data: { id: "rel_m_stuck", sessionId: s.id, role: "assistant", status: "generating", attempt: 1 },
    });
    // force updatedAt into the past via raw SQL (chat_service can update chat.*)
    // chat.* timestamps are naive-UTC (match Prisma's DateTime); use UTC here too.
    await prisma.$executeRawUnsafe(
      `UPDATE chat.messages SET updated_at = timezone('utc', now()) - interval '10 minutes' WHERE id = 'rel_m_stuck'`,
    );
    const result = await reconcile(prisma);
    expect(result.failedStuck).toBeGreaterThanOrEqual(1);
    expect((await prisma.message.findUnique({ where: { id: "rel_m_stuck" } }))?.status).toBe("failed");
  });

  it("selects lagging enabled turns before LIMIT and excludes legacy unknown turns", async () => {
    const session = await prisma.chatSession.create({
      data: {
        id: "rel_memory_starvation_session",
        userId: STARVATION_USER,
        characterId: CHAR,
        status: "active",
      },
    });
    const source = await prisma.message.create({
      data: {
        id: "rel_memory_starvation_source",
        sessionId: session.id,
        role: "user",
        content: "remember this",
        status: "sent",
        safetyStatus: "passed",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const unknownSource = await prisma.message.create({
      data: {
        id: "rel_memory_starvation_unknown_source",
        sessionId: session.id,
        role: "user",
        content: "legacy unknown source",
        status: "sent",
        safetyStatus: "passed",
      },
    });
    await prisma.message.create({
      data: {
        id: "rel_memory_starvation_lagging",
        sessionId: session.id,
        role: "assistant",
        content: "lagging",
        status: "sent",
        safetyStatus: "passed",
        replyToMessageId: source.id,
        memoryAuthority: "enabled",
        memoryExtractedAttempt: 0,
        attempt: 1,
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
        updatedAt: new Date("2026-01-01T00:00:01.000Z"),
      },
    });
    await prisma.message.create({
      data: {
        id: "rel_memory_starvation_unknown",
        sessionId: session.id,
        role: "assistant",
        content: "unknown",
        status: "sent",
        safetyStatus: "passed",
        replyToMessageId: unknownSource.id,
        memoryExtractedAttempt: 0,
        attempt: 1,
      },
    });
    await prisma.message.createMany({
      data: Array.from({ length: 201 }, (_, index) => {
        const createdAt = new Date(
          Date.UTC(2026, 6, 18, 0, 0, index),
        );
        const userMessageId =
          `rel_memory_starvation_extracted_source_${index}`;
        return [
          {
            id: userMessageId,
            sessionId: session.id,
            role: "user",
            content: "already extracted source",
            status: "sent",
            safetyStatus: "passed",
            createdAt,
            updatedAt: createdAt,
          },
          {
            id: `rel_memory_starvation_extracted_${index}`,
            sessionId: session.id,
            role: "assistant",
            content: "already extracted",
            status: "sent",
            safetyStatus: "passed",
            replyToMessageId: userMessageId,
            memoryAuthority: "enabled",
            memoryExtractedAttempt: 1,
            attempt: 1,
            createdAt,
            updatedAt: createdAt,
          },
        ];
      }).flat(),
    });

    await obliterate(CHAT_QUEUES.memoryExtract);
    await reconcile(prisma);
    const scheduled: string[] = [];
    await drainQueue(CHAT_QUEUES.memoryExtract, async (job) => {
      scheduled.push((job.payload as { assistantMessageId: string }).assistantMessageId);
    }, 250);
    expect(scheduled).toContain("rel_memory_starvation_lagging");
    expect(scheduled).not.toContain("rel_memory_starvation_unknown");
    expect(scheduled.some((id) => id.startsWith("rel_memory_starvation_extracted_"))).toBe(false);
    await obliterate(CHAT_QUEUES.memoryExtract);
  });

  it("recovers a null-link turn from its exact send receipt", async () => {
    const sessionId = "rel_receipt_reconcile_session";
    const userMessageId = "rel_receipt_reconcile_user";
    const assistantMessageId = "rel_receipt_reconcile_assistant";
    await prisma.chatSession.create({
      data: {
        id: sessionId,
        userId: USER,
        characterId: CHAR,
        status: "active",
      },
    });
    await prisma.message.create({
      data: {
        id: userMessageId,
        sessionId,
        role: "user",
        content: "receipt-linked source",
        status: "sent",
        safetyStatus: "passed",
      },
    });
    await prisma.message.create({
      data: {
        id: assistantMessageId,
        sessionId,
        role: "assistant",
        content: "reply",
        status: "sent",
        safetyStatus: "passed",
        replyToMessageId: null,
        memoryAuthority: "enabled",
        memoryExtractedAttempt: 0,
      },
    });
    await prisma.chatSendReceipt.create({
      data: {
        id: "rel_receipt_reconcile_receipt",
        userId: USER,
        sessionId,
        idempotencyKey: "rel-receipt-reconcile",
        requestHash: "hash",
        userMessageId,
        assistantMessageId,
        responseStatus: "generating",
      },
    });

    await obliterate(CHAT_QUEUES.memoryExtract);
    const result = await reconcile(prisma);
    const scheduled: string[] = [];
    await drainQueue(CHAT_QUEUES.memoryExtract, async (job) => {
      scheduled.push(
        (job.payload as { assistantMessageId: string })
          .assistantMessageId,
      );
    }, 250);
    expect(result.unresolvedMemoryAuthorities).toBeGreaterThanOrEqual(0);
    expect(scheduled).toContain(assistantMessageId);
    await obliterate(CHAT_QUEUES.memoryExtract);
  });

  it("isolates a poisoned user while projecting later users", async () => {
    const poisonUser = "rel_poison_file_user";
    const healthyUser = "rel_healthy_file_user";
    const poisonPayload = JSON.stringify({
      kind: "memory_extract",
      sessionId: "missing_session",
      userMessageId: "missing_user",
      characterId: CHAR,
      turnKey: "missing_assistant",
      attempt: 1,
      summaryDelta: "must never project",
      candidates: [],
      maxStored: 0,
    });
    await prisma.$executeRaw`
      INSERT INTO chat.chat_file_mutations (
        id,
        user_id,
        kind,
        payload
      )
      VALUES (
        'rel_poison_file_intent',
        ${poisonUser},
        'memory_extract',
        ${poisonPayload}::jsonb
      )
    `;
    const healthyPayload = JSON.stringify({
      kind: "memory_delete",
      memoryId: "already_absent",
    });
    await prisma.$executeRaw`
      INSERT INTO chat.chat_file_mutations (
        id,
        user_id,
        kind,
        payload
      )
      VALUES (
        'rel_healthy_file_intent',
        ${healthyUser},
        'memory_delete',
        ${healthyPayload}::jsonb
      )
    `;

    const result = await reconcile(prisma);
    expect(result.fileProjectionErrors).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.chatFileMutation.findUnique({
        where: { id: "rel_healthy_file_intent" },
        select: { status: true },
      }),
    ).toEqual({ status: "applied" });
    expect(
      await prisma.chatFileMutation.findUnique({
        where: { id: "rel_poison_file_intent" },
        select: { status: true, attempts: true },
      }),
    ).toMatchObject({ status: "pending", attempts: 1 });
    await deleteAccount({ userId: poisonUser }, prisma);
  });
});

describe("maintain (P0-5 rolling/TTL)", () => {
  it("rolls the active jsonl when over the size threshold", async () => {
    const p = chatFsPaths.sessionLog(USER, "rel_roll");
    await appendLine(p, "x".repeat(2000));
    const rolled = await rollSessionLog(USER, "rel_roll", 100);
    expect(rolled).toBe(true);
    const files = await readdir(path.join(fsRoot, "sessions", USER));
    expect(files.some((f) => /^rel_roll\.\d+\.jsonl$/.test(f))).toBe(true);
  });

  it("prunes segments older than the TTL", async () => {
    const dir = path.join(fsRoot, "sessions", USER);
    await mkdir(dir, { recursive: true });
    const seg = path.join(dir, "rel_old.1.jsonl");
    await writeFile(seg, "old");
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(seg, old, old);
    const removed = await pruneExpiredSegments(180 * 24 * 60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

describe("privacy deletion (P0-5, PG + files)", () => {
  it("deleteSession removes messages + jsonl", async () => {
    const s = await prisma.chatSession.create({
      data: { id: "rel_del", userId: USER, characterId: CHAR, status: "active" },
    });
    await prisma.message.create({ data: { id: "rel_del_m", sessionId: s.id, role: "user", content: "hi", status: "sent" } });
    await prisma.message.create({
      data: {
        id: "rel_del_a",
        sessionId: s.id,
        role: "assistant",
        content: "hello",
        status: "sent",
        attempt: 2,
        replyToMessageId: "rel_del_m",
      },
    });
    await prisma.messageVersion.createMany({
      data: [
        { id: "rel_del_m_v1", messageId: "rel_del_m", content: "hi", attempt: 1 },
        { id: "rel_del_a_v1", messageId: "rel_del_a", content: "hello", attempt: 2 },
      ],
    });
    await prisma.messageAttachment.create({
      data: {
        id: "rel_del_att",
        sessionId: s.id,
        messageId: "rel_del_a",
        kind: "generated_image",
        status: "requesting",
        promptHint: "private session prompt",
      },
    });
    await prisma.chatOutboxEvent.createMany({
      data: [
        {
          id: "rel_del_img_pending",
          eventType: "chat.image.requested",
          aggregateType: "message_attachment",
          aggregateId: "rel_del_att",
          status: "pending",
          payload: {
            sessionId: s.id,
            messageId: "rel_del_a",
            promptHint: "private session prompt",
            conversationContext: "user: private session prompt",
          },
        },
        {
          id: "rel_del_img_delivered",
          eventType: "chat.image.requested",
          aggregateType: "message_attachment",
          aggregateId: "rel_del_att",
          status: "delivered",
          deliveredAt: new Date(),
          payload: {
            sessionId: s.id,
            messageId: "rel_del_a",
            promptHint: "private delivered prompt",
            conversationContext: "user: private delivered prompt",
          },
        },
      ],
    });
    await appendLine(chatFsPaths.sessionLog(USER, s.id), JSON.stringify({ k: 1 }));

    await deleteSession({ userId: USER, sessionId: s.id }, prisma);

    expect(await prisma.message.findUnique({ where: { id: "rel_del_m" } })).toBeNull();
    expect(await prisma.messageVersion.count({
      where: { messageId: { in: ["rel_del_m", "rel_del_a"] } },
    })).toBe(0);
    expect((await prisma.chatSession.findUnique({ where: { id: s.id } }))?.status).toBe("deleted");
    const files = await readdir(path.join(fsRoot, "sessions", USER)).catch(() => []);
    expect(files).not.toContain(`${s.id}.jsonl`);
    const correction = await prisma.chatOutboxEvent.findFirst({
      where: { eventType: "chat.exchange.corrected.v2", aggregateId: "rel_del_m" },
    });
    expect(correction?.payload).toMatchObject({ correctionType: "superseded", correctionRevision: 2 });
    expect(await prisma.chatOutboxEvent.findUnique({
      where: { id: "rel_del_img_pending" },
    })).toBeNull();
    expect(await prisma.chatOutboxEvent.findUnique({
      where: { id: "rel_del_img_delivered" },
    })).toMatchObject({
      status: "delivered",
      payload: {
        sessionId: s.id,
        messageId: "rel_del_a",
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          reason: "session_deleted",
        },
      },
    });
  });

  it.each(["user", "assistant"] as const)(
    "deleteMessage on the %s side scrubs the complete logical exchange",
    async (deletedRole) => {
    const suffix = deletedRole;
    const s = await prisma.chatSession.create({
      data: { id: `rel_delete_message_${suffix}`, userId: USER, characterId: CHAR, status: "active" },
    });
    await prisma.message.create({
      data: {
        id: `rel_delete_user_${suffix}`,
        sessionId: s.id,
        role: "user",
        content: "private user text",
        status: "sent",
      },
    });
    await prisma.message.create({
      data: {
        id: `rel_delete_assistant_${suffix}`,
        sessionId: s.id,
        role: "assistant",
        content: "private assistant text",
        status: "sent",
        attempt: 3,
        replyToMessageId: `rel_delete_user_${suffix}`,
      },
    });
    await prisma.messageVersion.createMany({
      data: [
        {
          id: `rel_delete_user_version_${suffix}`,
          messageId: `rel_delete_user_${suffix}`,
          content: "private old user text",
        },
        {
          id: `rel_delete_assistant_version_${suffix}`,
          messageId: `rel_delete_assistant_${suffix}`,
          content: "private old assistant text",
          attempt: 3,
        },
      ],
    });
    const attachmentId = `rel_delete_attachment_${suffix}`;
    await prisma.messageAttachment.create({
      data: {
        id: attachmentId,
        sessionId: s.id,
        messageId: `rel_delete_assistant_${suffix}`,
        kind: "generated_image",
        status: "requesting",
        promptHint: "private image hint",
      },
    });
    await prisma.chatOutboxEvent.createMany({
      data: [
        {
          id: `rel_delete_image_pending_${suffix}`,
          eventType: "chat.image.requested",
          aggregateType: "message_attachment",
          aggregateId: attachmentId,
          status: "pending",
          payload: {
            sessionId: s.id,
            messageId: `rel_delete_assistant_${suffix}`,
            promptHint: "private image hint",
            conversationContext: "user: private user text\nassistant: private assistant text",
          },
        },
        {
          id: `rel_delete_image_delivered_${suffix}`,
          eventType: "chat.image.requested",
          aggregateType: "message_attachment",
          aggregateId: attachmentId,
          status: "delivered",
          deliveredAt: new Date(),
          payload: {
            sessionId: s.id,
            messageId: `rel_delete_assistant_${suffix}`,
            promptHint: "private delivered hint",
            conversationContext: "user: private delivered context",
          },
        },
      ],
    });

    await deleteMessage({
      userId: USER,
      messageId:
        deletedRole === "user"
          ? `rel_delete_user_${suffix}`
          : `rel_delete_assistant_${suffix}`,
    }, prisma);

    const exchangeMessageIds = [
      `rel_delete_user_${suffix}`,
      `rel_delete_assistant_${suffix}`,
    ];
    expect(await prisma.message.findMany({
      where: { id: { in: exchangeMessageIds } },
      orderBy: { role: "asc" },
      select: { id: true, status: true, content: true, deletedAt: true },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `rel_delete_user_${suffix}`,
        status: "deleted",
        content: "",
        deletedAt: expect.any(Date),
      }),
      expect.objectContaining({
        id: `rel_delete_assistant_${suffix}`,
        status: "deleted",
        content: "",
        deletedAt: expect.any(Date),
      }),
    ]));
    expect(await prisma.messageVersion.count({
      where: { messageId: { in: exchangeMessageIds } },
    })).toBe(0);
    expect(await prisma.messageAttachment.findUnique({
      where: { id: attachmentId },
    })).toBeNull();
    expect(await prisma.chatOutboxEvent.findUnique({
      where: { id: `rel_delete_image_pending_${suffix}` },
    })).toBeNull();
    expect(await prisma.chatOutboxEvent.findUnique({
      where: { id: `rel_delete_image_delivered_${suffix}` },
    })).toMatchObject({
      status: "delivered",
      payload: {
        sessionId: s.id,
        messageId: `rel_delete_assistant_${suffix}`,
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          reason: "logical_exchange_deleted",
        },
      },
    });

    const correction = await prisma.chatOutboxEvent.findFirst({
      where: {
        eventType: "chat.exchange.corrected.v2",
        aggregateId: `rel_delete_user_${suffix}`,
      },
    });
    expect(correction?.payload).toMatchObject({
      correctionType: "deleted",
      correctionRevision: 3,
      sessionId: s.id,
      messageIds: expect.arrayContaining(exchangeMessageIds),
    });
  });

  it("deleteAccount wipes chat rows + both file prefixes + emits erasure", async () => {
    const u = "u_erase";
    await superPool.query(
      `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
      [u, "erase@test.dev"],
    );
    await acceptAgeGate(superPool, [u]);
    const s = await prisma.chatSession.create({ data: { id: "erase_s", userId: u, characterId: CHAR, status: "active" } });
    await prisma.message.create({ data: { id: "erase_m", sessionId: s.id, role: "user", content: "x", status: "sent" } });
    await appendLine(chatFsPaths.sessionLog(u, s.id), "{}");
    await writeFile(path.join(fsRoot, "mem", u, "global", "boundaries.md"), "b").catch(async () => {
      await mkdir(path.join(fsRoot, "mem", u, "global"), { recursive: true });
      await writeFile(path.join(fsRoot, "mem", u, "global", "boundaries.md"), "b");
    });

    await deleteAccount({ userId: u }, prisma);

    expect(await prisma.chatSession.findMany({ where: { userId: u } })).toEqual([]);
    expect(await listPrefix(["sessions", u])).toEqual([]);
    expect(await listPrefix(["mem", u])).toEqual([]);
    const erasure = await prisma.chatOutboxEvent.findFirst({
      where: { aggregateId: u, eventType: "chat.account_erasure.completed" },
    });
    expect(erasure).not.toBeNull();
  });
});
