import type { Context } from '@earendil-works/chord/context';
import type { Message } from '@earendil-works/pi-ai';
import { AssistantEntry, ToolResultEntry, type Conversation, type Cursor, type EntryRecord } from '@earendil-works/pi-durable';

import { igrepSearchResults, runJsonCommand, type IgrepCommand, type RunJsonCommand } from "./igrep";

export type Speaker = { name: string; characterId: string; sessionId: string };
export type MainSource = {
  id: string; role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  sourceKind: 'replay' | 'current_user' | 'plugin'; speaker?: Speaker; toolName?: string;
  tool_call_id?: string; tool_calls?: {id:string;type:'function';function:{name:string;arguments:string}}[];
};
export type Authority = {
  attemptId: string; conversationId: Conversation['id']; assistant: Speaker;
  seed: readonly MainSource[]; omitted: readonly MainSource[];
  /** Actual non-media tool pairs transferred between this attempt's native loops. */
  execution?: readonly MainSource[];
  /** Request-window budgeting may replace an intact tool result with a source cursor. */
  includeVisibleToolResults?: boolean;
};
export type Chunk = Readonly<{
  id: string; ref: string; attemptId: string; sourceId: string; entryId?: EntryRecord['id'];
  role: 'user' | 'assistant' | 'toolResult'; speaker?: Speaker; toolName?: string;
  kind: 'text' | 'toolCall'; toolCallId?: string; title: string; content: string; byteStart: number; byteEnd: number; position: number;
}>;
function validIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid identity');
}
function textParts(message: Message): Array<{ block: number; text: string }> {
  if (typeof message.content === 'string') return [{ block: 0, text: message.content }];
  return message.content.flatMap((block, index) => block.type === 'text' ? [{ block: index, text: block.text }] : []);
}
function rawRole(message: Message): string { return message.role === 'toolResult' ? 'tool' : message.role; }
function signature(message: Message): string {
  return JSON.stringify([message.role, message.content, message.role === 'toolResult' ? message.toolCallId : null]);
}
// UTF-8 boundaries are explicit, and CRLF, combining characters, whitespace,
// and oversized single lines are never normalized or joined across blocks.
function chunks(text: string, maxBytes: number) {
  const result: Array<{ content: string; byteStart: number; byteEnd: number }> = [];
  if (!text.isWellFormed()) throw new Error('invalid Unicode source');
  let content = '', start = 0, size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes && content) {
      result.push({ content, byteStart: start, byteEnd: start + size });
      start += size; content = ''; size = 0;
    }
    content += char; size += bytes;
  }
  if (content) result.push({ content, byteStart: start, byteEnd: start + size });
  return result;
}

/** Sample at a committed request boundary; this attempt owns one fresh conversation. */
export async function projectRecall(conversation: Conversation, context: Context, input: Authority, maxBytes = 2000) {
  validIdentity(input.attemptId);
  if (conversation.id !== input.conversationId) throw new Error('conversation authority mismatch');
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 8000) throw new Error('invalid chunk size');
  const authority = structuredClone(input);
  const sources = new Map<string, MainSource>();
  for (const item of [...authority.omitted, ...authority.seed]) {
    validIdentity(item.id);
    if (item.role === 'system' || item.sourceKind === 'plugin' || item.toolName === 'session_recall') continue;
    const previous = sources.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Main identity content conflict');
    sources.set(item.id, item);
  }
  const execution = new Map<string, MainSource>();
  const executionToolNames = new Map<string, string>();
  for (const item of authority.execution ?? []) {
    validIdentity(item.id);
    if (item.sourceKind !== 'plugin' || (item.role !== 'assistant' && item.role !== 'tool') || execution.has(item.id)) throw new Error('invalid execution source');
    execution.set(item.id, item);
    for (const call of item.tool_calls ?? []) executionToolNames.set(call.id, call.function.name);
  }
  const executionWitnesses = new Map<string, EntryRecord['id']>();
  const visibleExecutionIds = new Set<string>();
  const view = await conversation.context(context);
  if (view.entries.length !== view.contributions.length) throw new Error('invalid contribution alignment');
  const visible = new Map(view.entries.map((entry, index) => [entry.id, view.contributions[index]!]));
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: 'ascending' }, 100, cursor, context);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);
  const records: Chunk[] = [];
  const native: Array<{entry: EntryRecord; message: Message; messageIndex: number}> = [];
  const visibleMainIds = new Set<string>();
  let currentInputWitness = false;
  function add(sourceId: string, role: Chunk['role'], text: string, block: number, metadata: Pick<Chunk, 'speaker' | 'toolName' | 'entryId'> & Partial<Pick<Chunk, 'kind' | 'toolCallId'>>) {
    for (const part of chunks(text, maxBytes)) {
      const id = `attempt:${encodeURIComponent(authority.attemptId)}/${sourceId}/block:${block}/byte:${part.byteStart}`;
      records.push(Object.freeze({ ...part, kind: 'text', ...metadata, id, ref: id, attemptId: authority.attemptId, sourceId, role,
        title: `${role}${metadata.speaker ? ` ${metadata.speaker.name}` : ''}${metadata.toolName ? ` ${metadata.toolName}` : ''}`,
        position: records.length }));
    }
  }
  for (const entry of entries) {
    if (entry.conversationId !== authority.conversationId) throw new Error('entry outside attempt conversation');
    if (entry.kind === 'idream.input' || entry.kind === 'idream.replay') {
      const data = entry.data as { owner?: string; id?: string; sourceKind?: string } | undefined;
      if (data?.owner !== authority.attemptId) throw new Error('entry attempt authority mismatch');
      if (data.sourceKind === 'plugin') continue;
      const source = data.id ? sources.get(data.id) : undefined;
      if (!source || data.sourceKind !== source.sourceKind || entry.model?.length !== 1 || rawRole(entry.model[0]!) !== source.role || textParts(entry.model[0]!).map(part => part.text).join('') !== source.content) throw new Error('Main source witness mismatch');
      if (source.tool_calls && JSON.stringify(source.tool_calls.map(call => [call.id, call.function.name, JSON.parse(call.function.arguments)])) !== JSON.stringify(entry.model[0]!.role === 'assistant' ? entry.model[0]!.content.filter(part => part.type === 'toolCall').map(call => [call.id, call.name, call.arguments]) : [])) throw new Error('Main tool source witness mismatch');
      if (entry.kind === 'idream.input' && source.sourceKind === 'current_user') currentInputWitness = true;
      if (visible.get(entry.id)?.some(message => signature(message) === signature(entry.model![0]!))) visibleMainIds.add(source.id);
      continue;
    }
    if (entry.kind === 'idream.execution') {
      const data = entry.data as { owner?: string; id?: string; sourceKind?: string } | undefined;
      if (data?.owner !== authority.attemptId || data.sourceKind !== 'plugin') throw new Error('execution attempt authority mismatch');
      const source = data.id ? execution.get(data.id) : undefined;
      const message = entry.model?.length === 1 ? entry.model[0] : undefined;
      if (!source || !message || rawRole(message) !== source.role || textParts(message).map(part => part.text).join('') !== source.content
        || (source.role === 'tool' && (message.role !== 'toolResult' || message.toolCallId !== source.tool_call_id))
        || (source.role === 'assistant' && (message.role !== 'assistant' || JSON.stringify(source.tool_calls?.map(call => [call.id, call.function.name, JSON.parse(call.function.arguments)]))
          !== JSON.stringify(message.content.filter(part => part.type === 'toolCall').map(call => [call.id, call.name, call.arguments]))))
        || executionWitnesses.has(source.id)) throw new Error('execution source witness mismatch');
      executionWitnesses.set(source.id, entry.id);
      if (visible.get(entry.id)?.some(item => signature(item) === signature(message))) visibleExecutionIds.add(source.id);
      continue;
    }
    if (!AssistantEntry.is(entry) && !ToolResultEntry.is(entry)) continue;
    for (const [messageIndex, message] of (entry.model ?? []).entries()) {
      if (message.role !== 'assistant' && message.role !== 'toolResult') throw new Error('native entry role mismatch');
      if (message.role === 'toolResult' && message.toolName === 'session_recall') continue;
      if (message.role === 'assistant' && (message.stopReason === 'aborted' || message.stopReason === 'error')) continue;
      if (visible.get(entry.id)?.some(item => signature(item) === signature(message))
        && !(authority.includeVisibleToolResults && message.role === 'toolResult')) continue;
      native.push({ entry, message, messageIndex });
    }
  }
  if (!currentInputWitness) throw new Error('current attempt input witness missing');
  // Main owns the complete authorized history, including originals omitted before
  // Pi saw them. Keep its stable message identity and role/speaker attribution.
  const toolNames = new Map<string, string>();
  for (const source of sources.values()) for (const call of source.tool_calls ?? []) toolNames.set(call.id, call.function.name);
  for (const source of sources.values()) {
    const toolName = source.toolName ?? (source.tool_call_id ? toolNames.get(source.tool_call_id) : undefined);
    // The host pins the current input again after every Pi compaction.
    if (source.sourceKind === 'current_user' || (visibleMainIds.has(source.id) && !(authority.includeVisibleToolResults && source.role === 'tool')) || toolName === 'session_recall') continue;
    const sourceId = `main:${encodeURIComponent(source.id)}`;
    const role = source.role === 'tool' ? 'toolResult' : source.role as 'user' | 'assistant';
    const speaker = source.speaker ?? (source.role === 'assistant' ? authority.assistant : undefined);
    add(sourceId, role, source.content, 0, { ...(speaker ? {speaker} : {}), ...(toolName ? {toolName} : {}) });
    for (const [index, call] of (source.tool_calls ?? []).entries()) {
      if (call.function.name === 'session_recall') continue;
      add(sourceId, 'assistant', call.function.arguments, index + 1, { kind: 'toolCall', toolName: call.function.name, toolCallId: call.id, ...(speaker ? {speaker} : {}) });
    }
  }
  if (executionWitnesses.size !== execution.size) throw new Error('execution source witness missing');
  for (const source of execution.values()) {
    if (visibleExecutionIds.has(source.id) && !(authority.includeVisibleToolResults && source.role === 'tool')) continue;
    const toolName = source.tool_call_id ? executionToolNames.get(source.tool_call_id) : undefined;
    if (source.role === 'tool' && !toolName) throw new Error('execution tool result is unpaired');
    if (toolName === 'session_recall') continue;
    const sourceId = `execution:${encodeURIComponent(source.id)}`;
    const metadata = { entryId: executionWitnesses.get(source.id), ...(source.role === 'assistant' ? { speaker: authority.assistant } : { toolName, toolCallId: source.tool_call_id }) };
    add(sourceId, source.role === 'tool' ? 'toolResult' : 'assistant', source.content, 0, metadata);
    for (const [index, call] of (source.tool_calls ?? []).entries()) {
      if (call.function.name === 'session_recall') continue;
      add(sourceId, 'assistant', call.function.arguments, index + 1, { ...metadata, kind: 'toolCall', toolName: call.function.name, toolCallId: call.id });
    }
  }
  for (const {entry, message, messageIndex} of native) {
    const sourceId = `pi:${encodeURIComponent(entry.id)}/message:${messageIndex}`;
    const metadata = { entryId: entry.id, ...(message.role === 'assistant' ? {speaker: authority.assistant} : message.role === 'toolResult' ? {toolName:message.toolName, toolCallId:message.toolCallId} : {}) };
    for (const part of textParts(message)) add(sourceId, message.role as 'assistant' | 'toolResult', part.text, part.block, metadata);
    if (message.role === 'assistant') for (const [index, call] of message.content.entries()) {
      if (call.type !== 'toolCall' || call.name === 'session_recall') continue;
      add(sourceId, 'assistant', JSON.stringify(call.arguments), index, { ...metadata, kind:'toolCall', toolName:call.name, toolCallId:call.id });
    }
  }
  const byId = new Map(records.map(item => [item.id, item]));
  if (byId.size !== records.length) throw new Error('duplicate chunk identity');
  function own(attemptId: string) {
    if (attemptId !== authority.attemptId) throw new Error('attempt authority mismatch');
  }
  function read(attemptId: string, ids: readonly string[]) {
    own(attemptId);
    if (!ids.length || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('invalid chunk ids');
    return ids.map(id => {
      const chunk = byId.get(id);
      if (!chunk) throw new Error('chunk unavailable in this attempt');
      return structuredClone(chunk);
    });
  }
  return {
    attemptId: authority.attemptId, chunks: structuredClone(records),
    read,
    page(attemptId: string, cursor: string) {
      const first = read(attemptId, [cursor])[0]!;
      const remaining = records.filter(item => item.sourceId === first.sourceId && item.position >= first.position);
      return { results: structuredClone(remaining.slice(0, 8)), nextCursor: remaining[8]?.id ?? null };
    },
    async query(attemptId: string, query: string, cli: IgrepCommand, run: RunJsonCommand = runJsonCommand, signal?: AbortSignal) {
      own(attemptId);
      if (!query.trim() || query.length > 2000) throw new Error('invalid recall query');
      if (cli.env.IGREP_NO_CACHE !== '1') throw new Error('recall requires disabled shared caches');
      signal?.throwIfAborted();
      if (!records.length) return [];
      const payload = await run({ ...cli, args: ['search', '--stdin-format', 'jsonl', '--mode', 'ultra', '--json', '--strict', '--no-cache', '-m', '8', '--', query],
        stdin: records.map(item => JSON.stringify({ id: item.id, ref: item.ref, title: item.title, content: item.content })).join('\n') + '\n',
        acceptedExitCodes: [0, 1], timeoutMs: 60_000, signal }) as Record<string, unknown>;
      const ids = igrepSearchResults(payload).map(hit => {
        if (!hit || typeof hit !== 'object' || Array.isArray(hit)) throw new Error('invalid igrep reference');
        const record = hit as { record?: { id?: unknown }; ref?: unknown };
        return record.record?.id ?? record.ref;
      });
      if (!ids.length) return [];
      if (!ids.every((id: unknown) => typeof id === 'string')) throw new Error('invalid igrep reference');
      // Resolve every selected ID from immutable originals before restoring
      // chronology. The final request window pages by complete IDs when needed;
      // a byte cap here would silently lose the remaining search hits.
      const selected = read(attemptId, ids as string[]);
      return selected.sort((left, right) => left.position - right.position);
    },
  };
}

export type RecallProjection = Awaited<ReturnType<typeof projectRecall>>;
