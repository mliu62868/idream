/* eslint-disable @typescript-eslint/no-require-imports -- This unit test exercises the CommonJS preload Node loads for the dev servers. */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const preload = path.resolve(__dirname, "bound-react-async-debug.cjs");

// Mirrors the shape of React's development async debug hook: a `pendingOperations`
// Map filled from `init`, read defensively everywhere else, pruned only on
// `destroy`. A second, unmarked hook proves unrelated instrumentation is untouched.
const program = `
  const hooks = require("node:async_hooks");
  const pendingOperations = new Map();
  let unmarked = 0;
  hooks.createHook({
    init(asyncId) { pendingOperations.set(asyncId, { tag: 3 }); },
    before(asyncId) { const node = pendingOperations.get(asyncId); if (node === undefined) return; node.tag = 4; },
    promiseResolve(asyncId) { const node = pendingOperations.get(asyncId); if (node === undefined) return; node.tag = 2; },
    destroy(asyncId) { pendingOperations.delete(asyncId); },
  }).enable();
  hooks.createHook({ init() { unmarked += 1; } }).enable();
  (async () => {
    for (let index = 0; index < 5000; index += 1) await Promise.resolve();
    process.stdout.write(JSON.stringify({ tracked: pendingOperations.size, unmarked }));
    process.exit(0);
  })();
`;

function run(options) {
  const output = execFileSync(process.execPath, [...options.node, "-e", program], {
    env: { ...process.env, IDREAM_REACT_ASYNC_DEBUG_LIMIT: "32" },
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("the preload caps React's async debug map and leaves other instrumentation alone", () => {
  const bounded = run({ node: ["--require", preload] });
  assert.ok(bounded.tracked <= 32, `Tracked ${bounded.tracked} operations above the limit`);
  assert.ok(bounded.unmarked >= 5000, `Unmarked hook only saw ${bounded.unmarked} operations`);
});

test("the same workload overruns the limit without the preload", () => {
  const unbounded = run({ node: [] });
  assert.ok(unbounded.tracked > 32, `Workload retained only ${unbounded.tracked} operations`);
});
