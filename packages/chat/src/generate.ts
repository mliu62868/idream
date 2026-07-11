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
import type { ChatToolCall, ModelMessage } from "./providers.js";
import { buildContext, type BuiltContext } from "./context.js";
import { appendStreamEvent, streamKey } from "./stream.js";
import { appendLine, chatFsPaths } from "./chat-fs.js";
import { recordOutbox, scheduleOutboxDelivery } from "./outbox.js";
import { createId } from "./id.js";
import { enqueue } from "./queue.js";
import { logger } from "./logger.js";
import {
  EDIT_LAST_IMAGE_TOOL,
  findAgentTool,
  GENERATE_IMAGE_ASYNC_TOOL,
  imageToolCaption,
  planAgentToolCall,
  registryChatTools,
  shouldPlanImageTool,
  type AgentToolCallPlan,
  type ImageAgentToolCall,
} from "./agent-tools.js";
import { buildCompanionSystemPrompt } from "./prompt.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  idempotencyKeys,
  type ChatImageRequestedPayload,
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
  if (["sent", "blocked", "deleted", "failed"].includes(assistant.status)) return { status: "skipped" };
  if (assistant.attempt !== payload.attempt) return { status: "skipped" };

  const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
  if (!session) return { status: "skipped" };
  if (session.status !== "active") {
    await failAssistant(prisma, payload.assistantMessageId);
    await appendStreamEvent(streamKey(payload.assistantMessageId), {
      type: "error",
      attempt: payload.attempt,
      code: "session_inactive",
      retryable: false,
    }).catch(() => {});
    return { status: "failed" };
  }

  await prisma.message.updateMany({
    where: { id: payload.assistantMessageId, status: { in: ["pending", "generating"] }, attempt: payload.attempt },
    data: { status: "generating", updatedAt: new Date() },
  });
  let lastHeartbeatAt = Date.now();
  const heartbeat = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < 30_000) return;
    lastHeartbeatAt = now;
    await prisma.message.updateMany({
      where: { id: payload.assistantMessageId, status: "generating", attempt: payload.attempt },
      data: { updatedAt: new Date(now) },
    });
  };

  const key = streamKey(payload.assistantMessageId);
  const context = await buildContext({
    prisma,
    userId: session.userId,
    characterId: session.characterId,
    sessionId: session.id,
    memoryEnabled: session.memoryEnabled,
    userMessageId: payload.userMessageId,
  });

  await appendStreamEvent(key, { type: "start", attempt: payload.attempt });

  const modelMessages = buildModelMessages(context);
  const chunks: string[] = [];
  let seq = 0;
  let imageToolCall: ImageAgentToolCall | null = null;
  // metadata.trigger for the attachment (finalize, below): "agent_fc" when the model's
  // native function call produced it, "agent_tool_call" for the legacy regex+planner path.
  let toolCallTrigger: "agent_fc" | "agent_tool_call" = "agent_tool_call";

  const fcEnabled = providers.chat.supportsTools === true && context.policy.imageToolEnabled;

  const streamDelta = async (delta: string): Promise<void> => {
    await heartbeat();
    seq += 1;
    chunks.push(delta);
    await appendStreamEvent(key, { type: "delta", attempt: payload.attempt, seq, delta });
  };

  const streamPlain = async (): Promise<void> => {
    for await (const part of providers.chat.stream({
      model: context.policy.model,
      characterName: context.persona.name,
      messages: modelMessages,
    })) {
      if (part.delta) await streamDelta(part.delta);
    }
  };

  const streamCaption = async (toolCall: ImageAgentToolCall): Promise<void> => {
    const reply = imageToolCaption(toolCall, context.persona.name);
    for (const piece of chunk(reply, 96)) await streamDelta(piece);
  };

  // FC follow-up call (behavior contract point 3): when a legal tool call left no
  // prose behind, ask the model for a short in-character line to accompany the photo.
  const streamToolFollowup = async (rawCall: ChatToolCall, toolCall: ImageAgentToolCall): Promise<void> => {
    const followupMessages: ModelMessage[] = [
      ...modelMessages,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: rawCall.id, type: "function", function: { name: rawCall.name, arguments: rawCall.arguments } }],
      },
      {
        role: "tool",
        tool_call_id: rawCall.id,
        content: JSON.stringify({
          status: "generating",
          note: "The photo is being generated and will be delivered shortly. Respond to the user now with a short in-character message accompanying the incoming photo.",
        }),
      },
    ];
    let reply = "";
    try {
      const completion = await providers.chat.complete({
        model: context.policy.model,
        messages: followupMessages,
        maxTokens: 300,
      });
      reply = completion.content.trim();
    } catch (error) {
      console.warn("chat agent tool follow-up complete() failed; falling back to caption", error);
    }
    if (!reply) reply = toolCall.arguments.caption?.trim() || imageToolCaption(toolCall, context.persona.name);
    for (const piece of chunk(reply, 96)) await streamDelta(piece);
  };

  // Legacy regex-gate + planner path (pre-FC behavior), used when FC is unavailable
  // and as the safety net when FC is available but the model didn't call the tool.
  const runPlannerFallback = async (): Promise<void> => {
    // policy.imageToolEnabled off (entitlement or character advancedDetails.imageToolEnabled=false)
    // suppresses the tool entirely — not just the FC path, so the legacy planner must not run either.
    if (!context.policy.imageToolEnabled) return;
    if (!shouldPlanImageTool(context)) return;
    try {
      const toolPlan = await planAgentToolCall({ chat: providers.chat, model: context.policy.model, context });
      imageToolCall = toolPlan.toolCall;
      toolCallTrigger = "agent_tool_call";
    } catch {
      imageToolCall = null;
    }
  };

  // Legal-tool-call validation shared by the FC path: unknown tool name or a JSON/schema
  // failure is dropped silently (contract point 2) — never thrown.
  const validateToolCall = (rawCall: ChatToolCall): AgentToolCallPlan | null => {
    const tool = findAgentTool(rawCall.name);
    if (!tool) {
      console.warn(`chat agent tool call references unknown tool "${rawCall.name}"; ignoring`);
      return null;
    }
    try {
      const plan = tool.parseCall(JSON.parse(rawCall.arguments) as unknown);
      if (!plan) {
        console.warn(`chat agent tool call "${rawCall.name}" failed args validation; ignoring`);
        return null;
      }
      return plan;
    } catch (error) {
      console.warn(`chat agent tool call "${rawCall.name}" has invalid JSON arguments; ignoring`, error);
      return null;
    }
  };

  try {
    if (fcEnabled) {
      let toolCalls: ChatToolCall[] = [];
      let fellBackAlready = false;
      try {
        for await (const part of providers.chat.stream({
          model: context.policy.model,
          characterName: context.persona.name,
          messages: modelMessages,
          tools: registryChatTools(),
        })) {
          if (part.toolCalls) toolCalls = part.toolCalls;
          if (part.delta) await streamDelta(part.delta);
        }
      } catch (streamError) {
        if (seq > 0) throw streamError;
        // The FC-enabled call died before any content streamed: fall back to the
        // full legacy path (contract point 5) rather than failing the turn.
        fellBackAlready = true;
        await runPlannerFallback();
        if (imageToolCall) await streamCaption(imageToolCall);
        else await streamPlain();
      }

      const rawCall = toolCalls[0];
      if (rawCall) {
        const plan = validateToolCall(rawCall);
        if (plan) {
          imageToolCall = toolCallFromPlan(plan);
          toolCallTrigger = "agent_fc";
          if (!chunks.join("").trim()) await streamToolFollowup(rawCall, imageToolCall);
        }
        // else: illegal call — ignore it, keep whatever prose already streamed, don't throw.
      } else if (!fellBackAlready) {
        // FC available but returned no tool call: the regex-gate + planner remains the
        // safety net so a missed FC call doesn't silently drop the image path.
        await runPlannerFallback();
        if (imageToolCall && !chunks.join("").trim()) await streamCaption(imageToolCall);
      }
    } else {
      await runPlannerFallback();
      if (imageToolCall) await streamCaption(imageToolCall);
      else await streamPlain();
    }
  } catch (error) {
    await appendStreamEvent(key, {
      type: "error",
      attempt: payload.attempt,
      code: "provider_failed",
      retryable: seq === 0,
    });
    if (seq === 0) throw error instanceof Error ? error : new Error(String(error));
    await failAssistant(prisma, payload.assistantMessageId);
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

  await heartbeat(true);
  const finalized = await finalize({
    prisma,
    payload,
    session,
    content: blocked ? "" : content,
    model,
    usage,
    moderation,
    blocked,
    context,
    imageToolCall,
    toolCallTrigger,
  });
  if (!finalized) return { status: "skipped" };

  await appendStreamEvent(key, { type: "done", attempt: payload.attempt, usage });

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
      toolCalls: imageToolCall ? [imageToolCall] : [],
      moderation,
      model,
    })).catch((error) => {
      // The PG ledger is already terminal. Trace persistence is diagnostic and
      // must not prevent memory scheduling or make BullMQ retry a completed turn.
      logger.error({ err: error, assistantMessageId: payload.assistantMessageId }, "agent trace append failed");
    });
  }

  // Derive long-term memory off the hot path (reads jsonl + re-checks PG status).
  if (!blocked && session.memoryEnabled) {
    await enqueue({
      queue: CHAT_QUEUES.memoryExtract,
      payload: {
        sessionId: session.id,
        assistantMessageId: payload.assistantMessageId,
        userMessageId: payload.userMessageId,
        attempt: payload.attempt,
      },
      dedupeKey: idempotencyKeys.chatMemoryExtract(payload.assistantMessageId, payload.attempt),
    }).catch((error) => {
      // Reconcile scans sent messages whose memory_extracted_attempt lags.
      logger.warn({ err: error, assistantMessageId: payload.assistantMessageId }, "memory extraction enqueue deferred");
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
  imageToolCall: ImageAgentToolCall | null;
  toolCallTrigger: "agent_fc" | "agent_tool_call";
}

async function finalize(input: FinalizeInput): Promise<boolean> {
  const { prisma, payload, session, content, model, usage, moderation, blocked, context, imageToolCall, toolCallTrigger } = input;

  return prisma.$transaction(async (tx) => {
    // Re-read inside the TX for idempotency under concurrency.
    const current = await tx.message.findUnique({ where: { id: payload.assistantMessageId } });
    if (!current || current.status !== "generating" || current.attempt !== payload.attempt) return false;

    const tokenCount = usage.completionTokens;
    const updated = await tx.message.updateMany({
      where: { id: payload.assistantMessageId, status: "generating", attempt: payload.attempt },
      data: {
        status: blocked ? "blocked" : "sent",
        content,
        model,
        tokenCount,
        safetyStatus: blocked ? "blocked" : moderation.status === "flagged" ? "flagged" : "passed",
      },
    });
    if (updated.count === 0) return false;

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
          ...(context.canUpdateSessionSummary ? { memorySummary: buildSummary(context, content) } : {}),
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

      // toolPlan re-derives the discriminated plan from imageToolCall so the outbox
      // construction below branches on plan.tool (extended by the edit_last_image arm).
      const toolPlan: AgentToolCallPlan | null = imageToolCall ? planFromToolCall(imageToolCall) : null;
      if (toolPlan) {
        const built = await buildImageRequestFromPlan(toolPlan, tx, session.id);
        const attachmentId = createId("att");
        await tx.messageAttachment.create({
          data: {
            id: attachmentId,
            sessionId: session.id,
            messageId: payload.assistantMessageId,
            kind: "generated_image",
            status: "requesting",
            promptHint: built.promptHint,
            metadata: {
              trigger: toolCallTrigger,
              toolName: built.toolName,
              sourceUserMessageId: payload.userMessageId,
              assistantCaption: built.assistantCaption,
              orientation: built.controls.orientation,
              outputCount: built.controls.outputCount,
              // P5 Task 2: carried so a later confirm/retry (service.ts confirmImageAttachment,
              // which re-emits from this metadata) still targets the same source photo.
              ...(built.controls.sourceImageAssetId ? { editSourceAssetId: built.controls.sourceImageAssetId } : {}),
            } as Prisma.InputJsonValue,
          },
        });
        const imagePayload: ChatImageRequestedPayload & Record<string, unknown> = {
          version: 1,
          kind: "chat.image.requested",
          requestId: createId("chat_img_req"),
          attachmentId,
          sessionId: session.id,
          messageId: payload.assistantMessageId,
          userId: session.userId,
          characterId: session.characterId,
          promptHint: built.promptHint,
          conversationContext: buildConversationContext(context, content),
          controls: built.controls,
          // Visual passport at request time. Read fresh from persona (not stored on the
          // attachment) so a retry after re-buildContext always carries the CURRENT
          // active profile rather than a value captured earlier in this turn.
          visualProfileId: context.persona.visualProfileId ?? undefined,
          visualProfileVersion: context.persona.visualProfileVersion ?? undefined,
        };
        await recordOutbox(tx, {
          eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
          aggregateType: "message_attachment",
          aggregateId: attachmentId,
          payload: imagePayload,
        });
      }
    }
    return true;
  });
}

async function failAssistant(prisma: ChatPrismaClient, assistantMessageId: string): Promise<void> {
  await prisma.message.updateMany({
    where: { id: assistantMessageId, status: { in: ["pending", "generating"] } },
    data: { status: "failed" },
  });
}

function emptyAssistantReply(characterName: string) {
  return `${characterName || "The character"} is here, but the last model reply came back empty. Please send that again.`;
}

function buildModelMessages(
  context: BuiltContext,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const system = buildCompanionSystemPrompt(context);

  return [
    { role: "system", content: system },
    ...context.recentMessages.map((m) => ({
      role: m.role,
      // P4 Task 5: photo awareness — reminds the model it already sent this photo,
      // as a suffix line on the MODEL message only (never stored, never shown to
      // the user; see context.ts photoSummary derivation).
      content: m.photoSummary ? `${m.content}\n[You sent a photo: ${m.photoSummary}]` : m.content,
    })),
  ];
}

function buildSummary(context: BuiltContext, assistantContent: string): string {
  const lastUser = [...context.recentMessages].reverse().find((m) => m.role === "user")?.content;
  const newestTurn = [
    lastUser ? `User: ${lastUser}` : null,
    `Assistant: ${assistantContent}`,
  ].filter(Boolean).join("\n");
  // A rolling summary must never freeze once the old prefix fills the cap. Keep
  // the newest turn intact and spend the remaining budget on the recent tail of
  // the previous summary; durable long-term facts live in the memory layer.
  const newest = clampTail(newestTurn, 900);
  const previousBudget = Math.max(0, 900 - newest.length - 1);
  const previous = context.sessionSummary && previousBudget > 0
    ? clampTail(context.sessionSummary, previousBudget)
    : "";
  return [previous, newest].filter(Boolean).join("\n");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
function clampTail(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…".slice(0, max);
  return `…${value.slice(-(max - 1))}`;
}
function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}
// Converts a validated agent tool call plan into the wire shape generate.ts streams/logs.
function toolCallFromPlan(plan: AgentToolCallPlan): ImageAgentToolCall {
  switch (plan.tool) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return { name: plan.tool, arguments: plan.args };
    case EDIT_LAST_IMAGE_TOOL:
      return { name: plan.tool, arguments: plan.args };
    default: {
      const exhaustive: never = plan;
      throw new Error(`unhandled agent tool plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// Inverse of toolCallFromPlan: re-derives the discriminated plan from a resolved
// ImageAgentToolCall (name+arguments already correlated per tool, since it was built by
// toolCallFromPlan or by the FC/planner validation paths). Kept as an explicit switch
// (rather than `{ tool: toolCall.name, args: toolCall.arguments }`) because TS can't
// correlate a union's discriminant with its payload across two independently-typed
// property accesses.
function planFromToolCall(toolCall: ImageAgentToolCall): AgentToolCallPlan {
  switch (toolCall.name) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return { tool: toolCall.name, args: toolCall.arguments };
    case EDIT_LAST_IMAGE_TOOL:
      return { tool: toolCall.name, args: toolCall.arguments };
    default: {
      const exhaustive: never = toolCall;
      throw new Error(`unhandled agent tool call: ${String(exhaustive)}`);
    }
  }
}

interface ImageRequestFromPlan {
  promptHint: string;
  assistantCaption: string | null;
  controls: { orientation: string; outputCount: number; sourceImageAssetId?: string };
  // The tool this request actually ended up as — distinct from plan.tool when
  // edit_last_image degrades to a fresh generate (no source photo). Recorded on the
  // attachment as metadata.toolName so the trail reflects what actually happened,
  // never a stale "edit_last_image" tag on what is, in fact, a plain generate.
  toolName: typeof GENERATE_IMAGE_ASYNC_TOOL | typeof EDIT_LAST_IMAGE_TOOL;
}

// Shapes the attachment/outbox payload fields per plan.tool. The edit_last_image arm
// looks up the session's most recent completed photo (behavior contract point 1) and,
// when found, carries its mediaAssetId as the img2img source (point 2). No source photo
// degrades to generate_image_async semantics rather than erroring (point 3) — sending a
// fresh image beats failing the turn.
async function buildImageRequestFromPlan(
  plan: AgentToolCallPlan,
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<ImageRequestFromPlan> {
  switch (plan.tool) {
    case GENERATE_IMAGE_ASYNC_TOOL:
      return {
        promptHint: plan.args.prompt,
        assistantCaption: plan.args.caption ?? null,
        controls: { orientation: plan.args.orientation, outputCount: plan.args.outputCount },
        toolName: GENERATE_IMAGE_ASYNC_TOOL,
      };
    case EDIT_LAST_IMAGE_TOOL: {
      const source = await tx.messageAttachment.findFirst({
        where: { sessionId, kind: "generated_image", status: "completed", mediaAssetId: { not: null } },
        orderBy: { createdAt: "desc" },
      });
      if (!source?.mediaAssetId) {
        console.warn(
          `edit_last_image: no completed source photo in session ${sessionId}; falling back to generate_image_async semantics`,
        );
        return {
          promptHint: plan.args.instruction,
          assistantCaption: plan.args.caption ?? null,
          controls: { orientation: "4:5", outputCount: 1 },
          toolName: GENERATE_IMAGE_ASYNC_TOOL,
        };
      }
      return {
        promptHint: plan.args.instruction,
        assistantCaption: plan.args.caption ?? null,
        controls: { orientation: "4:5", outputCount: 1, sourceImageAssetId: source.mediaAssetId },
        toolName: EDIT_LAST_IMAGE_TOOL,
      };
    }
    default: {
      const exhaustive: never = plan;
      throw new Error(`unhandled agent tool plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function buildConversationContext(context: BuiltContext, assistantContent: string): string {
  return clamp(
    [
      ...context.recentMessages.map((message) => `${message.role}: ${message.content}`),
      `assistant: ${assistantContent}`,
    ].join("\n"),
    2_000,
  );
}
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function startOfNextUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
