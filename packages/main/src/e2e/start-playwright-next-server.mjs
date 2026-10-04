import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mainPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * @param {string} name
 * @param {string} port
 * @param {{ env?: NodeJS.ProcessEnv, spawn?: (command: string, args: string[], options: import("node:child_process").SpawnOptions) => import("node:child_process").ChildProcess, signals?: import("node:events").EventEmitter }} [options]
 */
export async function runPlaywrightNextServer(name, port, options = {}) {
  const env = options.env ?? process.env;
  const runId = env.PW_RUN_ID;
  if (!["main", "admin"].includes(name) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("Usage: node start-playwright-next-server.mjs <main|admin> <port>");
  }
  if (
    env.APP_ENV !== "test" || env.PLAYWRIGHT_E2E !== "1" ||
    !runId || !/^[a-f0-9]{8}$/.test(runId) || !env.IDREAM_SOURCE_REVISION ||
    env.IDREAM_NEXT_DIST_DIR !== `.next/playwright-${name}-${port}-${runId}` ||
    env.IDREAM_NEXT_TSCONFIG !== `.next/playwright-config-${name}-${port}-${runId}/tsconfig.json`
  ) {
    throw new Error("Playwright Next build/start requires this test run's source, distDir, and tsconfig authority");
  }

  const cwd = path.resolve(mainPackageRoot, `../${name}`);
  const nextCli = createRequire(path.join(cwd, "package.json")).resolve("next/dist/bin/next");
  // Next compiles optimized React bundles; product dependencies remain test-owned.
  const childEnv = { ...env, NODE_ENV: "production" };
  delete childEnv.IDREAM_NEXT_DEVELOPMENT;
  const spawnChild = options.spawn ?? spawn;
  const signals = options.signals ?? process;
  let child = null;
  let shutdownSignal = null;
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => {
      shutdownSignal ??= signal;
      child?.kill(shutdownSignal);
    };
    signals.on(signal, handler);
    return [signal, handler];
  });

  function run(args) {
    return new Promise((resolve, reject) => {
      child = spawnChild("node", [nextCli, ...args], { cwd, env: childEnv, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        child = null;
        resolve(shutdownSignal && signal === shutdownSignal ? 0 : code ?? 1);
      });
    });
  }

  try {
    // Compile all routes before Playwright's readiness probe can see a listener.
    // Never fall back to dev or to an older build when compilation fails/stops.
    const built = await run(["build"]);
    if (built !== 0 || shutdownSignal) return built;
    return await run(["start", "--port", port]);
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    process.stderr.write("Usage: node start-playwright-next-server.mjs <main|admin> <port>\n");
    process.exitCode = 1;
  } else {
    void runPlaywrightNextServer(process.argv[2], process.argv[3])
      .then((code) => { process.exitCode = code; })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
