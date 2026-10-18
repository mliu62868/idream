import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Agent } from '@earendil-works/pi-agent-core';
import { Harness, createRegistry, defineTask, defineExtension } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';

const mode = process.argv[2];
const context = BACKGROUND_CONTEXT;
const fixturePath = join(process.cwd(), 'fixture.json');
const registry = createRegistry();
const Checkpoint = defineTask({
  name: 'research.checkpoint',
  version: 1,
  initial: () => ({ phase: 'save' }),
  phases: {
    save: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'resume' } }), ctx);
      if (mode === 'crash') {
        process.stdout.write(JSON.stringify({ checkpointCommitted: true, abruptExit: 73 }) + '\n');
        process.exit(73);
      }
    },
    resume: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: 'resumed-from-checkpoint' } }), ctx);
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
  },
});
registry.install(defineExtension({ name: 'research', tasks: [Checkpoint] }));
assert.equal(typeof Agent, 'function');
const harness = await Harness.open(
  await openNodeJsonlStorage(join(process.cwd(), 'jsonl-data'), context, { fsync: true }),
  { models: createModels(), registry },
  context,
);
const root = await harness.root(context);
if (mode === 'crash') {
  const submission = await root.submit({
    type: 'write', requestId: 'probe:immutable-request:1',
    entry: { kind: 'research.note', data: { value: 'original' } },
  }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, 'done');
  const taskId = await root.commit(
    tx => tx.createTask(Checkpoint, {}, { ownership: { kind: 'conversation' } }), context,
  );
  await writeFile(fixturePath, JSON.stringify({ rootId: root.id, submissionId: submission.id, taskId }));
  harness.resume();
  await harness.waitForTask(taskId, context);
  throw new Error('Expected abrupt exit immediately after checkpoint');
}
if (mode !== 'resume') throw new Error('Expected crash or resume');
try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(root.id, fixture.rootId);
  const storedTask = await harness.getTask(fixture.taskId, context);
  // v1.3.0 TaskScheduler.open converts interrupted running tasks to pending
  // while preserving their checkpoint (scheduler.ts:303-304).
  assert.equal(storedTask.state.status, 'pending');
  assert.equal(storedTask.state.checkpoint.phase, 'resume');
  const same = await root.submit({
    type: 'write', requestId: 'probe:immutable-request:1',
    entry: { kind: 'research.note', data: { value: 'original' } },
  }, context);
  assert.equal(same.id, fixture.submissionId);
  const changed = await root.submit({
    type: 'write', requestId: 'probe:immutable-request:1',
    entry: { kind: 'research.note', data: { value: 'changed-payload' } },
  }, context);
  assert.equal(changed.id, fixture.submissionId);
  const entries = await root.commit(tx => tx.scanEntries({ conversationId: root.id }, 100), context);
  const notes = entries.items.filter(entry => entry.kind === 'research.note');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].data, { value: 'original' });
  const task = await harness.waitForTask(fixture.taskId, context);
  assert.deepEqual(task.state.outcome, { status: 'completed', result: 'resumed-from-checkpoint' });
  process.stdout.write(JSON.stringify({
    runtime: `bun ${Bun.version}`, packages: '1.3.0', storage: 'JSONL fsync=true',
    reopenedSameConversation: true, checkpointSurvivedAbruptExit: true,
    resumedTaskCompleted: true, duplicateRequestDeduplicated: true,
    sameRequestIdChangedPayload: 'returns-original-no-conflict',
    modelRequests: 0,
  }, null, 2) + '\n');
} finally {
  await harness.close(context);
}
