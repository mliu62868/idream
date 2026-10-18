import type { ChatToolDefinition } from "@idream/shared";
import type { PreparedTurnMessage } from "./contracts";

// Main identities survive execution context edits until the final wire projection.
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
  respondingCharacterId: string;
  messages: readonly ModelInputMessage[];
  tools?: readonly ChatToolDefinition[];
}) {
  return {
    messages: openAiMessages(input.messages, input.respondingCharacterId),
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
 * the responding Character's earlier lines are `assistant` messages; the
 * user and other Characters are incoming `user` messages. Per-turn context
 * (saved preferences, turn state, recalled moments) is bounded background in
 * a preceding user message. The current user's own words remain a separate,
 * unchanged native message.
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
 * user request by message identity; context blocks never gain system authority
 * or become product Turns. Chat emits a separate native current message;
 * providers may merge adjacent user roles, so background also has explicit
 * text delimiters and answered replay requests carry their historical status.
 */
function openAiMessages(messages: readonly ModelInputMessage[], respondingCharacterId: string): unknown[] {
  const wire = (message: ModelInputMessage) => wireMessage(message, respondingCharacterId);
  const currentIndex = messages.findLastIndex(
    (message) => message.role === "user" && message.sourceKind === "current_user",
  );
  if (currentIndex >= 0) {
    const current = messages[currentIndex]!;
    const context = messages.slice(0, currentIndex)
      .filter((message) => message.sourceKind === "plugin" && message.role === "user" && message.content);
    const contextIds = new Set(context.map((message) => message.id));
    const replay = messages.slice(0, currentIndex)
      .filter((message) => message.role !== "system" && !contextIds.has(message.id));
    const lastOwnAnswer = replay.findLastIndex(message => message.role === "assistant" && !message.tool_calls?.length
      && (!message.speaker || message.speaker.characterId === respondingCharacterId));
    const history = replay.map((message, index) => {
      const answer = replay[index + 1];
      // Our native assistant reply already closes preceding incoming turns.
      // Only the remaining tail needs an explicit answered marker when another
      // Character's answer also projects to an incoming user role.
      if (index > lastOwnAnswer && message.role === "user" && message.sourceKind === "replay"
        && answer?.role === "assistant" && !answer.tool_calls?.length
        && answer.speaker && answer.speaker.characterId !== respondingCharacterId) {
        return { role: "user", content: `Earlier user message, already answered:\n${message.content}` };
      }
      return wire(message);
    });
    return [
      ...messages.filter((message) => message.role === "system").map((message) => ({
        role: "system", content: message.content,
      })),
      ...history,
      ...(context.length ? [{
        role: "user",
        content: `Context for this reply (earlier messages are already answered):\n<context>\n${context.map(message => message.content).join("\n\n")}\n</context>`,
      }] : []),
      { role: "user", content: current.content },
      ...messages.slice(currentIndex + 1).map(wire),
    ];
  }
  return messages.map(wire);
}

function wireMessage(message: ModelInputMessage, respondingCharacterId: string): unknown {
  if (message.role === "system") return { role: "system", content: message.content };
  if (message.role === "tool") return {
    role: "tool", tool_call_id: message.tool_call_id, content: message.content,
  };
  const otherSpeaker = message.role === "assistant" && message.speaker && message.speaker.characterId !== respondingCharacterId;
  return {
    // Native tool exchanges keep their protocol roles. Ordinary group lines
    // from another Character are input to this Character, not its own output.
    role: otherSpeaker && !message.tool_calls?.length ? "user" : message.role,
    content: (otherSpeaker ? `${message.speaker!.name}: ${message.content}` : message.content) || null,
    ...(message.role === "assistant" && message.tool_calls?.length
      ? { tool_calls: message.tool_calls }
      : {}),
  };
}
