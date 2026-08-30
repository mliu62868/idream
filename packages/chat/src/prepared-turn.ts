// SPEC: CompanionTurn is the single generation-facing seam. It owns pinned Soul,
// Scene, memory, transcript, prompt order, tool exposure, budget,
// and trace assembly; the worker must not rebuild any of those independently.
import type { ChatToolDefinition, ModelMessage } from "@idream/shared";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatExecutionSnapshot } from "@idream/shared/contracts";
import { buildContext, type BuiltContext } from "./context.js";
import { buildCompanionSystemPrompt, buildTurnStateBlock } from "./prompt.js";
import { registryChatTools } from "./agent-tools.js";
import {
  preparedTurnSchema,
  type PreparedTurnInput,
} from "./agent-runtime/contracts.js";

export interface PreparedTurn extends PreparedTurnInput {
  /** Main-owned context needed only for deterministic terminal finalization. */
  context: BuiltContext;
}

export interface PrepareCompanionTurnInput {
  snapshot: ChatExecutionSnapshot;
  authority: ChatAuthoritySnapshot;
}

export async function prepareCompanionTurn(
  input: PrepareCompanionTurnInput,
): Promise<PreparedTurn> {
  const context = await buildContext(input);
  return compilePreparedTurn(context, input.snapshot.userMessageId, new Date());
}

/** Compile a pure, pinned generation snapshot from an already-authoritative context. */
export function compilePreparedTurn(
  context: BuiltContext,
  currentUserMessageId: string,
  now: Date = new Date(),
): PreparedTurn {
  const fitted = fitPreparedTurnBudget(context, now);
  const modelProfile = fitted.context.policy.modelProfile;
  const profile: PreparedTurnInput["profile"] = {
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
    },
    sampling: {
      temperature: modelProfile.temperature ?? 0.9,
      topP: modelProfile.topP ?? 0.95,
      repetitionPenalty: modelProfile.repetitionPenalty ?? 1.05,
    },
  };
  const messages: PreparedTurnInput["messages"] = [{
    id: [
      "system",
      fitted.context.persona.soulFingerprint,
      fitted.context.sceneVersion,
    ].join(":"),
    sourceKind: "plugin",
    role: "system",
    content: fitted.messages[0]?.content ?? "",
  }];
  for (const message of fitted.context.recentMessages) {
    const isCurrent = message.id === currentUserMessageId;
    if (isCurrent) {
      // The state stays immediately before the current message and is never
      // ingested as user-authored memory.
      messages.push({
        id: `state:${currentUserMessageId}`,
        sourceKind: "plugin",
        role: "user",
        content: fitted.turnState,
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
  const execution = preparedTurnSchema.parse({
    version: 3,
    model: profile.model,
    characterName: fitted.context.persona.name,
    messages,
    tools: fitted.tools,
    profile,
    budget: fitted.budget,
    trace: {
      characterContentVersionId:
        fitted.context.persona.characterContentVersionId ?? fail("Character content version is required"),
      characterReleaseId: fitted.context.persona.characterReleaseId,
      soulFingerprint: fitted.context.persona.soulFingerprint ?? fail("Soul fingerprint is required"),
      compilerVersion: fitted.context.persona.compilerVersion ?? fail("Soul compiler version is required"),
      sceneVersion: fitted.context.sceneVersion,
      contextRevision: fitted.context.contextRevision.toString(),
    },
  });
  return {
    ...execution,
    context: fitted.context,
  };
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

function fail(message: string): never {
  throw new Error(message);
}
