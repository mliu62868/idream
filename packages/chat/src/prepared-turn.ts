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
  messages: ModelMessage[];
  tools: ChatToolDefinition[];
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
  const messages = buildModelMessages(context);
  const fixedContextChars = messages
    .filter((message) => message.role === "system")
    .reduce((total, message) => total + message.content.length, 0) +
    (context.openingMessage?.length ?? 0) +
    context.recentMessages.reduce(
      (total, message) => total + (message.photoSummary?.length ?? 0),
      0,
    );
  const usedInputTokens = estimateTokens(
    messages.map((message) => message.content).join("\n"),
  );
  const prepared: PreparedTurn = {
    messages,
    tools: context.policy.imageToolEnabled ? registryChatTools() : [],
    budget: {
      // Existing policy budgets transcript characters. Keep the approximation
      // explicit until a tokenizer is introduced; do not pretend it is exact.
      maxInputTokens: Math.max(
        1,
        Math.ceil((context.policy.maxContextChars + fixedContextChars) / 4),
      ),
      usedInputTokens,
      dropped: [...context.dropped],
    },
    trace: {
      characterContentVersionId:
        context.persona.characterContentVersionId ?? "legacy-unattributed",
      characterReleaseId: context.persona.characterReleaseId,
      soulFingerprint: context.persona.soulFingerprint ?? "legacy-unattributed",
      compilerVersion: context.persona.compilerVersion ?? "legacy-unattributed",
      sceneVersion: context.sceneVersion,
      relationshipVersion: context.relationship?.version ?? null,
      fileContextRevision: context.fileContextRevision.toString(),
    },
  };
  runtimeByPreparedTurn.set(prepared, context);
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
