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

export interface PreparedTurn {
  model: string;
  characterName: string;
  messages: ModelMessage[];
  tools: ChatToolDefinition[];
  profile: {
    tier: string;
    provider: string;
    baseUrl: string;
    model: string;
    supportsTools: boolean;
  };
  budget: {
    maxInputTokens: number;
    usedInputTokens: number;
    dropped: Array<"memory" | "summary" | "transcript">;
  };
  trace: {
    characterContentVersionId: string;
    characterReleaseId: string | null;
    soulFingerprint: string;
    compilerVersion: string;
    sceneVersion: number;
    relationshipVersion: number | null;
    fileContextRevision: string;
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

const runtimeByPreparedTurn = new WeakMap<PreparedTurn, BuiltContext>();

export async function prepareCompanionTurn(
  input: PrepareCompanionTurnInput,
): Promise<PreparedTurn> {
  const context = await buildContext(input);
  const fitted = fitPreparedTurnBudget(context);
  const profile: PreparedTurn["profile"] = {
    tier: fitted.context.policy.tier,
    provider: fitted.context.policy.modelProfile.provider,
    baseUrl: fitted.context.policy.modelProfile.baseUrl,
    model: fitted.context.policy.modelProfile.model,
    supportsTools: fitted.context.policy.modelProfile.supportsTools,
  };
  const prepared: PreparedTurn = {
    model: profile.model,
    characterName: fitted.context.persona.name,
    messages: fitted.messages,
    tools: fitted.tools,
    profile,
    budget: fitted.budget,
    trace: {
      characterContentVersionId:
        fitted.context.persona.characterContentVersionId ?? "legacy-unattributed",
      characterReleaseId: fitted.context.persona.characterReleaseId,
      soulFingerprint: fitted.context.persona.soulFingerprint ?? "legacy-unattributed",
      compilerVersion: fitted.context.persona.compilerVersion ?? "legacy-unattributed",
      sceneVersion: fitted.context.sceneVersion,
      relationshipVersion: fitted.context.relationship?.version ?? null,
      fileContextRevision: fitted.context.fileContextRevision.toString(),
      profile,
    },
  };
  runtimeByPreparedTurn.set(prepared, fitted.context);
  return prepared;
}

/** Internal runtime state for finalization and deterministic tool planning. */
export function preparedTurnRuntime(prepared: PreparedTurn): BuiltContext {
  const context = runtimeByPreparedTurn.get(prepared);
  if (!context) throw new Error("PreparedTurn was not produced by prepareCompanionTurn");
  return context;
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
 * fixed and observable: memory, then summary, then the oldest transcript.
 */
export function fitPreparedTurnBudget(context: BuiltContext): {
  context: BuiltContext;
  messages: ModelMessage[];
  tools: ChatToolDefinition[];
  budget: PreparedTurn["budget"];
} {
  const fitted: BuiltContext = {
    ...context,
    longTermMemories: [...context.longTermMemories],
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
  if (calculated.usedInputTokens > maxInputTokens && fitted.longTermMemories.length > 0) {
    fitted.longTermMemories = [];
    dropped.add("memory");
    calculated = calculate();
  }
  if (calculated.usedInputTokens > maxInputTokens && fitted.sessionSummary) {
    fitted.sessionSummary = null;
    dropped.add("summary");
    calculated = calculate();
  }
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
