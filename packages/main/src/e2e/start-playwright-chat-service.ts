import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import path from "node:path";
import pg from "pg";
import {
  assertPlaywrightChatDatabaseUrl,
  assertPlaywrightDatabaseUrl,
  resolvePlaywrightEnvironment,
  type ResolvedPlaywrightEnvironment,
} from "../../playwright-environment";
import {
  cleanupPlaywrightResources,
  createPlaywrightCleanupPlan,
  preparePlaywrightResources,
  type PlaywrightCleanupPlan,
} from "./playwright-cleanup";
import { writePlaywrightLifecycleReceipt } from "./playwright-lifecycle-receipt";
import {
  acquirePlaywrightWorkspaceLease,
  type PlaywrightWorkspaceLease,
} from "./playwright-workspace-lease";
import {
  playwrightChatOutcomeFailure,
  resolvePlaywrightShutdownSignal,
  type PlaywrightChatChildOutcome,
} from "./playwright-chat-service-outcome";

const mainDir = path.resolve(import.meta.dirname, "../..");
const chatDir = path.resolve(mainDir, "../chat");

async function preparePlaywrightAuthority(
  environment: ResolvedPlaywrightEnvironment,
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  const databaseURL = assertPlaywrightDatabaseUrl(environment.databaseURL);
  const chatDatabaseURL = assertPlaywrightChatDatabaseUrl(
    environment.chatDatabaseURL,
    databaseURL,
  );
  const database = new URL(databaseURL);
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  const superUser = decodeURIComponent(database.username);
  const superPassword = decodeURIComponent(database.password);
  if (!superUser) {
    throw new Error(
      "Playwright authority database URL must include its provisioning user",
    );
  }

  process.env.CHAT_TEST_DB = databaseName;
  process.env.CHAT_TEST_REQUIRE_PLAYWRIGHT = "1";
  process.env.PG_SUPER = superUser;
  process.env.PGHOST = database.hostname;
  process.env.PGPORT = database.port || "5432";
  process.env.PGPASSWORD = superPassword;
  process.env.SUPER_PASSWORD = superPassword;
  process.env.POSTGRES_PASSWORD = superPassword;

  const childEnv = {
    ...process.env,
    APP_ENV: "test",
    DB_PROVIDER: "postgresql",
    TEST_DATABASE_URL: databaseURL,
    DATABASE_URL: databaseURL,
    CHAT_DATABASE_URL: chatDatabaseURL,
  };
  await runPreparationCommand(
    "node",
    [
      "--input-type=module",
      "--eval",
      "import { provisionChatTestDb } from './test/provision.mjs'; provisionChatTestDb();",
    ],
    {
      cwd: chatDir,
      env: childEnv,
      signal,
    },
  );
  throwIfAborted(signal);
  await alignDeferrableAuthorityConstraints(databaseURL, signal);
  throwIfAborted(signal);
  await runPreparationCommand("npx", ["tsx", "prisma/seed.ts"], {
    cwd: mainDir,
    env: childEnv,
    signal,
  });
  throwIfAborted(signal);
  await runPreparationCommand("bun", ["run", "db:generate"], {
    cwd: chatDir,
    env: childEnv,
    signal,
  });
  throwIfAborted(signal);
}

async function alignDeferrableAuthorityConstraints(
  url: string,
  signal: AbortSignal,
) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
  });
  const abortConnection = () => {
    void client.end().catch(() => undefined);
  };
  signal.addEventListener("abort", abortConnection, { once: true });
  if (signal.aborted) abortConnection();
  try {
    throwIfAborted(signal);
    await client.connect();
    for (const constraint of [
      "character_serving_characterId_fkey",
      "character_serving_currentReleaseId_fkey",
      "character_serving_scheduledReleaseId_fkey",
    ]) {
      throwIfAborted(signal);
      await client.query(
        `ALTER TABLE "character_serving" ALTER CONSTRAINT ${quoteIdentifier(constraint)} DEFERRABLE INITIALLY IMMEDIATE`,
      );
    }
  } finally {
    signal.removeEventListener("abort", abortConnection);
    await client.end().catch(() => undefined);
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function startChatService() {
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: chatDir,
    env: process.env,
    stdio: "inherit",
  });
  const outcome = new Promise<PlaywrightChatChildOutcome>((resolve) => {
    child.once("error", (error) => {
      resolve({ code: 1, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      resolve({ code, signal, error: null });
    });
  });
  return { child, outcome };
}

async function cleanupAfterPreparationFailure(
  plan: PlaywrightCleanupPlan,
  workspaceLease: PlaywrightWorkspaceLease | null,
  preparationError: unknown,
) {
  let cleanupFailed = false;
  try {
    await cleanupPlaywrightResourcesWithRetries(plan);
  } catch (cleanupError) {
    cleanupFailed = true;
    process.stderr.write(
      `[playwright lifecycle] cleanup after preparation failure also failed: ${formatError(cleanupError)}\n`,
    );
  }
  try {
    await workspaceLease?.release();
  } catch (leaseError) {
    cleanupFailed = true;
    process.stderr.write(
      `[playwright lifecycle] workspace restoration after preparation failure also failed: ${formatError(leaseError)}\n`,
    );
  }
  try {
    await writePlaywrightLifecycleReceipt(plan, {
      status: "failed",
      phase: "preparation",
      message: cleanupFailed
        ? "authority preparation and cleanup both failed"
        : "authority preparation failed",
    });
  } catch (receiptError) {
    process.stderr.write(
      `[playwright lifecycle] could not persist preparation failure receipt: ${formatError(receiptError)}\n`,
    );
  }
  throw preparationError;
}

async function runPreparationCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
  },
) {
  throwIfAborted(options.signal);
  const detached = process.platform !== "win32";
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    detached,
  });
  let forcedKillTimer: NodeJS.Timeout | null = null;
  let abortRequested = false;
  const abortChild = () => {
    if (abortRequested) return;
    abortRequested = true;
    signalChild(child, "SIGTERM", detached);
    forcedKillTimer = setTimeout(() => {
      signalChild(child, "SIGKILL", detached);
    }, 3_000);
  };
  options.signal.addEventListener("abort", abortChild, { once: true });
  if (options.signal.aborted) abortChild();
  try {
    const outcome = await childOutcome(child);
    if (options.signal.aborted) throw abortedPreparationError();
    if (outcome.error) throw outcome.error;
    if (outcome.code !== 0 || outcome.signal) {
      throw new Error(
        `Preparation command "${command}" failed (${outcome.code ?? outcome.signal ?? "unknown"})`,
      );
    }
  } finally {
    options.signal.removeEventListener("abort", abortChild);
    if (forcedKillTimer) clearTimeout(forcedKillTimer);
  }
}

function childOutcome(child: ChildProcess) {
  return new Promise<PlaywrightChatChildOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: PlaywrightChatChildOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => {
      settle({ code: 1, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      settle({ code, signal, error: null });
    });
  });
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  detached: boolean,
) {
  if (!childIsRunning(child) || !child.pid) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The command may have exited between the liveness check and the signal.
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortedPreparationError();
}

function abortedPreparationError() {
  const error = new Error("Playwright preparation interrupted by shutdown");
  error.name = "AbortError";
  return error;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function childIsRunning(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}

async function stopChatService(
  child: ChildProcess,
  outcome: Promise<PlaywrightChatChildOutcome>,
  signal: NodeJS.Signals,
): Promise<PlaywrightChatChildOutcome> {
  if (childIsRunning(child)) child.kill(signal);
  const gracefulOutcome = await outcomeWithin(outcome, 5_000);
  if (gracefulOutcome) return gracefulOutcome;

  if (childIsRunning(child)) child.kill("SIGKILL");
  const forcedOutcome = await outcomeWithin(outcome, 2_000);
  return forcedOutcome
    ? {
        ...forcedOutcome,
        error:
          forcedOutcome.error ??
          new Error("Chat service required SIGKILL during Playwright teardown"),
      }
    : {
      code: 1,
      signal: "SIGKILL" as NodeJS.Signals,
      error: new Error("Chat service did not exit after SIGTERM and SIGKILL"),
    };
}

async function outcomeWithin(
  outcome: Promise<PlaywrightChatChildOutcome>,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      outcome,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const environment = resolvePlaywrightEnvironment(process.env);
const cleanupPlan = createPlaywrightCleanupPlan(environment);
const preparationAbortController = new AbortController();
let chatService: ReturnType<typeof startChatService> | null = null;
let workspaceLease: PlaywrightWorkspaceLease | null = null;
let shutdownSignal: NodeJS.Signals | null = null;
let finalization: Promise<never> | null = null;
let publishShutdownSignal: (signal: NodeJS.Signals) => void = () => undefined;
const shutdownSignalAuthority = new Promise<NodeJS.Signals>((resolve) => {
  publishShutdownSignal = resolve;
});

function requestShutdown(signal: NodeJS.Signals) {
  if (!shutdownSignal) {
    shutdownSignal = signal;
    publishShutdownSignal(signal);
  }
  preparationAbortController.abort();
  if (chatService) void finalize(shutdownSignal);
}

process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));

try {
  workspaceLease = await acquirePlaywrightWorkspaceLease(environment.runId);
  throwIfAborted(preparationAbortController.signal);
  await preparePlaywrightResources(cleanupPlan);
  throwIfAborted(preparationAbortController.signal);
  await preparePlaywrightAuthority(
    environment,
    preparationAbortController.signal,
  );
} catch (error) {
  await cleanupAfterPreparationFailure(cleanupPlan, workspaceLease, error);
}

if (shutdownSignal) await finalize(shutdownSignal);
chatService = startChatService();

function finalize(signal?: NodeJS.Signals): Promise<never> {
  if (finalization) return finalization;
  finalization = (async () => {
    const runningChatService = chatService;
    const outcome = runningChatService
      ? signal
        ? await stopChatService(
            runningChatService.child,
            runningChatService.outcome,
            signal,
          )
        : await runningChatService.outcome
      : null;
    let failure: unknown = playwrightChatOutcomeFailure(
      outcome,
      signal,
    );
    if (outcome?.error) {
      process.stderr.write(
        `[playwright lifecycle] Chat service failed: ${formatError(outcome.error)}\n`,
      );
    }
    try {
      await cleanupPlaywrightResourcesWithRetries(cleanupPlan);
    } catch (error) {
      process.stderr.write(
        `[playwright lifecycle] final cleanup failed: ${formatError(error)}\n`,
      );
      failure = failure
        ? new AggregateError([failure, error], "service and cleanup failed")
        : error;
    }
    try {
      await workspaceLease?.release();
      workspaceLease = null;
    } catch (error) {
      process.stderr.write(
        `[playwright lifecycle] workspace restoration failed: ${formatError(error)}\n`,
      );
      failure = failure
        ? new AggregateError(
            [failure, error],
            "service cleanup and workspace restoration failed",
          )
        : error;
    }
    try {
      await writePlaywrightLifecycleReceipt(cleanupPlan, {
        status: failure ? "failed" : "passed",
        phase: signal ? "teardown" : "service",
        message: failure ? "managed service shutdown or cleanup failed" : null,
      });
    } catch (error) {
      process.stderr.write(
        `[playwright lifecycle] final receipt write failed: ${formatError(error)}\n`,
      );
      failure = failure
        ? new AggregateError([failure, error], "lifecycle receipt also failed")
        : error;
    }
    process.exit(failure ? 1 : 0);
  })();
  return finalization;
}

async function cleanupPlaywrightResourcesWithRetries(
  plan: PlaywrightCleanupPlan,
) {
  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await cleanupPlaywrightResources(plan);
      return;
    } catch (error) {
      failures.push(error);
      if (attempt < 3) await delay(attempt * 250);
    }
  }
  throw new AggregateError(failures, "Playwright cleanup retries exhausted");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const terminalOutcome = await chatService.outcome;
const terminalSignal = await resolvePlaywrightShutdownSignal(
  terminalOutcome,
  shutdownSignal,
  shutdownSignalAuthority,
);
await finalize(terminalSignal);
