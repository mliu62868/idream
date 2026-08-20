// SPEC: CompanionTurn is the single generation-facing seam. It owns pinned Soul,
// Scene, relationship, memory, transcript, prompt order, tool exposure, budget,
// and trace assembly; the worker must not rebuild any of those independently.
import type { ChatPrismaClient } from "./db.js";
import type {
  ChatToolDefinition,
  ModelMessage,
} from "./providers.js";
import { buildContext, type BuiltContext } from "./context.js";
import { buildCompanionSystemPrompt } from "./prompt.js";
import { registryChatTools } from "./agent-tools.js";
import {
  preparedTurnWireSchema,
  type PreparedTurnWire,
  type ReleasedKnowledgeSnapshot,
} from "@idream/shared/chat/companion-runtime";

export interface PreparedTurn {
  model: string;
  characterName: string;
  messages: ModelMessage[];
  tools: ChatToolDefinition[];
  profile: {
    tier: string;
    adapter: string;
    provider: string;
    baseUrl: string;
    model: string;
    supportsTools: boolean;
    maxOutputTokens: number;
    timeout: {
      firstTokenMs: number;
      idleMs: number;
      completionMs: number;
    };
    sampling: {
      temperature: number;
      topP: number;
      repetitionPenalty: number;
      structuredTemperature: number;
    };
  };
  budget: {
    maxInputTokens: number;
    usedInputTokens: number;
    dropped: Array<"transcript">;
  };
  releasedKnowledge: ReleasedKnowledgeSnapshot;
  trace: {
    characterContentVersionId: string;
    characterReleaseId: string | null;
    soulFingerprint: string;
    compilerVersion: string;
    sceneVersion: number;
    relationshipVersion: number | null;
    fileContextRevision: string;
    releasedKnowledgeDigest: string;
    profile: PreparedTurn["profile"];
  };
}

export interface PrepareCompanionTurnInput {
  prisma: ChatPrismaClient;
  userId: string;
  characterId: string;
  sessionId: string;
  turnMemoryEnabled: boolean;
  userMessageId: string;
}

interface PreparedTurnRuntimeState {
  context: BuiltContext;
  currentUserMessageId: string;
}

const runtimeByPreparedTurn = new WeakMap<PreparedTurn, PreparedTurnRuntimeState>();

export async function prepareCompanionTurn(
  input: PrepareCompanionTurnInput,
): Promise<PreparedTurn> {
  const context = await buildContext(input);
  return compilePreparedTurn(context, input.userMessageId);
}

/** Compile a pure, pinned generation snapshot from an already-authoritative context. */
export function compilePreparedTurn(
  context: BuiltContext,
  currentUserMessageId: string,
): PreparedTurn {
  const fitted = fitPreparedTurnBudget(context);
  const modelProfile = fitted.context.policy.modelProfile;
  const profile: PreparedTurn["profile"] = {
    tier: fitted.context.policy.tier,
    adapter: modelProfile.adapter,
    provider: modelProfile.provider,
    baseUrl: modelProfile.baseUrl,
    model: modelProfile.model,
    supportsTools: modelProfile.supportsTools,
    maxOutputTokens: modelProfile.maxOutputTokens,
    timeout: {
      firstTokenMs: modelProfile.firstTokenTimeoutMs,
      idleMs: modelProfile.idleTimeoutMs,
      completionMs: modelProfile.completionTimeoutMs,
    },
    sampling: {
      temperature: modelProfile.temperature ?? 0.9,
      topP: modelProfile.topP ?? 0.95,
      repetitionPenalty: modelProfile.repetitionPenalty ?? 1.05,
      structuredTemperature: modelProfile.structuredTemperature ?? 0.2,
    },
  };
  const prepared: PreparedTurn = {
    model: profile.model,
    characterName: fitted.context.persona.name,
    messages: fitted.messages,
    tools: fitted.tools,
    profile,
    budget: fitted.budget,
    releasedKnowledge: fitted.context.releasedKnowledge,
    trace: {
      characterContentVersionId:
        fitted.context.persona.characterContentVersionId ?? "legacy-unattributed",
      characterReleaseId: fitted.context.persona.characterReleaseId,
      soulFingerprint: fitted.context.persona.soulFingerprint ?? "legacy-unattributed",
      compilerVersion: fitted.context.persona.compilerVersion ?? "legacy-unattributed",
      sceneVersion: fitted.context.sceneVersion,
      relationshipVersion: fitted.context.relationship?.version ?? null,
      fileContextRevision: fitted.context.fileContextRevision.toString(),
      releasedKnowledgeDigest: fitted.context.releasedKnowledge.digest,
      profile,
    },
  };
  runtimeByPreparedTurn.set(prepared, {
    context: fitted.context,
    currentUserMessageId,
  });
  return prepared;
}

/** Internal runtime state for finalization and deterministic tool planning. */
export function preparedTurnRuntime(prepared: PreparedTurn): BuiltContext {
  const runtime = runtimeByPreparedTurn.get(prepared);
  if (!runtime) throw new Error("PreparedTurn was not produced by prepareCompanionTurn");
  return runtime.context;
}

/**
 * Product wire only: stable ids and provenance, no DB handle, API key, DSH type
 * or mutable runtime object may cross this boundary.
 */
export function toPreparedTurnWire(prepared: PreparedTurn): PreparedTurnWire {
  const runtime = runtimeByPreparedTurn.get(prepared);
  if (!runtime) throw new Error("PreparedTurn was not produced by prepareCompanionTurn");
  const { context, currentUserMessageId } = runtime;
  const messages: PreparedTurnWire["messages"] = [
    {
      id: [
        "system",
        prepared.trace.soulFingerprint,
        prepared.trace.sceneVersion,
        prepared.trace.relationshipVersion ?? "none",
      ].join(":"),
      sourceKind: "plugin",
      role: "system",
      content: prepared.messages[0]?.content ?? "",
    },
  ];
  if (context.openingMessage) {
    messages.push({
      id: `opening:${prepared.trace.characterReleaseId ?? prepared.trace.characterContentVersionId}`,
      sourceKind: "plugin",
      role: "assistant",
      content: context.openingMessage,
    });
  }
  for (const message of context.recentMessages) {
    messages.push({
      id: message.id,
      sourceKind:
        message.id === currentUserMessageId ? "current_user" : "replay",
      role: message.role,
      content: message.photoSummary
        ? `${message.content}\n[You sent a photo: ${message.photoSummary}]`
        : message.content,
    });
  }
  const { profile: _runtimeProfile, ...wireTrace } = prepared.trace;
  return preparedTurnWireSchema.parse({
    version: 2,
    model: prepared.model,
    characterName: prepared.characterName,
    messages,
    tools: prepared.tools,
    profile: prepared.profile,
    budget: prepared.budget,
    releasedKnowledge: prepared.releasedKnowledge,
    trace: wireTrace,
  });
}

function buildModelMessages(context: BuiltContext): ModelMessage[] {
  return [
    { role: "system", content: buildCompanionSystemPrompt(context) },
    ...(context.openingMessage
      ? [{ role: "assistant" as const, content: context.openingMessage }]
      : []),
    ...context.recentMessages.map((message) => ({
      role: message.role,
      content: message.photoSummary
        ? `${message.content}\n[You sent a photo: ${message.photoSummary}]`
        : message.content,
    })),
  ];
}

/**
 * INVARIANT: the tier budget covers every adapter byte. Degradation order is
 * fixed and observable: drop only the oldest complete transcript exchange.
 */
export function fitPreparedTurnBudget(context: BuiltContext): {
  context: BuiltContext;
  messages: ModelMessage[];
  tools: ChatToolDefinition[];
  budget: PreparedTurn["budget"];
} {
  const fitted: BuiltContext = {
    ...context,
    recentMessages: context.recentMessages.map((message) => ({ ...message })),
    dropped: [...context.dropped],
  };
  const tools = fitted.policy.imageToolEnabled ? registryChatTools() : [];
  const maxInputTokens = Math.max(1, Math.ceil(fitted.policy.maxContextChars / 4));
  const dropped = new Set(fitted.dropped);
  const calculate = () => {
    const messages = buildModelMessages(fitted);
    const usedInputTokens = estimateTokens(
      `${messages.map((message) => message.content).join("\n")}\n${JSON.stringify(tools)}`,
    );
    return { messages, usedInputTokens };
  };

  let calculated = calculate();
  while (calculated.usedInputTokens > maxInputTokens && fitted.recentMessages.length > 1) {
    // INVARIANT: the transcript is a sequence of user-led exchanges. Dropping a
    // single message can make an old assistant reply look like an unsolicited
    // instruction, so budget pressure removes the whole oldest exchange.
    fitted.recentMessages.shift();
    while (
      fitted.recentMessages.length > 1 &&
      fitted.recentMessages[0]?.role !== "user"
    ) {
      fitted.recentMessages.shift();
    }
    dropped.add("transcript");
    calculated = calculate();
  }
  if (calculated.usedInputTokens > maxInputTokens) {
    throw new Error(
      `PreparedTurn fixed context requires ${calculated.usedInputTokens} tokens but tier ${fitted.policy.tier} allows ${maxInputTokens}`,
    );
  }
  fitted.dropped = [...dropped];
  return {
    context: fitted,
    messages: calculated.messages,
    tools,
    budget: {
      maxInputTokens,
      usedInputTokens: calculated.usedInputTokens,
      dropped: [...dropped],
    },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
