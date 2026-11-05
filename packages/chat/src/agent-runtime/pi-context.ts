import type { AssistantMessage, JsonObject, Message, Tool } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { CompanionInvocation, PreparedTurnMessage, PreparedTurnProfile } from "./contracts";
import { formatModelRequestInput, type ModelInputMessage } from "./model-request-format";
import { estimatePiModelRequestInputTokens } from "./openai-adapter";
import type { Chunk } from "./session-recall";

export function messageText(message: Message): string {
  return typeof message.content === "string" ? message.content
    : message.content.filter(block => block.type === "text").map(block => block.text).join("");
}

/** The required usage fields on replay entries are structural, never billing receipts. */
export function toPiMessage(message: ModelInputMessage, profile?: PreparedTurnProfile): Message {
  const timestamp = 1;
  if (message.role === "user" || message.role === "system") return { role: message.role, content: message.content, timestamp };
  if (message.role === "tool") return {
    role: "toolResult", toolCallId: message.tool_call_id, toolName: "",
    content: [{ type: "text", text: message.content }], isError: false, timestamp,
  };
  return {
    role: "assistant", content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...(message.tool_calls ?? []).map(call => ({
        type: "toolCall" as const, id: call.id, name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as JsonObject,
      })),
    ], api: "openai-completions", provider: profile?.provider ?? "replay", model: profile?.model ?? "replay",
    stopReason: message.tool_calls?.length ? "toolUse" : "stop", timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** Preserve Main provenance by entry identity, including identical text by different speakers. */
export function projectPiMessage(entry: EntryRecord, message: Message, index: number, invocation: CompanionInvocation): ModelInputMessage {
  const data = entry.data as {
    owner?: string; id?: string; sourceKind?: PreparedTurnMessage["sourceKind"];
    speaker?: Extract<PreparedTurnMessage, { role: "assistant" }>["speaker"];
  } | undefined;
  if (entry.kind === "idream.input" || entry.kind === "idream.replay" || entry.kind === "idream.execution") {
    if (data?.owner !== invocation.attemptId || !data.id || !data.sourceKind) throw new Error("entry is not bound to the current attempt");
  }
  const id = data?.id ?? `${entry.kind}:${entry.id}:${index}`;
  const sourceKind = data?.sourceKind ?? "plugin";
  const content = messageText(message);
  if (message.role === "toolResult") return { id, sourceKind, role: "tool", tool_call_id: message.toolCallId, content };
  if (message.role === "assistant") {
    const calls = message.content.filter(block => block.type === "toolCall");
    return { id, sourceKind, role: "assistant", content,
      ...(data?.speaker ? { speaker: data.speaker } : {}),
      ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
    };
  }
  return { id, sourceKind, role: message.role, content };
}

/** Seed only retained history. Omitted originals remain available through session recall. */
export function buildReplaySeed(invocation: CompanionInvocation, recallContext?: string): PreparedTurnMessage[] {
  const messages = invocation.preparedTurn.messages.filter(message => message.role !== "system" && message.sourceKind !== "current_user");
  const output: PreparedTurnMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "tool") throw new Error("prepared replay tool result has no matching call");
    output.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const results = new Map<string, PreparedTurnMessage>();
    while (messages[i + 1]?.role === "tool") {
      const result = messages[++i]! as Extract<PreparedTurnMessage, { role: "tool" }>;
      if (results.has(result.tool_call_id)) throw new Error("prepared replay contains duplicate tool results");
      results.set(result.tool_call_id, result);
    }
    if (results.size !== message.tool_calls.length) throw new Error("prepared replay contains dangling tool calls");
    for (const call of message.tool_calls) {
      const result = results.get(call.id);
      if (!result) throw new Error("prepared replay tool result identity mismatch");
      output.push(result);
    }
  }
  if (recallContext) output.push({ id: `recall:${invocation.attemptId}`, role: "user", sourceKind: "plugin", content: recallContext });
  return output;
}

/** Current state is immutable even if Pi compaction keeps only a summary and tool tail. */
export function formatCompanionMessages(
  messages: readonly ModelInputMessage[], pinned: readonly ModelInputMessage[], systemPrompt: string, tools: readonly Tool[],
  respondingCharacterId: string,
): Message[] {
  const current = pinned.find(message => message.sourceKind === "current_user");
  const fixed = pinned.filter(message => message.role === "user" && message.sourceKind === "plugin");
  const fixedIds = new Set(fixed.map(message => message.id));
  const projected = messages.filter(message => message.role !== "system" && !fixedIds.has(message.id));
  const currentIndex = projected.findIndex(message => message.id === current?.id);
  if (currentIndex >= 0) projected.splice(currentIndex, 0, ...fixed);
  else {
    const index = projected.findIndex(message => !message.id.startsWith("pi.compaction:"));
    projected.splice(index < 0 ? projected.length : index, 0, ...fixed, ...(current ? [current] : []));
  }
  const wire = formatModelRequestInput({ messages: projected, respondingCharacterId }).messages as Array<{
    role: PreparedTurnMessage["role"]; content?: string | null; tool_call_id?: string;
    tool_calls?: Extract<PreparedTurnMessage, { role: "assistant" }>["tool_calls"];
  }>;
  return [
    { role: "system", content: systemPrompt, toolsAdded: [...tools], timestamp: 1 },
    ...wire.map((message, index) => toPiMessage({ ...message, id: `wire:${index}`, sourceKind: "plugin", content: message.content ?? "" } as ModelInputMessage)),
  ];
}

/** Budget the complete wire request, including pinned state and current tool schemas. */
export function fitCompanionMessages(input: {
  messages: readonly ModelInputMessage[]; pinned: readonly ModelInputMessage[];
  systemPrompt: string; tools: readonly Tool[]; respondingCharacterId: string;
  maxInputTokens: number; afterRetrievalContext?: string;
  toolSources: ReadonlyMap<string, readonly Chunk[]>;
}): Message[] {
  let projected = input.messages.map(message => ({ ...message }));
  const render = () => {
    const messages = formatCompanionMessages(projected, input.pinned, input.systemPrompt, input.tools, input.respondingCharacterId);
    if (input.afterRetrievalContext) messages.push({ role: "user", content: input.afterRetrievalContext, timestamp: 1 });
    return messages;
  };
  let messages = render();
  const fits = () => estimatePiModelRequestInputTokens(messages) <= input.maxInputTokens;
  if (fits()) return messages;

  // Summaries are derived, optional context. Current words, media references and
  // original records remain pinned or source-addressable, never clipped to fit.
  projected = projected.filter(message => !message.id.startsWith("pi.compaction:"));
  messages = render();
  if (fits()) return messages;

  const names = new Map(projected.flatMap(message => message.role === "assistant"
    ? (message.tool_calls ?? []).map(call => [call.id, call.function.name] as const) : []));
  // Pi keeps a parallel tool round intact. Replace bulky read-only results with
  // exact source cursors; the untouched Pi entries are still the recall authority.
  for (const result of projected.filter(message => message.role === "tool"
    && ["igrep_search", "igrep_read_source", "memory_search", "igrep_web_search"].includes(names.get(message.tool_call_id) ?? ""))) {
    const chunks = input.toolSources.get(result.id);
    if (!chunks?.length) continue;
    const reference = JSON.stringify({ sourceId: chunks[0]!.sourceId,
      status: "paged_for_context", totalBytes: chunks.reduce((sum, chunk) => sum + chunk.byteEnd - chunk.byteStart, 0),
      next: { tool: "session_recall", arguments: { cursor: chunks[0]!.id } } });
    if (reference.length >= result.content.length) continue;
    result.content = reference;
    messages = render();
    if (fits()) return messages;
  }

  // Page only at complete original-chunk boundaries. Every withheld ID and the
  // source page cursor remain explicit, so the next call can read exact bytes.
  const recallResults = projected.filter(message => message.role === "tool" && names.get(message.tool_call_id) === "session_recall");
  for (const result of recallResults) {
    let value: unknown;
    try { value = JSON.parse(result.content); } catch { continue; }
    const page = !Array.isArray(value) && typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
    const rows: unknown = Array.isArray(value) ? value : page?.results;
    if (!Array.isArray(rows) || !rows.every(row => row && typeof row === "object" && typeof row.id === "string")) continue;
    // The newest read must deliver at least one complete chunk. Returning only
    // its own IDs would tell the model to repeat a read that can never progress.
    for (let count = rows.length - 1; count >= (result === recallResults.at(-1) ? 1 : 0); count--) {
      const remainingIds = rows.slice(count).map(row => row.id as string);
      const content = JSON.stringify({ results: rows.slice(0, count), remainingIds,
        ...(typeof page?.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
        next: { tool: "session_recall", arguments: page && "nextCursor" in page
          ? { cursor: remainingIds[0] } : { ids: remainingIds.slice(0, 8) } } });
      if (content.length >= result.content.length) continue;
      result.content = content;
      messages = render();
      if (fits()) return messages;
    }
  }
  // Keep the adapter's hard guard: irreducible fixed input must still fail, and
  // an uncompacted replay can still enter Pi's ordinary overflow compaction.
  return messages;
}

export function finishReason(message: AssistantMessage): "stop" | "max-tokens" | "tool-calls" | "error" {
  return message.stopReason === "stop" ? "stop" : message.stopReason === "length" ? "max-tokens"
    : message.stopReason === "toolUse" ? "tool-calls" : "error";
}
