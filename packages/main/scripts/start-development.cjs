/* eslint-disable @typescript-eslint/no-require-imports -- PM2 executes this CommonJS bootstrap directly. */
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const prismaCli = require.resolve("prisma/build/index.js", {
  paths: [packageRoot],
});
const nextCli = require.resolve("next/dist/bin/next", {
  paths: [packageRoot],
});

async function runDevelopment(options = {}) {
  const runSync = options.spawnSync ?? spawnSync;
  const runChild = options.spawn ?? spawn;
  const runtime = options.process ?? process;
  const generated = runSync(runtime.execPath, [prismaCli, "generate"], {
    cwd: packageRoot,
    env: runtime.env,
    stdio: "inherit",
  });
  if (generated.error) throw generated.error;
  if (generated.status !== 0) return generated.status ?? 1;

  const playwrightOwnsNext = Boolean(
    runtime.env.PW_RUN_ID &&
      runtime.env.IDREAM_NEXT_DIST_DIR &&
      runtime.env.IDREAM_NEXT_TSCONFIG,
  );
  // INVARIANT: production builds own .next. Ordinary source development uses
  // .next-development, while Playwright keeps the stricter run-owned paths
  // supplied by its environment authority. next.config.ts validates those
  // three Playwright values together before Next writes anything.
  if (!playwrightOwnsNext) {
    runtime.env.IDREAM_NEXT_DEVELOPMENT = "1";
    runtime.env.IDREAM_NEXT_DIST_DIR = ".next-development";
  }

  // INVARIANT: Next starts only after Prisma Client matches the checked-out
  // schema, and this wrapper remains PM2's parent authority until the exact CLI
  // exits. Requiring Next's CLI lets its asynchronous dev bootstrap outlive this
  // process during a restart, leaving an unowned listener on the product port.
  const child = runChild(
    runtime.execPath,
    [nextCli, "dev", ...runtime.argv.slice(2)],
    {
      cwd: packageRoot,
      env: runtime.env,
      stdio: "inherit",
    },
  );
  return waitForChild(child, runtime);
}

function waitForChild(child, runtime) {
  return new Promise((resolve) => {
    let settled = false;
    let forwardedSignal = null;
    const signals = ["SIGINT", "SIGTERM"];
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        runtime.off(signal, handler);
      }
    };
    const settle = (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(status);
    };

    for (const signal of signals) {
      const handler = () => {
        forwardedSignal = signal;
        try {
          child.kill(signal);
        } catch {
          settle(1);
        }
      };
      handlers.set(signal, handler);
      runtime.once(signal, handler);
    }

    child.once("error", () => settle(1));
    child.once("exit", (code, signal) => {
      if (forwardedSignal && signal === forwardedSignal) {
        settle(0);
        return;
      }
      settle(Number.isInteger(code) ? code : 1);
    });
  });
}

if (require.main === module) {
  void runDevelopment()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  nextCli,
  packageRoot,
  prismaCli,
  runDevelopment,
};
