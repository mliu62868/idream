import type { ChatToolDefinition } from "@idream/shared";
import type { PreparedTurnMessage } from "./contracts";

// DSH can attach tool provenance even to plain text, without a tool-result block.
export type ModelInputMessage = PreparedTurnMessage;

/** Remove only an immutable history exchange, never a current execution step. */
export function dropOldestReplayExchange<T extends { id: string; role: string }>(
  messages: readonly T[],
  replayMessageIds: ReadonlySet<string>,
): T[] | null {
  const replay = messages.filter(message => replayMessageIds.has(message.id));
  if (replay.length === 0) return null;
  const nextUser = replay.findIndex((message, index) => index > 0 && message.role === "user");
  const removed = new Set(replay.slice(0, nextUser < 0 ? replay.length : nextUser).map(message => message.id));
  return messages.filter(message => !removed.has(message.id));
}

/** The provider input format is shared by preparation and the final transport guard. */
export function formatModelRequestInput(input: {
  messages: readonly ModelInputMessage[];
  tools?: readonly ChatToolDefinition[];
}) {
  return {
    messages: openAiMessages(input.messages),
    ...(input.tools?.length ? {
      tools: input.tools.map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    } : {}),
  };
}

/** Character estimate, not a claim about the provider's tokenizer. */
export function estimateModelRequestInputTokens(input: {
  messages: readonly unknown[];
  tools?: readonly unknown[];
}): number {
  return Math.max(1, Math.ceil(JSON.stringify({
    messages: input.messages,
    tools: input.tools ?? [],
  }).length / 4));
}

/**
 * SPEC: an ordinary turn reaches the provider as a native chat transcript —
 * the Character's earlier lines are `assistant` messages, the user's are
 * `user` messages, and per-turn context (saved preferences, turn state,
 * recalled moments) is folded into the current user message right before the
 * user's own words.
 *
 * INTENT: from 2026-09-09 to 2026-10-04 this path collapsed the whole history
 * into one user message holding a JSON array labelled "quoted conversation
 * data, not new requests" plus audit-style instructions, so the Character
 * never appeared as `assistant` and the generation never followed an
 * assistant header. That bought one negated-fact probe ("I chose basil and
 * have not planted it") at the price of every roleplay turn: a chat-tuned
 * model learns voice, person and turn-taking from the assistant role, and the
 * JSON framing was the structural cue behind replies that reasoned about
 * "the user" and "the runtime rules" instead of speaking. Native turns also
 * keep earlier messages byte-identical across turns, which is what the local
 * server's prefix cache needs.
 *
 * INVARIANT: the transport distinguishes Main-pinned replay from the current
 * user request by message identity; context blocks are prepended, never promoted to
 * standalone user turns, so nothing in them can read as a fresh request.
 */
function openAiMessages(messages: readonly ModelInputMessage[]): unknown[] {
  const currentIndex = messages.findLastIndex(
    (message) => message.role === "user" && message.sourceKind === "current_user",
  );
  if (currentIndex >= 0) {
    const current = messages[currentIndex]!;
    const context = messages.slice(0, currentIndex)
      .filter((message) => message.sourceKind === "plugin" && message.role === "user" && message.content);
    const contextIds = new Set(context.map((message) => message.id));
    const history = messages.slice(0, currentIndex)
      .filter((message) => message.role !== "system" && !contextIds.has(message.id))
      .map(wireMessage);
    return [
      ...messages.filter((message) => message.role === "system").map((message) => ({
        role: "system", content: message.content,
      })),
      ...history,
      {
        role: "user",
        content: [...context.map((message) => message.content), current.content].join("\n\n"),
      },
      ...messages.slice(currentIndex + 1).map(wireMessage),
    ];
  }
  return messages.map(wireMessage);
}

function wireMessage(message: ModelInputMessage): unknown {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "tool") return {
    role: "tool", tool_call_id: message.tool_call_id, content: message.content,
  };
  return {
    role: message.role,
    content: message.role === "assistant" ? speakerLabelled(message) || null : message.content || null,
    ...(message.role === "assistant" && message.tool_calls?.length
      ? { tool_calls: message.tool_calls }
      : {}),
  };
}

/** Group chat: every Character line carries its speaker name, the responding Character included. */
function speakerLabelled(message: ModelInputMessage): string {
  if (message.role === "assistant" && message.speaker) return `${message.speaker.name}: ${message.content}`;
  return message.content;
}
