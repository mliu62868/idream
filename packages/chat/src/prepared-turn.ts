// SPEC: CompanionTurn is the single generation-facing seam. It owns pinned Soul,
// Scene, relationship, memory, transcript, prompt order, tool exposure, budget,
// and trace assembly; the worker must not rebuild any of those independently.
import type { ChatPrismaClient } from "./db.js";
import type { ChatToolDefinition, ModelMessage } from "@idream/shared";
import { buildContext, type BuiltContext } from "./context.js";
import { buildCompanionSystemPrompt, buildTurnStateBlock } from "./prompt.js";
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
  turnState: string;
}

const runtimeByPreparedTurn = new WeakMap<PreparedTurn, PreparedTurnRuntimeState>();

export async function prepareCompanionTurn(
  input: PrepareCompanionTurnInput,
): Promise<PreparedTurn> {
  const context = await buildContext(input);
  return compilePreparedTurn(context, input.userMessageId, new Date());
}

/** Compile a pure, pinned generation snapshot from an already-authoritative context. */
export function compilePreparedTurn(
  context: BuiltContext,
  currentUserMessageId: string,
  now: Date = new Date(),
): PreparedTurn {
  const fitted = fitPreparedTurnBudget(context, now);
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
    turnState: fitted.turnState,
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
  const { context, currentUserMessageId, turnState } = runtime;
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
  for (const message of context.recentMessages) {
    const isCurrent = message.id === currentUserMessageId;
    if (isCurrent) {
      // The per-turn state is a plugin-sourced context message, so DSH seeds it
      // as history the model reads last and igrep never ingests it.
      messages.push({
        id: `state:${currentUserMessageId}`,
        sourceKind: "plugin",
        role: "user",
        content: turnState,
      });
    }
    messages.push({
      id: message.id,
      sourceKind: isCurrent ? "current_user" : "replay",
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

function buildModelMessages(context: BuiltContext, turnState: string): ModelMessage[] {
  const transcript: ModelMessage[] = context.recentMessages.map((message) => ({
    role: message.role,
    content: message.photoSummary
      ? `${message.content}\n[You sent a photo: ${message.photoSummary}]`
      : message.content,
  }));
  // The state block sits directly before the current user message (the
  // transcript anchor); a transcript that does not end with a user turn keeps
  // the state last so its position stays "right before the model speaks".
  const anchorIndex = transcript.at(-1)?.role === "user" ? transcript.length - 1 : transcript.length;
  transcript.splice(anchorIndex, 0, { role: "user", content: turnState });
  return [
    { role: "system", content: buildCompanionSystemPrompt(context) },
    ...transcript,
  ];
}

/**
 * INVARIANT: the tier budget covers every adapter byte. Degradation order is
 * fixed and observable: drop only the oldest complete transcript exchange.
 */
export function fitPreparedTurnBudget(context: BuiltContext, now: Date = new Date()): {
  context: BuiltContext;
  messages: ModelMessage[];
  tools: ChatToolDefinition[];
  budget: PreparedTurn["budget"];
  turnState: string;
} {
  const fitted: BuiltContext = {
    ...context,
    recentMessages: context.recentMessages.map((message) => ({ ...message })),
    dropped: [...context.dropped],
  };
  const tools = fitted.policy.imageToolEnabled ? registryChatTools() : [];
  const maxInputTokens = Math.max(1, Math.ceil(fitted.policy.maxContextChars / 4));
  const dropped = new Set(fitted.dropped);
  const turnState = buildTurnStateBlock(fitted, now);
  const calculate = () => {
    const messages = buildModelMessages(fitted, turnState);
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
    turnState,
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
