import type { Prisma } from "@prisma/client";
import { providers } from "@/server/providers";
import type {
  AiFinalizePayload,
  ChatGeneratePayload,
  ChatStreamEvent,
} from "./schemas";

type ChatCompletedPayload = Extract<AiFinalizePayload, { kind: "chat.completed" }>;

export interface ChatRuntimeResult {
  deltas: Array<Extract<ChatStreamEvent, { type: "delta" }>>;
  content: string;
  model: string;
  usage: ChatCompletedPayload["usage"];
  memoryPatch?: ChatCompletedPayload["memoryPatch"];
  relationshipPatch?: ChatCompletedPayload["relationshipPatch"];
  trace: Prisma.JsonValue;
}

export interface ChatRuntimeOptions {
  onDelta?: (event: Extract<ChatStreamEvent, { type: "delta" }>) => Promise<void> | void;
}

export async function generateChatCompletion(
  payload: ChatGeneratePayload,
  attempt: number,
  options: ChatRuntimeOptions = {},
): Promise<ChatRuntimeResult> {
  const modelMessages = buildModelMessages(payload);
  const chunks: string[] = [];
  const deltas: ChatRuntimeResult["deltas"] = [];
  let seq = 0;

  for await (const chunk of providers.chat.stream({
    characterName: payload.character.name,
    messages: modelMessages,
  })) {
    if (!chunk.delta) continue;
    seq += 1;
    chunks.push(chunk.delta);
    const event = {
      type: "delta",
      attempt,
      seq,
      delta: chunk.delta,
    } satisfies Extract<ChatStreamEvent, { type: "delta" }>;
    deltas.push(event);
    await options.onDelta?.(event);
  }

  const content = chunks.join("");
  return {
    deltas,
    content,
    model: payload.entitlements.modelTier === "free" ? "pi-agent-local-free" : "pi-agent-local-plus",
    usage: {
      promptTokens: estimateTokens(modelMessages.map((message) => message.content).join("\n")),
      completionTokens: estimateTokens(content),
    },
    memoryPatch: {
      sessionSummary: {
        operation: "replace",
        text: summarizeSession(payload, content),
      },
      candidates: memoryCandidatesFor(payload),
    },
    relationshipPatch: relationshipPatchFor(payload),
    trace: {
      runtime: "pi-agent-local",
      promptTemplateVersion: "local-companion-v2",
      attempt,
    },
  };
}

function buildModelMessages(payload: ChatGeneratePayload) {
  const memoryLines = payload.context.longTermMemories
    .map((memory) => memoryText(memory))
    .filter(Boolean);
  const relationship = relationshipText(payload.context.relationshipState);
  const system = [
    companionSystemInstruction(payload),
    payload.character.systemPrompt ?? payload.character.description,
    payload.context.sessionSummary ? `Session summary: ${payload.context.sessionSummary}` : "",
    memoryLines.length ? `Long-term memories:\n${memoryLines.join("\n")}` : "",
    relationship ? `Relationship state: ${relationship}` : "",
    payload.mode === "no_memory"
      ? "No-memory mode is enabled for this session. Do not store new long-term memories."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const recent = payload.context.recentMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));

  return [{ role: "system" as const, content: system }, ...recent];
}

function companionSystemInstruction(payload: ChatGeneratePayload) {
  const relation = payload.character.relationship ?? "AI companion";
  return [
    `You are ${payload.character.name}, an adult ${relation} character in a private companion chat.`,
    "Stay in persona, remember the user's stated preferences and boundaries, and keep continuity across turns.",
    "Do not claim to remember facts that are not present in the supplied context.",
    "If the user sets a boundary, acknowledge it and follow it in future replies.",
  ].join(" ");
}

function summarizeSession(payload: ChatGeneratePayload, assistantContent: string) {
  const lastUser = [...payload.context.recentMessages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  const pieces = [
    payload.context.sessionSummary,
    lastUser ? `User: ${lastUser}` : null,
    `Assistant: ${assistantContent}`,
  ].filter(Boolean);
  return clampText(pieces.join("\n"), 900);
}

function memoryCandidatesFor(payload: ChatGeneratePayload) {
  if (!payload.policy.allowMemoryWrite || payload.mode === "no_memory") return [];

  const lastUser = [...payload.context.recentMessages]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUser) return [];

  const candidates: NonNullable<ChatCompletedPayload["memoryPatch"]>["candidates"] = [];
  const nickname = lastUser.content.match(/\bcall me ([a-z0-9 _-]{1,40})/i)?.[1]?.trim();
  const chineseNickname = lastUser.content.match(/(?:叫我|称呼我为)([\p{Script=Han}a-zA-Z0-9 _-]{1,40})/u)?.[1]?.trim();
  const preferredName = nickname ?? chineseNickname;
  if (preferredName) {
    candidates.push({
      operation: "upsert",
      scope: "character",
      type: "preference",
      text: `User likes being called ${preferredName}.`,
      confidence: 0.84,
      sourceMessageIds: [lastUser.id ?? payload.userMessageId],
    });
  }

  const preference = lastUser.content.match(/\bi like ([^.?!]{3,80})/i)?.[1]?.trim();
  const chinesePreference = lastUser.content.match(/我喜欢([^。！？\n]{2,80})/u)?.[1]?.trim();
  const likedThing = preference ?? chinesePreference;
  if (likedThing) {
    candidates.push({
      operation: "upsert",
      scope: "character",
      type: "preference",
      text: `User likes ${likedThing}.`,
      confidence: 0.78,
      sourceMessageIds: [lastUser.id ?? payload.userMessageId],
    });
  }

  const boundary = lastUser.content.match(/\b(?:do not|don't) (?:remember|store|talk about) ([^.?!]{3,80})/i)?.[1]?.trim();
  const chineseBoundary = lastUser.content.match(/(?:不要|别)(?:记住|保存|聊|提)([^。！？\n]{2,80})/u)?.[1]?.trim();
  const boundaryText = boundary ?? chineseBoundary;
  if (boundaryText) {
    candidates.push({
      operation: "upsert",
      scope: "character",
      type: "boundary",
      text: `User set a boundary: do not remember, store, or bring up ${boundaryText}.`,
      confidence: 0.9,
      sourceMessageIds: [lastUser.id ?? payload.userMessageId],
    });
  }

  return candidates;
}

function relationshipPatchFor(payload: ChatGeneratePayload) {
  if (!payload.policy.allowRelationshipPatch) return undefined;
  return {
    operation: "merge" as const,
    summaryDelta: lastUserContent(payload),
    signalsDelta: { familiarity: 1, warmth: 1, turns: 1 },
  };
}

function lastUserContent(payload: ChatGeneratePayload) {
  const content = [...payload.context.recentMessages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  return content ? clampText(`Last meaningful user turn: ${content}`, 240) : "";
}

function memoryText(value: unknown) {
  if (!isRecord(value)) return "";
  const text = value.text;
  if (typeof text !== "string" || !text.trim()) return "";
  const type = typeof value.type === "string" ? value.type : "memory";
  return `- [${type}] ${text}`;
}

function relationshipText(value: unknown) {
  if (!isRecord(value)) return "";
  const stage = typeof value.stage === "string" ? value.stage : "new";
  const summary = typeof value.summary === "string" ? value.summary : "";
  return [stage, summary].filter(Boolean).join(" - ");
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function clampText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
