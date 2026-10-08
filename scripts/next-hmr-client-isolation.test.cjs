const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const test = require("node:test");

const requireNext = createRequire(path.resolve(__dirname, "../packages/main/package.json"));
const { WebpackHotMiddleware } = requireNext("next/dist/server/dev/hot-middleware.js");
const { HMR_MESSAGE_SENT_TO_BROWSER: HMR } = requireNext("next/dist/server/dev/hot-reloader-types.js");
const versionInfo = { installed: requireNext("next/package.json").version, staleness: "fresh" };
const devToolsConfig = { position: "bottom-left" };

function hook() {
  const callbacks = [];
  return {
    tap(_name, callback) { callbacks.push(callback); },
    call(value) { for (const callback of callbacks) callback(value); },
  };
}

function fixture(t) {
  const compilers = Array.from({ length: 3 }, () => ({ hooks: { invalid: hook(), done: hook() } }));
  const middleware = new WebpackHotMiddleware(compilers, versionInfo, "/devtools", { cacheComponents: false }, devToolsConfig);
  t.after(() => middleware.close());
  return { middleware, compilers };
}

function stats(hash, { errors = [], warnings = [], isMiddleware = false } = {}) {
  return {
    hasErrors: () => errors.length > 0,
    toJson: () => ({ hash, errors, warnings }),
    compilation: { entrypoints: new Map(isMiddleware ? [["middleware", {}]] : []) },
  };
}

function socket() {
  return {
    messages: [],
    listeners: new Map(),
    terminations: 0,
    send(data) { this.messages.push(JSON.parse(data)); },
    addEventListener(event, callback) { this.listeners.set(event, callback); },
    terminate() { this.terminations += 1; },
  };
}

test("a new HMR connection receives the current SYNC without resynchronizing an existing connection", (t) => {
  const { middleware, compilers } = fixture(t);
  compilers[0].hooks.done.call(stats("a"));
  const a = socket();
  middleware.onHMR(a, "html-a");
  assert.deepEqual(a.messages.map(({ type, hash }) => ({ type, hash })), [{ type: HMR.SYNC, hash: "a" }]);

  compilers[0].hooks.done.call(stats("b"));
  const expectedA = [{ type: HMR.SYNC, hash: "a" }, { type: HMR.BUILT, hash: "b" }];
  assert.deepEqual(a.messages.map(({ type, hash }) => ({ type, hash })), expectedA);

  const b = socket();
  middleware.onHMR(b, "html-b");
  assert.deepEqual(b.messages.map(({ type, hash }) => ({ type, hash })), [{ type: HMR.SYNC, hash: "b" }]);
  // A already received BUILT b; another tab connecting must not reset its HMR baseline.
  assert.deepEqual(a.messages.map(({ type, hash }) => ({ type, hash })), expectedA,
    "B's initial SYNC must be sent only to B");
});

test("initial SYNC retains server errors and middleware errors/warnings with its metadata", (t) => {
  const { middleware, compilers } = fixture(t);
  const serverError = { message: "server compilation failed" };
  const serverWarning = { message: "server warning" };
  const middlewareError = { message: "middleware compilation failed" };
  const middlewareWarning = { message: "middleware warning" };
  compilers[1].hooks.done.call(stats("server", { errors: [serverError], warnings: [serverWarning] }));
  compilers[0].hooks.done.call(stats("client", { warnings: [{ message: "client warning" }] }));
  compilers[2].hooks.done.call(stats("middleware", { isMiddleware: true, errors: [middlewareError], warnings: [middlewareWarning] }));

  const client = socket();
  middleware.onHMR(client, null);
  assert.equal(client.messages.length, 1);
  const sync = client.messages[0];
  assert.equal(sync.type, HMR.SYNC);
  assert.equal(sync.hash, "server");
  assert.deepEqual(sync.errors, [serverError, middlewareError]);
  assert.deepEqual(sync.warnings, [serverWarning, middlewareWarning]);
  assert.deepEqual(sync.versionInfo, versionInfo);
  assert.deepEqual(sync.debug, { devtoolsFrontendUrl: "/devtools" });
  assert.deepEqual(sync.devToolsConfig, devToolsConfig);
});

test("BUILDING and BUILT remain broadcasts to clients with and without an HTML request ID", (t) => {
  const { middleware, compilers } = fixture(t);
  const legacy = socket(), app = socket();
  middleware.onHMR(legacy, null);
  middleware.onHMR(app, "html-app");
  const errors = [{ message: "client compilation failed" }], warnings = [{ message: "client warning" }];
  compilers[0].hooks.invalid.call();
  compilers[0].hooks.done.call(stats("b", { errors, warnings }));
  const expected = [{ type: HMR.BUILDING }, { type: HMR.BUILT, hash: "b", errors, warnings }];
  assert.deepEqual(legacy.messages, expected);
  assert.deepEqual(app.messages, expected);

  legacy.listeners.get("close")();
  compilers[0].hooks.done.call(stats("c"));
  assert.equal(legacy.messages.length, 2, "closed sockets must stop receiving broadcasts");
  assert.deepEqual(app.messages.at(-1), { type: HMR.BUILT, hash: "c", errors: [], warnings: [] });
});

test("closed middleware terminates existing sockets once and ignores later connections and compiler events", (t) => {
  const { middleware, compilers } = fixture(t);
  const legacy = socket(), app = socket(), late = socket();
  middleware.onHMR(legacy, null);
  middleware.onHMR(app, "html-app");
  middleware.close();
  middleware.close();
  assert.equal(legacy.terminations, 1);
  assert.equal(app.terminations, 1);
  assert.equal(middleware.hasClients(), false);
  assert.equal(middleware.getClientCount(), 0);

  middleware.onHMR(late, "html-late");
  for (const compiler of compilers) {
    compiler.hooks.invalid.call();
    compiler.hooks.done.call(stats("closed", { errors: [{ message: "late compiler error" }], isMiddleware: true }));
  }
  middleware.publishStats(stats("closed"));
  middleware.publish({ type: HMR.BUILDING });
  middleware.publishToClient(app, { type: HMR.BUILDING });
  assert.deepEqual(legacy.messages, []);
  assert.deepEqual(app.messages, []);
  assert.deepEqual(late.messages, []);
  assert.equal(late.listeners.size, 0);
  assert.equal(late.terminations, 0);
  assert.equal(middleware.getClientCount(), 0);
});
