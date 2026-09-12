/* eslint-disable @typescript-eslint/no-require-imports -- Node preloads this CommonJS module ahead of Next's dev runtime. */
const asyncHooks = require("node:async_hooks");

// SPEC: keep React's development-only async debug tracking bounded so `next dev`
// cannot die from `RangeError: Map maximum size exceeded` inside an async_hooks
// callback. React 19's RSC development runtime (compiled into
// next/dist/compiled/next-server/app-page*.runtime.dev.js) records every async
// resource in a `pendingOperations` Map and prunes it only from `destroy`, which
// Node emits for promises solely on garbage collection. A dev server that keeps
// rendering outruns GC until the Map reaches V8's element ceiling and `Map.set`
// throws from inside the hook, where no user code can catch it.
// INTENT: bound rather than disable. Ordinary sessions keep their full async debug
// info and only pathological churn loses async ancestry. React already tolerates
// ids it never recorded, because its hook may be enabled while promises are in
// flight: `before` and `promiseResolve` return on `void 0 === node` and `destroy`
// only deletes, so a skipped `init` is a state React supports.
// INTENT: upstream is unfixed — vercel/next.js#85666 is open, both candidate
// fixes (#91704, #96182) are unmerged, and next@16.3.5 ships a byte-identical
// hook, so upgrading Next does not remove the crash. Delete this once it lands.
// INVARIANT: React's Map only ever holds ids this module admitted, so the Map and
// `admitted` both stay at or below `limit`.
const configured = Number(process.env.IDREAM_REACT_ASYNC_DEBUG_LIMIT);
// A single request's async graph fits well inside 100k entries, while the cap
// holds the hook's retention to a few hundred MB instead of unbounded growth.
const limit = Number.isInteger(configured) && configured > 0 ? configured : 100_000;
const createHook = asyncHooks.createHook;

asyncHooks.createHook = function createBoundedHook(callbacks) {
  if (typeof callbacks?.init !== "function" || !callbacks.init.toString().includes("pendingOperations")) {
    return createHook(callbacks);
  }
  const admitted = new Set();
  return createHook({
    ...callbacks,
    init(asyncId, type, triggerAsyncId, resource) {
      if (admitted.size >= limit) return;
      admitted.add(asyncId);
      callbacks.init(asyncId, type, triggerAsyncId, resource);
    },
    destroy(asyncId) {
      if (!admitted.delete(asyncId)) return;
      callbacks.destroy?.(asyncId);
    },
  });
};
