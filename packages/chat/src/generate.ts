// SPEC: chat.generate worker (design §3 steps 8-14). Build context → stream model
// tokens to Redis → output-moderate → IDEMPOTENT finalize TX (chat.* ledger +
// outbox) → append session.jsonl → enqueue memory.extract.
// INVARIANTS:
//   - idempotent on message.status: already sent/blocked/deleted ⇒ no-op (no double
//     usage, no duplicate selected version).
//   - finalize writes message + selected version + usage + summary + moderation +
//     outbox in ONE transaction (atomic ledger).
//   - session.jsonl append is the agent trace (separate fact; user-visible = PG).
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { providers } from "./providers.js";
import { buildContext, type BuiltContext } from "./context.js";
import { appendStreamEvent, streamKey } from "./stream.js";
import { appendLine, chatFsPaths } from "./chat-fs.js";
import { recordOutbox, scheduleOutboxDelivery } from "./outbox.js";
import { createId } from "./id.js";
import { enqueue } from "./queue.js";
import { companionRole } from "@idream/shared";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  idempotencyKeys,
} from "@idream/shared/contracts";

export interface GeneratePayload {
  sessionId: string;
  assistantMessageId: string;
  userMessageId: string;
  attempt: number;
}

export async function processGenerate(
  payload: GeneratePayload,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ status: "sent" | "blocked" | "skipped" | "failed" }> {
  const assistant = await prisma.message.findUnique({ where: { id: payload.assistantMessageId } });
  if (!assistant) return { status: "skipped" };
  // Idempotency: terminal states are final.
  if (["sent", "blocked", "deleted"].includes(assistant.status)) return { status: "skipped" };

  const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
  if (!session) return { status: "skipped" };

  await prisma.message.updateMany({
    where: { id: payload.assistantMessageId, status: { in: ["pending", "generating"] } },
    data: { status: "generating" },
  });

  const key = streamKey(payload.assistantMessageId);
  const context = await buildContext({
    prisma,
    userId: session.userId,
    characterId: session.characterId,
    sessionId: session.id,
    memoryEnabled: session.memoryEnabled,
  });

  await appendStreamEvent(key, { type: "start", attempt: payload.attempt });

  const modelMessages = buildModelMessages(context);
  const chunks: string[] = [];
  let seq = 0;
  try {
    for await (const chunk of providers.chat.stream({
      model: context.policy.model,
      characterName: context.persona.name,
      messages: modelMessages,
    })) {
      if (!chunk.delta) continue;
      seq += 1;
      chunks.push(chunk.delta);
      await appendStreamEvent(key, { type: "delta", attempt: payload.attempt, seq, delta: chunk.delta });
    }
  } catch (error) {
    await appendStreamEvent(key, {
      type: "error",
      attempt: payload.attempt,
      code: "provider_failed",
      retryable: seq === 0,
    });
    if (seq === 0) throw error instanceof Error ? error : new Error(String(error));
    return { status: "failed" };
  }

  let content = chunks.join("");
  if (!content.trim()) {
    const fallback = emptyAssistantReply(context.persona.name);
    seq += 1;
    chunks.push(fallback);
    content = fallback;
    await appendStreamEvent(key, { type: "delta", attempt: payload.attempt, seq, delta: fallback });
  }
  const model = context.policy.model;
  const usage = {
    promptTokens: estimateTokens(modelMessages.map((m) => m.content).join("\n")),
    completionTokens: estimateTokens(content),
  };

  // Output moderation (design §3 step 10).
  const moderation = await providers.moderation.check({ targetType: "text", content });
  const blocked = moderation.status === "blocked";

  await appendStreamEvent(key, { type: "done", attempt: payload.attempt, usage });

  await finalize({
    prisma,
    payload,
    session,
    content: blocked ? "" : content,
    model,
    usage,
    moderation,
    blocked,
    context,
  });

  // Agent trace (separate fact). Append-only; raw content kept here, PG holds the
  // user-visible version. Idempotent-ish: one append per attempt.
  // No-memory / incognito sessions write NO long-term agent trace (design P0-E):
  // the PG message history is the only record and is cleared with the session.
  if (session.memoryEnabled) {
    await appendLine(chatFsPaths.sessionLog(session.userId, session.id), JSON.stringify({
      ts: new Date().toISOString(),
      kind: "chat.turn",
      attempt: payload.attempt,
      assistantMessageId: payload.assistantMessageId,
      userMessageId: payload.userMessageId,
      system: modelMessages.find((m) => m.role === "system")?.content ?? "",
      injectedMemories: context.longTermMemories,
      boundaries: context.boundaries,
      rawOutput: content,
      moderation,
      model,
    }));
  }

  // Derive long-term memory off the hot path (reads jsonl + re-checks PG status).
  if (!blocked && session.memoryEnabled) {
    await enqueue({
      queue: CHAT_QUEUES.memoryExtract,
      payload: { sessionId: session.id, assistantMessageId: payload.assistantMessageId, attempt: payload.attempt },
      dedupeKey: idempotencyKeys.chatMemoryExtract(payload.assistantMessageId, payload.attempt),
    });
  }

  await scheduleOutboxDelivery();
  return { status: blocked ? "blocked" : "sent" };
}

interface FinalizeInput {
  prisma: ChatPrismaClient;
  payload: GeneratePayload;
  session: { id: string; userId: string; characterId: string };
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  moderation: { status: string; policyCode?: string; confidence: number };
  blocked: boolean;
  context: BuiltContext;
}

async function finalize(input: FinalizeInput): Promise<void> {
  const { prisma, payload, session, content, model, usage, moderation, blocked, context } = input;

  await prisma.$transaction(async (tx) => {
    // Re-read inside the TX for idempotency under concurrency.
    const current = await tx.message.findUnique({ where: { id: payload.assistantMessageId } });
    if (!current || ["sent", "blocked", "deleted"].includes(current.status)) return;

    const tokenCount = usage.completionTokens;
    await tx.message.update({
      where: { id: payload.assistantMessageId },
      data: {
        status: blocked ? "blocked" : "sent",
        content,
        model,
        tokenCount,
        safetyStatus: blocked ? "blocked" : moderation.status === "flagged" ? "flagged" : "passed",
      },
    });

    if (!blocked) {
      // flip previous selected off, add the new selected version
      await tx.messageVersion.updateMany({
        where: { messageId: payload.assistantMessageId, selected: true },
        data: { selected: false },
      });
      await tx.messageVersion.create({
        data: {
          id: createId("mv"),
          messageId: payload.assistantMessageId,
          content,
          model,
          selected: true,
          attempt: payload.attempt,
        },
      });

      // usage++ (period = UTC day; free quota is daily, design P0-C)
      const periodStart = startOfUtcDay();
      const periodEnd = startOfNextUtcDay();
      await tx.chatUsage.upsert({
        where: { userId_periodStart: { userId: session.userId, periodStart } },
        update: { messagesUsed: { increment: 1 } },
        create: {
          id: createId("usage"),
          userId: session.userId,
          sessionId: session.id,
          messagesUsed: 1,
          periodStart,
          periodEnd,
        },
      });

      // rolling session summary (PG authority)
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          memorySummary: buildSummary(context, content),
          lastMessageAt: new Date(),
        },
      });
    }

    // moderation trail (always)
    await tx.chatModerationEvent.create({
      data: {
        id: createId("mod"),
        targetType: "message",
        targetId: payload.assistantMessageId,
        layer: "output",
        status: moderation.status,
        policyCode: moderation.policyCode ?? null,
        confidence: moderation.confidence,
        details: {} as Prisma.InputJsonValue,
      },
    });

    // outbox (chat → main), atomic with the ledger
    if (blocked) {
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.messageBlocked,
        aggregateType: "message",
        aggregateId: payload.assistantMessageId,
        payload: { sessionId: session.id, userId: session.userId, policyCode: moderation.policyCode },
      });
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.safetyFlagged,
        aggregateType: "message",
        aggregateId: payload.assistantMessageId,
        payload: { sessionId: session.id, userId: session.userId, layer: "output", policyCode: moderation.policyCode },
      });
    } else {
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.messageCompleted,
        aggregateType: "message",
        aggregateId: payload.assistantMessageId,
        payload: { sessionId: session.id, userId: session.userId, characterId: session.characterId, model, tokenCount },
      });
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.usageIncremented,
        aggregateType: "user",
        aggregateId: session.userId,
        payload: { sessionId: session.id, delta: 1 },
      });
    }
  });
}

function emptyAssistantReply(characterName: string) {
  return `${characterName || "The character"} is here, but the last model reply came back empty. Please send that again.`;
}

function buildModelMessages(
  context: BuiltContext,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const persona = context.persona;
  const system = [
    `You are ${persona.name}, an adult ${companionRole(persona.relationship)} in a private companion chat.`,
    "Stay in persona; honor the user's stated preferences and boundaries; keep continuity.",
    "Do not claim to remember facts not present in the supplied context.",
    persona.systemPrompt ?? persona.description,
    context.sessionSummary ? `Session summary: ${context.sessionSummary}` : "",
    relationshipLine(context.relationship),
    context.boundaries.length ? `Boundaries (highest priority):\n${context.boundaries.map((b) => `- ${b}`).join("\n")}` : "",
    context.longTermMemories.length ? `Long-term memories:\n${context.longTermMemories.map((m) => `- ${m}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    ...context.recentMessages.map((m) => ({ role: m.role, content: m.content })),
  ];
}

// Qualitative relationship line for the system prompt (P1-B). Never numbers/scores
// — just tone + the narrative summary so replies reflect the bond's progression.
const STAGE_TONE: Record<string, string> = {
  new: "You have just met the user; be warm but still getting to know them.",
  familiar: "You and the user are becoming familiar; reference shared history naturally.",
  close: "You and the user are close; speak with comfortable intimacy and continuity.",
  committed: "You and the user share a deep, committed bond; speak with trust and devotion.",
};
function relationshipLine(relationship: BuiltContext["relationship"]): string {
  if (!relationship) return "";
  const tone = STAGE_TONE[relationship.stage] ?? STAGE_TONE.new;
  const summary = relationship.summary.trim();
  return `Relationship: ${tone}${summary ? `\nWhat you remember of the bond:\n${summary}` : ""}`;
}

function buildSummary(context: BuiltContext, assistantContent: string): string {
  const lastUser = [...context.recentMessages].reverse().find((m) => m.role === "user")?.content;
  const pieces = [
    context.sessionSummary,
    lastUser ? `User: ${lastUser}` : null,
    `Assistant: ${assistantContent}`,
  ].filter(Boolean);
  return clamp(pieces.join("\n"), 900);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function startOfNextUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
