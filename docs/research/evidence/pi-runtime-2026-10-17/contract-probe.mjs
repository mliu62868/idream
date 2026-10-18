import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, hook, CompactionTask } from '@earendil-works/pi-durable';

// A research probe, not an iDream runtime test. All source text is synthetic;
// the official faux provider runs in-process and sends no network requests.
const context = BACKGROUND_CONTEXT;
const results = [];

async function probe(guarded) {
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 100_000, maxTokens: 900 }] });
  let providerDispatches = 0;
  faux.setResponses([() => {
    providerDispatches += 1;
    return fauxAssistantMessage('Synthetic fallback summary.');
  }]);
  const baseModels = createModels();
  baseModels.setProvider(faux.provider);
  let fatal;
  let blockedDispatches = 0;
  // The production seam would be the final provider dispatch. This probe
  // guards both Models request entrypoints used by the built-in tasks.
  const models = new Proxy(baseModels, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'completeSimple' || property === 'streamSimple') {
        return (...args) => {
          if (guarded && fatal) {
            blockedDispatches += 1;
            throw fatal;
          }
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const reports = [];
  const registry = createRegistry();
  registry.install(defineExtension({
    name: 'research.compaction-failure',
    hooks: [hook(CompactionTask, {
      beforeCompact() {
        fatal = new Error('synthetic product compaction rejected');
        throw fatal;
      },
    })],
  }));
  const harness = await Harness.open(new MemoryStorage(), {
    models,
    registry,
    settings: {
      retry: { enabled: false },
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 150, backgroundTokens: 0 },
    },
    onReport: error => reports.push(String(error?.message ?? error)),
  }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  try {
    const originals = [];
    for (let i = 0; i < 4; i += 1) {
      const text = `Synthetic user ${i}: ${'x'.repeat(400)}`;
      originals.push(await root.commit(tx => tx.appendEntry(root.id, {
        kind: 'idream.replay',
        data: { messageId: `fixture-user-${i}`, sourceKind: 'replay' },
        model: [{ role: 'user', content: text, timestamp: 1 + i * 2 }],
      }), context));
      originals.push(await root.commit(tx => tx.appendEntry(root.id, {
        kind: 'idream.replay',
        data: { messageId: `fixture-character-${i}`, sourceKind: 'replay', speaker: { id: `character-${i % 2}` } },
        model: [fauxAssistantMessage(`Synthetic character ${i}: ${'y'.repeat(400)}`)],
      }), context));
    }
    const taskId = await root.compact('Keep synthetic source identity.', context);
    const task = await harness.waitForTask(taskId, context);
    const outcome = task.state.outcome;
    if (outcome.result?.submissionId !== undefined) {
      await (await harness.submission(outcome.result.submissionId, context)).wait(context);
    }
    const page = await root.entries({ order: 'ascending' }, 100, undefined, context);
    for (const original of originals) {
      assert.deepEqual(page.items.find(entry => entry.id === original.id), original);
    }
    const active = await root.context(context);
    assert.ok(reports.includes('synthetic product compaction rejected'));
    if (guarded) {
      assert.equal(providerDispatches, 0);
      assert.equal(blockedDispatches, 1);
      // A thrown phase is a framework fault, distinct from a task-declared
      // failed outcome. Both must prevent a summary from being published.
      assert.equal(outcome.status, 'faulted');
      assert.equal(page.items.some(entry => entry.kind === 'pi.compaction'), false);
    } else {
      assert.equal(providerDispatches, 1);
      assert.equal(outcome.status, 'completed');
      assert.equal(page.items.some(entry => entry.kind === 'pi.compaction'), true);
      assert.ok(!active.entries.some(entry => entry.id === originals[0].id));
    }
    results.push({ guarded, outcome: outcome.status, providerDispatches, blockedDispatches,
      originalEntries: originals.length, sourceIdentityAndBytesPreserved: true,
      oldestOriginalInActiveContext: active.entries.some(entry => entry.id === originals[0].id),
      hookErrorReported: true });
  } finally {
    await harness.close(context);
  }
}

await probe(false);
await probe(true);
process.stdout.write(JSON.stringify({
  runtime: `bun ${Bun.version}`, packages: '1.3.0', storage: 'MemoryStorage',
  realProviderRequests: 0, results,
}, null, 2) + '\n');
