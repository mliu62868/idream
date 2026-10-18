import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, hook, CompactionTask, AssistantEntry, ToolResultEntry, type Conversation, type EntryRecord } from '@earendil-works/pi-durable';
import { it } from 'vitest';
import { projectRecall, type Authority, type MainSource } from './session-recall';
import { createIgrepTools, type JsonCommandOptions } from './igrep';

it('preserves original recall authority across native Pi compaction and bounded public JSONL search', async () => {
const check = async (_name: string, run: () => Promise<unknown> | unknown) => await run();
const cli = {command:'igrep', env:{IGREP_NO_CACHE:'1'}};
const attemptId = 'synthetic-attempt-a';
const speaker = { name: 'Mira', characterId: 'synthetic-mira', sessionId: 'synthetic-group' };
const duplicate = '  Identical words from different speakers.\r\n';
const unicode = ' Leading space\r\n海豚 🐬 cafe\u0301\tend  \n' + '巨大的单行🙂'.repeat(450);
const seed: MainSource[] = [
  { id: 'system', role: 'system', content: 'SYSTEM_MUST_NOT_APPEAR', sourceKind: 'plugin' },
  { id: 'state', role: 'user', content: 'PLUGIN_MUST_NOT_APPEAR', sourceKind: 'plugin' },
  { id: 'main-user', role: 'user', content: duplicate, sourceKind: 'replay' },
  { id: 'main-other-speaker', role: 'assistant', content: duplicate, sourceKind: 'replay', speaker: { name: 'Alex', characterId: 'synthetic-alex', sessionId: 'synthetic-group' } },
  { id: 'long-user', role: 'user', content: unicode, sourceKind: 'replay' },
  { id: 'current', role: 'user', content: 'Please inspect the synthetic inventory.', sourceKind: 'current_user' },
];
const omitted: MainSource[] = [
  { id: 'omitted-kit', role: 'user', content: 'The first aid kit is in the orange cabinet beside the telescope.', sourceKind: 'replay' },
  { id: 'omitted-unrelated', role: 'assistant', content: 'Our synthetic greenhouse contains three blue watering cans.', sourceKind: 'replay', speaker },
];
function asPi(source: MainSource): Message {
  if (source.role === 'assistant') return fauxAssistantMessage(source.content);
  if (source.role === 'tool') return { role: 'toolResult', toolCallId: source.id, toolName: source.toolName ?? 'synthetic', content: [{ type: 'text', text: source.content }], isError: false, timestamp: 1 };
  return { role: source.role, content: source.content, timestamp: 1 };
}
const provider = fauxProvider({ provider: 'recall-qualification', models: [{ id: 'synthetic', contextWindow: 100000, maxTokens: 512 }] });
provider.setResponses([
  fauxAssistantMessage([
    { type: 'thinking', thinking: 'REASONING_MUST_NOT_APPEAR' },
    { type: 'text', text: 'Attempt-local original before tool.\r\n' },
    fauxToolCall('inventory', {marker:'original-tool-argument'}, { id: 'inventory-1' }),
    fauxToolCall('session_recall', {}, { id: 'recall-1' }),
  ], { stopReason: 'toolUse' }),
  fauxAssistantMessage('Current visible answer remains outside recall.'),
]);
const registry = createRegistry();
registry.install(defineExtension({ name: 'recall-qualification', tools: [
  { name: 'inventory', description: 'Synthetic inventory failure.', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: [{ type: 'text' as const, text: 'Inventory sensor failed: the brass key was last seen under the red cushion.\n' }], isError: true }) },
  { name: 'session_recall', description: 'Synthetic self result.', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: [{ type: 'text' as const, text: 'RECALL_RESULT_MUST_NOT_APPEAR' }] }) },
], hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: 'SUMMARY_MUST_NOT_APPEAR' }) })] }));
const models = createModels(); models.setProvider(provider.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { enabled: false }, stream: { maxRetries: 0 }, compaction: { enabled: false, keepRecentTokens: 1 }, toolExecution: 'sequential' } }, context);
let conversation: Conversation;
let authority: Authority;
let lastEntries: readonly EntryRecord[] = [];
let finalProjection: Awaited<ReturnType<typeof projectRecall>> | undefined;
try {
  conversation = await harness.root(context, { agent: { model: { provider: 'recall-qualification', modelId: 'synthetic' }, instructions: seed[0]!.content } });
  authority = { attemptId, conversationId: conversation.id, assistant: speaker, seed, omitted };
  for (const source of seed.filter(item => item.role !== 'system' && item.sourceKind !== 'current_user')) {
    await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: 'idream.replay', data: { owner: attemptId, id: source.id, sourceKind: source.sourceKind }, model: [asPi(source)] }), context);
  }
  const current = seed.find(item => item.sourceKind === 'current_user')!;
  const submission = await conversation.submit({ type: 'input', content: current.content, requestId: attemptId, entry: { kind: 'idream.input', data: { owner: attemptId, id: current.id, sourceKind: current.sourceKind } } }, context);
  await submission.wait(context);
  await check('public-entries-and-contributions-exclude-visible-originals', async () => {
    const projected = await projectRecall(conversation, context, authority);
    assert.deepEqual(projected.chunks.map(item => item.sourceId), ['main:omitted-kit', 'main:omitted-unrelated']);
    const page = await conversation.entries({ order: 'ascending' }, 100, undefined, context);
    assert(page.items.some(AssistantEntry.is)); assert(page.items.some(ToolResultEntry.is));
    return { nativeEntries: page.items.filter(item => AssistantEntry.is(item) || ToolResultEntry.is(item)).length, archivedChunks: projected.chunks.length };
  });
  await check('native-compaction-restores-raw-seed-and-attempt-originals', async () => {
    await conversation.commit(async tx => {
      for (const stopReason of ['aborted','error'] as const) await tx.appendEntry(conversation.id,{kind:AssistantEntry.kind,model:[fauxAssistantMessage('ABORTED_OR_ERROR_MUST_NOT_APPEAR',{stopReason})]});
    },context);
    const task = await conversation.compact('Synthetic compaction qualification.', context);
    await harness.waitForTask(task, context);
    await conversation.waitForIdle(context);
    lastEntries = (await conversation.entries({ order: 'ascending' }, 100, undefined, context)).items;
    assert(lastEntries.some(item => item.kind === 'pi.compaction'));
    finalProjection = await projectRecall(conversation, context, authority, 127);
    const body = finalProjection.chunks.map(item => item.content).join('');
    for (const forbidden of ['SYSTEM_MUST_NOT_APPEAR', 'PLUGIN_MUST_NOT_APPEAR', 'REASONING_MUST_NOT_APPEAR', 'SUMMARY_MUST_NOT_APPEAR', 'RECALL_RESULT_MUST_NOT_APPEAR', 'Current visible answer', 'ABORTED_OR_ERROR_MUST_NOT_APPEAR', 'Please inspect the synthetic inventory.']) assert(!body.includes(forbidden), forbidden);
    assert(body.includes('Attempt-local original before tool.\r\n'));
    assert(body.includes('Inventory sensor failed:'));
    assert(body.includes('original-tool-argument'));
    assert(finalProjection!.chunks.some(item=>item.kind === 'toolCall' && item.toolName === 'inventory'));
    assert(body.includes(omitted[0]!.content));
    assert.equal(provider.state.callCount, 2);
    return { chunks: finalProjection.chunks.length, piEntries: lastEntries.length, fauxModelCalls: provider.state.callCount, realModelCalls: 0 };
  });
  await check('utf8-oversized-lines-crlf-whitespace-and-combining-marks-lossless', () => {
    const selected = finalProjection!.chunks.filter(item => item.sourceId === 'main:long-user');
    assert(selected.length > 5);
    assert.deepEqual(Buffer.from(selected.map(item => item.content).join('')), Buffer.from(unicode));
    let end = 0;
    for (const chunk of selected) { assert.equal(chunk.byteStart, end); assert.equal(chunk.byteEnd - chunk.byteStart, Buffer.byteLength(chunk.content)); assert(Buffer.byteLength(chunk.content) <= 127); assert(chunk.content.isWellFormed()); end = chunk.byteEnd; }
    return { chunks: selected.length, bytes: end, sha256: createHash('sha256').update(unicode).digest('hex') };
  });
  await check('duplicate-text-keeps-main-identity-and-speaker', () => {
    const user = finalProjection!.chunks.filter(item => item.sourceId === 'main:main-user');
    const assistant = finalProjection!.chunks.filter(item => item.sourceId === 'main:main-other-speaker');
    assert.equal(user.length, 1); assert.equal(assistant.length, 1);
    assert.equal(user[0]!.content, assistant[0]!.content); assert.notEqual(user[0]!.id, assistant[0]!.id);
    assert.equal(user[0]!.role, 'user'); assert.equal(assistant[0]!.speaker?.characterId, 'synthetic-alex');
    assert(finalProjection!.chunks.filter(item => item.role === 'assistant' && item.entryId).every(item => item.speaker?.characterId === speaker.characterId));
  });
  await check('stable-ids-and-by-id-never-call-search', async () => {
    // Force public entries() pagination without introducing model context.
    await conversation.commit(async tx => {
      for (let index = 0; index < 105; index++) await tx.appendEntry(conversation.id, { kind: 'qualification.bookkeeping', data: { index } });
    }, context);
    const rebuilt = await projectRecall(conversation, context, authority, 127);
    assert.deepEqual(rebuilt.chunks, finalProjection!.chunks);
    const chosen = rebuilt.chunks.slice(0, 8);
    assert.deepEqual(rebuilt.read(attemptId, chosen.map(item => item.id)), chosen);
    assert(chosen.every(item => item.id.startsWith(`attempt:${attemptId}/`)));
    const mutated = rebuilt.read(attemptId, [chosen[0]!.id]);
    (mutated[0] as { content: string }).content = 'tampered';
    assert.equal(rebuilt.read(attemptId, [chosen[0]!.id])[0]!.content, chosen[0]!.content);
  });
  await check('attempt-and-source-fences-reject-before-dispatch', async () => {
    assert.throws(() => finalProjection!.read('other-attempt', [finalProjection!.chunks[0]!.id]), /attempt authority/);
    assert.throws(() => finalProjection!.read(attemptId, ['attempt:other/pi:1/block:0/byte:0']), /unavailable/);
    assert.throws(() => finalProjection!.read(attemptId, [finalProjection!.chunks[0]!.id, finalProjection!.chunks[0]!.id]), /invalid chunk ids/);
    await assert.rejects(projectRecall(conversation, context, { ...authority, attemptId: 'other-attempt' }), /entry attempt authority/);
    await assert.rejects(projectRecall(conversation, context, { ...authority, omitted: [...omitted, { ...seed[2]!, content: 'conflict' }] }), /Main identity content conflict/);
    let dispatched = 0;
    await assert.rejects(finalProjection!.query('other-attempt', 'kit location', cli, async () => { dispatched++; throw new Error('must not dispatch'); }), /attempt authority/);
    assert.equal(dispatched, 0);
  });
  await check('public-jsonl-search-maps-id-to-authorized-original-not-snippet', async () => {
    const target = finalProjection!.chunks.find(item => item.sourceId === 'main:omitted-kit')!;
    let request: JsonCommandOptions | undefined;
    const found = await finalProjection!.query(attemptId, 'Where are the emergency medical supplies kept?', cli, async command => {
      request = command;
      return { results: [{ record: { id: target.id }, content: 'MALICIOUS_REWRITTEN_SNIPPET' }] };
    });
    assert.deepEqual(request!.args.slice(0, 3), ['search', '--stdin-format', 'jsonl']);
    assert.equal(request!.env.IGREP_NO_CACHE, '1');
    const records = request!.stdin!.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, finalProjection!.chunks.length);
    assert.deepEqual(found, [target]);
    assert.equal(found[0]!.content, omitted[0]!.content);
  });
  await check('incomplete-failed-forged-and-duplicate-query-results-fail-closed', async () => {
    const target = finalProjection!.chunks[0]!;
    for (const payload of [{ failed: true, results: [] }, { complete: false, results: [] }, { warnings: ['incomplete'], results: [] }, { results: [{ ref: 'foreign-id' }] }, { results: [{ ref: target.id }, { ref: target.id }] }]) {
      await assert.rejects(finalProjection!.query(attemptId, 'synthetic query', cli, async () => payload));
    }
    await assert.rejects(finalProjection!.query(attemptId, 'synthetic query', {...cli,env:{IGREP_NO_CACHE:'0'}}, async () => { throw new Error('must not dispatch'); }), /disabled shared caches/);
  });
  const calls: JsonCommandOptions[] = [];
  const observations: Array<{operation:string;evidenceMatches?:number}> = [];
  const tools = createIgrepTools({cli,workspace:'/authorized',knowledgePath:'/authorized/knowledge',mode:'private',
    recall:async()=>finalProjection!,observe:event=>observations.push(event),run:async options=>{calls.push(options);return {results:[]};}});
  assert.deepEqual(tools.map(tool=>tool.name).sort(), ['igrep_search','session_recall']);
  const recall = tools.find(tool=>tool.name==='session_recall')!;
  const index = await recall.execute({}, new AbortController().signal) as Array<{id:string}>;
  assert(index.length > 0 && index.length <= 16);
  const byId = await recall.execute({ids:[index[0]!.id]}, new AbortController().signal) as Array<{content:string}>;
  assert.equal(byId[0]!.content, finalProjection!.read(attemptId,[index[0]!.id])[0]!.content);
  assert.equal(calls.length,0);
  assert(observations.every(event=>event.operation === 'session' && event.evidenceMatches === undefined));
  await assert.rejects(recall.execute({query:'query',ids:[index[0]!.id]},new AbortController().signal));
  const reversed = finalProjection!.chunks.slice(0,3).reverse();
  const ordered = await finalProjection!.query(attemptId,'synthetic query',cli, async()=>({results:reversed.map(item=>({ref:item.id}))}));
  assert.deepEqual(ordered.map(item=>item.position), [...ordered.map(item=>item.position)].sort((a,b)=>a-b));
} finally {
  await harness.close(context);
}
}, 10_000);
