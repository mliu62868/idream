import { randomUUID } from "node:crypto";
import {
  COMPANION_MEMORY_PURGE_PATH,
  COMPANION_MEMORY_REBUILD_PREPARE_PATH,
  COMPANION_MEMORY_REBUILD_PROMOTE_PATH,
  companionMemoryPurgeRequestedV1PayloadSchema,
  companionMemoryProjectRequestedV1PayloadSchema,
  companionMemoryRebuildRequestedV1PayloadSchema,
  durableEventEnvelopeSchema,
  MAIN_TO_CHAT_EVENTS,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";
import {
  companionWorkspaceRebuildBudget,
  createCompanionWorkspaceRebuildStream,
  type CompanionWorkspaceRebuildFence,
  type CompanionWorkspaceRebuildMessage,
} from "@idream/shared/chat/companion-runtime";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

const DESTRUCTIVE_MEMORY_EVENT_TYPES = [
  MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
  MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
] as const;
const PAGE_SIZE = 200;

export function companionRelationshipAggregateId(userId: string, characterId: string): string {
  return `${userId}:${characterId}`;
}

export async function hasPendingCompanionMemoryMutation(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
): Promise<boolean> {
  const pending = await tx.mainOutboxEvent.findFirst({
    where: {
      eventType: { in: [...DESTRUCTIVE_MEMORY_EVENT_TYPES] },
      aggregateType: "chat_relationship",
      aggregateId: companionRelationshipAggregateId(userId, characterId),
      status: { in: ["pending", "processing"] },
    },
    select: { id: true },
  });
  return Boolean(pending);
}

export async function assertNoPendingCompanionMemoryRebuild(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
): Promise<void> {
  if (await hasPendingCompanionMemoryMutation(tx, userId, characterId)) {
    throw Errors.conflict("Companion memory is changing; retry shortly");
  }
}

export async function scheduleCompanionMemoryProjection(
  tx: Prisma.TransactionClient,
  input: { userId: string; characterId: string },
): Promise<string> {
  const aggregateId = companionRelationshipAggregateId(input.userId, input.characterId);
  // A pending full projection reads Main only when delivered, so it already
  // includes every newer accepted Turn and can safely coalesce them.
  const existing = await tx.mainOutboxEvent.findFirst({
    where: {
      eventType: MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
      aggregateType: "chat_relationship",
      aggregateId,
      status: "pending",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const authority = await tx.companionMemoryAuthority.upsert({
    where: { aggregateId },
    create: { aggregateId, version: BigInt(1) },
    update: { version: { increment: 1 } },
    select: { version: true },
  });
  const eventId = randomUUID();
  const envelope = durableEventEnvelopeSchema.parse({
    sourceService: "main",
    sourceEventId: eventId,
    eventType: MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: "chat_relationship",
    aggregateId,
    payload: {
      version: 1,
      userId: input.userId,
      characterId: input.characterId,
      claimToken: randomUUID(),
      authorityVersion: authority.version.toString(),
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      id: eventId,
      eventType: envelope.eventType,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      payload: toInputJson(envelope),
    },
  });
  return eventId;
}

export async function scheduleCompanionMemoryRebuild(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    characterId: string;
    purgeTurnIds?: readonly string[];
    purgeRunAttempts?: readonly { turnId: string; throughAttempt: number }[];
  },
): Promise<string> {
  const aggregateId = companionRelationshipAggregateId(input.userId, input.characterId);
  // INVARIANT: every destructive mutation carries its own exact purge fence.
  // A pending rebuild may already be processing and cannot be safely widened.
  await supersedePendingMemoryProjections(tx, aggregateId, "destructive_memory_rebuild");
  const authority = await tx.companionMemoryAuthority.upsert({
    where: { aggregateId },
    create: { aggregateId, version: BigInt(1) },
    update: { version: { increment: 1 } },
    select: { version: true },
  });
  const eventId = randomUUID();
  const envelope = durableEventEnvelopeSchema.parse({
    sourceService: "main",
    sourceEventId: eventId,
    eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: "chat_relationship",
    aggregateId,
    payload: {
      version: 1,
      userId: input.userId,
      characterId: input.characterId,
      claimToken: randomUUID(),
      authorityVersion: authority.version.toString(),
      purgeTurnIds: [...new Set(input.purgeTurnIds ?? [])],
      purgeRunAttempts: dedupeAttemptFences(input.purgeRunAttempts ?? []),
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      id: eventId,
      eventType: envelope.eventType,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      payload: toInputJson(envelope),
    },
  });
  return eventId;
}

export async function syncCompanionMemoryFromMain(
  event: DurableEventEnvelope,
): Promise<void> {
  const payload = memoryRebuildPayload(event);
  if (
    (event.eventType !== MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1
      && event.eventType !== MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1) ||
    event.aggregateType !== "chat_relationship" ||
    event.aggregateId !== companionRelationshipAggregateId(payload.userId, payload.characterId)
  ) {
    throw new Error("companion memory sync event identity is invalid");
  }
  for (const turnId of payload.purgeTurnIds) {
    await purgeAgentRun(turnId);
  }
  for (const fence of payload.purgeRunAttempts) {
    await purgeAgentRun(fence.turnId, fence.throughAttempt);
  }

  const metrics = await memorySourceMetrics(payload.userId, payload.characterId);
  const fence: CompanionWorkspaceRebuildFence = {
    mutationId: event.sourceEventId,
    claimToken: payload.claimToken,
    authorityVersion: payload.authorityVersion,
  };
  const preparedResponse = await fetch(chatUrl(COMPANION_MEMORY_REBUILD_PREPARE_PATH), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-ndjson",
      "x-internal-token": env.INTERNAL_TOKEN,
    },
    body: createCompanionWorkspaceRebuildStream({
      scope: "relationship",
      userId: payload.userId,
      characterId: payload.characterId,
      mode: event.eventType === MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1
        ? "project"
        : "rebuild",
      fence,
      messageCount: metrics.messageCount,
      messages: memorySourceMessages(payload.userId, payload.characterId),
    }),
    duplex: "half",
    signal: AbortSignal.timeout(companionWorkspaceRebuildBudget(metrics).totalTimeoutMs),
  } as RequestInit & { duplex: "half" });
  if (!preparedResponse.ok) {
    throw new Error(`companion memory rebuild prepare returned ${preparedResponse.status}`);
  }
  const prepared = await preparedResponse.json() as {
    ok?: unknown;
    rebuilt?: { rebuildId?: unknown };
  };
  const rebuildId = prepared.ok === true && typeof prepared.rebuilt?.rebuildId === "string"
    ? prepared.rebuilt.rebuildId
    : null;
  if (!rebuildId) throw new Error("companion memory rebuild prepare returned invalid evidence");

  // The user lock is the final Main authority fence. It serializes promotion
  // with clear-memory, new Turns, and every destructive relationship mutation.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${payload.userId} FOR UPDATE`;
    const current = await tx.mainOutboxEvent.findUnique({
      where: { id: event.sourceEventId },
      select: { status: true },
    });
    if (!current || !["pending", "processing"].includes(current.status)) return;
    const response = await fetch(chatUrl(COMPANION_MEMORY_REBUILD_PROMOTE_PATH), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": env.INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        scope: "relationship",
        userId: payload.userId,
        characterId: payload.characterId,
        rebuildId,
        fence,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`companion memory rebuild promote returned ${response.status}`);
    }
    const promoted = await response.json() as { ok?: unknown; rebuilt?: unknown };
    if (promoted.ok !== true || !promoted.rebuilt || typeof promoted.rebuilt !== "object") {
      throw new Error("companion memory rebuild promote returned invalid evidence");
    }
  }, { timeout: 20_000 });
}

export async function purgeCompanionMemoryFromMain(event: DurableEventEnvelope): Promise<void> {
  const parsed = companionMemoryPurgeRequestedV1PayloadSchema.safeParse(event.payload);
  if (
    event.eventType !== MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1 ||
    !parsed.success ||
    event.aggregateType !== "chat_relationship" ||
    event.aggregateId !== companionRelationshipAggregateId(
      parsed.success ? parsed.data.userId : "",
      parsed.success ? parsed.data.characterId : "",
    )
  ) {
    throw new Error("companion memory purge event identity is invalid");
  }
  const response = await fetch(chatUrl(COMPANION_MEMORY_PURGE_PATH), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      scope: "relationship",
      userId: parsed.data.userId,
      characterId: parsed.data.characterId,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`companion memory purge returned ${response.status}`);
  const result = await response.json() as { ok?: unknown; purged?: unknown };
  if (result.ok !== true || !Number.isSafeInteger(result.purged) || Number(result.purged) < 0) {
    throw new Error("companion memory purge returned invalid evidence");
  }
}

export async function clearCompanionMemory(userId: string, characterId: string) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const sessions = await tx.recentChat.findMany({
      where: { userId, characterId },
      select: { sessionId: true },
    });
    if (sessions.length === 0) throw Errors.notFound("Chat relationship not found");
    // Clear includes explicitly pinned facts. Saved interaction preferences are
    // settings, remain visible, and can be removed separately in the same panel.
    await tx.chatContextDirective.updateMany({
      where: { userId, characterId, kind: "pinned_memory", status: "active" },
      data: { status: "archived", content: "", version: { increment: 1 } },
    });
    const sessionIds = sessions.map((session) => session.sessionId);
    const active = await tx.chatTurn.findMany({
      where: {
        sessionId: { in: sessionIds },
        assistantStatus: { in: ["pending", "generating"] },
      },
      select: { id: true, attempt: true },
    });
    const now = new Date();
    await tx.chatTurn.updateMany({
      where: { id: { in: active.map((turn) => turn.id) } },
      data: {
        assistantStatus: "cancelled",
        terminalAt: now,
        terminalEvidence: { authority: "main_memory_clear" },
        admissionLeaseToken: null,
        admissionLeaseUntil: null,
      },
    });
    // Turn.memoryEnabled is the immutable projection pin used by every later
    // canonical rebuild. Clearing only the mutable Session flag would let a
    // late rebuild resurrect the archived transcript.
    await tx.chatTurn.updateMany({
      where: { sessionId: { in: sessionIds }, memoryEnabled: true },
      data: { memoryEnabled: false },
    });
    await tx.recentChat.updateMany({
      where: { sessionId: { in: sessionIds } },
      data: {
        status: "archived",
        activeKey: null,
        memoryEnabled: false,
        contextRevision: { increment: 1 },
      },
    });
    const aggregateId = companionRelationshipAggregateId(userId, characterId);
    await supersedePendingMemoryProjections(tx, aggregateId, "durable_memory_purge");
    await tx.mainOutboxEvent.updateMany({
      where: {
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
        aggregateType: "chat_relationship",
        aggregateId,
        status: { in: ["pending", "processing"] },
      },
      data: {
        status: "delivered",
        deliveredAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: { supersededBy: "durable_memory_purge" },
      },
    });
    const existingPurge = await tx.mainOutboxEvent.findFirst({
      where: {
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
        aggregateType: "chat_relationship",
        aggregateId,
        status: { in: ["pending", "processing"] },
      },
      select: { id: true },
    });
    const eventId = existingPurge?.id ?? randomUUID();
    if (!existingPurge) {
      const envelope = durableEventEnvelopeSchema.parse({
        sourceService: "main",
        sourceEventId: eventId,
        eventType: MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
        schemaVersion: 1,
        occurredAt: now.toISOString(),
        aggregateType: "chat_relationship",
        aggregateId,
        payload: { version: 1, userId, characterId },
      });
      await tx.mainOutboxEvent.create({
        data: {
          id: eventId,
          eventType: envelope.eventType,
          aggregateType: envelope.aggregateType,
          aggregateId: envelope.aggregateId,
          payload: toInputJson(envelope),
        },
      });
    }
    return { active, eventId };
  });

  await Promise.allSettled(result.active.map((turn) => fetch(
    chatUrl(`/internal/agent-runs/${encodeURIComponent(turn.id)}/${turn.attempt}/cancel`),
    { method: "POST", headers: { "x-internal-token": env.INTERNAL_TOKEN } },
  )));
  return {
    ok: true as const,
    archived: true as const,
    purgeQueued: true as const,
    eventId: result.eventId,
  };
}

async function memorySourceMetrics(userId: string, characterId: string): Promise<{
  messageCount: number;
  sessionCount: number;
  estimatedBytes: number;
}> {
  const rows = await prisma.$queryRaw<Array<{
    turnCount: bigint;
    sessionCount: bigint;
    contentChars: bigint;
  }>>`
    SELECT
      COUNT(*)::bigint AS "turnCount",
      COUNT(DISTINCT turn."sessionId")::bigint AS "sessionCount",
      COALESCE(SUM(
        char_length(turn."userContent") + char_length(turn."assistantContent")
      ), 0)::bigint AS "contentChars"
    FROM "chat_turns" AS turn
    JOIN "recent_chats" AS session ON session."sessionId" = turn."sessionId"
    WHERE session."userId" = ${userId}
      AND session."characterId" = ${characterId}
      AND turn."userStatus" = 'sent'
      AND turn."assistantStatus" = 'sent'
      AND turn."memoryEnabled" = true
  `;
  const row = rows[0] ?? {
    turnCount: BigInt(0),
    sessionCount: BigInt(0),
    contentChars: BigInt(0),
  };
  const messageCount = safeNumber(row.turnCount * BigInt(2));
  return {
    messageCount,
    sessionCount: safeNumber(row.sessionCount),
    estimatedBytes: safeNumber(
      row.contentChars * BigInt(6) + BigInt(messageCount) * BigInt(512),
    ),
  };
}

async function* memorySourceMessages(
  userId: string,
  characterId: string,
): AsyncGenerator<CompanionWorkspaceRebuildMessage> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.chatTurn.findMany({
      where: {
        session: { userId, characterId },
        userStatus: "sent",
        assistantStatus: "sent",
        memoryEnabled: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sessionId: true,
        userMessageId: true,
        assistantMessageId: true,
        userContent: true,
        assistantContent: true,
        createdAt: true,
        updatedAt: true,
        terminalAt: true,
      },
    });
    if (rows.length === 0) return;
    for (const turn of rows) {
      yield {
        id: turn.userMessageId,
        sessionId: turn.sessionId,
        role: "user",
        content: turn.userContent,
        createdAt: turn.createdAt.toISOString(),
      };
      yield {
        id: turn.assistantMessageId,
        sessionId: turn.sessionId,
        role: "assistant",
        content: turn.assistantContent,
        createdAt: (turn.terminalAt ?? turn.updatedAt).toISOString(),
      };
    }
    cursor = rows.at(-1)?.id;
    if (rows.length < PAGE_SIZE) return;
  }
}

async function purgeAgentRun(turnId: string, throughAttempt?: number): Promise<void> {
  const response = await fetch(chatUrl(
    `/internal/agent-runs/${encodeURIComponent(turnId)}/purge`,
  ), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_TOKEN,
    },
    body: throughAttempt ? JSON.stringify({ throughAttempt }) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`AgentRun purge returned ${response.status}`);
}

function chatUrl(path: string): string {
  if (!env.CHAT_SERVICE_URL) throw new Error("CHAT_SERVICE_URL is required");
  return `${env.CHAT_SERVICE_URL.replace(/\/$/u, "")}${path}`;
}

function memoryRebuildPayload(event: DurableEventEnvelope): {
  userId: string;
  characterId: string;
  claimToken: string;
  authorityVersion: string;
  purgeTurnIds: string[];
  purgeRunAttempts: Array<{ turnId: string; throughAttempt: number }>;
} {
  if (event.eventType === MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1) {
    const parsed = companionMemoryProjectRequestedV1PayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new Error("companion memory projection event payload is invalid");
    }
    return {
      ...parsed.data,
      purgeTurnIds: [],
      purgeRunAttempts: [],
    };
  }
  const parsed = companionMemoryRebuildRequestedV1PayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new Error("companion memory rebuild event payload is invalid");
  }
  return {
    ...parsed.data,
    purgeTurnIds: [...new Set(parsed.data.purgeTurnIds)],
    purgeRunAttempts: dedupeAttemptFences(parsed.data.purgeRunAttempts),
  };
}

async function supersedePendingMemoryProjections(
  tx: Prisma.TransactionClient,
  aggregateId: string,
  reason: string,
): Promise<void> {
  await tx.mainOutboxEvent.updateMany({
    where: {
      eventType: MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
      aggregateType: "chat_relationship",
      aggregateId,
      status: "pending",
    },
    data: {
      status: "delivered",
      deliveredAt: new Date(),
      lastError: { supersededBy: reason },
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

function dedupeAttemptFences(
  values: readonly { turnId: string; throughAttempt: number }[],
): Array<{ turnId: string; throughAttempt: number }> {
  const byTurn = new Map<string, number>();
  for (const value of values) {
    byTurn.set(value.turnId, Math.max(byTurn.get(value.turnId) ?? 0, value.throughAttempt));
  }
  return [...byTurn].map(([turnId, throughAttempt]) => ({ turnId, throughAttempt }));
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("companion memory rebuild metrics exceed safe integer range");
  }
  return Number(value);
}
