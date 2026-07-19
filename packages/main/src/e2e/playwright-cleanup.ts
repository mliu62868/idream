import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import IORedis from "ioredis";
import pg from "pg";
import {
  assertPlaywrightBlobRoot,
  assertPlaywrightDatabaseUrl,
  assertPlaywrightRedisUrl,
  type ResolvedPlaywrightEnvironment,
} from "../../playwright-environment";

const MAIN_PACKAGE_ROOT = process.cwd().endsWith(path.join("packages", "main"))
  ? process.cwd()
  : path.resolve(process.cwd(), "packages/main");
const ADMIN_PACKAGE_ROOT = path.resolve(MAIN_PACKAGE_ROOT, "../admin");

export type PlaywrightCleanupPlan = {
  readonly databaseURL: string;
  readonly ownsDatabase: boolean;
  readonly redisURL: string;
  readonly bullmqPrefix: string;
  readonly chatFsRoot: string;
  readonly blobRoot: string;
  readonly mainPort: string;
  readonly adminPort: string;
  readonly runId: string;
  readonly remoteDatabaseAuthority: {
    readonly allowReset: boolean;
    readonly ci: boolean;
    readonly confirmedDatabaseName: string | null;
  };
  readonly mainDistDir: string;
  readonly adminDistDir: string;
  readonly mainTsconfigPath: string;
  readonly adminTsconfigPath: string;
  readonly lifecycleReceiptPath: string;
};

export function createPlaywrightCleanupPlan(
  environment: ResolvedPlaywrightEnvironment,
): PlaywrightCleanupPlan {
  return {
    databaseURL: environment.databaseURL,
    ownsDatabase: environment.ownsDatabase,
    redisURL: environment.redisURL,
    bullmqPrefix: environment.bullmqPrefix,
    chatFsRoot: environment.chatFsRoot,
    blobRoot: environment.blobRoot,
    mainPort: environment.mainPort,
    adminPort: environment.adminPort,
    runId: environment.runId,
    remoteDatabaseAuthority: environment.remoteDatabaseAuthority,
    mainDistDir: environment.mainDistDir,
    adminDistDir: environment.adminDistDir,
    mainTsconfigPath: environment.mainTsconfigPath,
    adminTsconfigPath: environment.adminTsconfigPath,
    lifecycleReceiptPath: environment.lifecycleReceiptPath,
  };
}

export function assertPlaywrightCleanupPlan(
  plan: PlaywrightCleanupPlan,
): PlaywrightCleanupPlan {
  const databaseURL = assertPlaywrightDatabaseUrl(plan.databaseURL);
  const redisURL = assertPlaywrightRedisUrl(plan.redisURL);
  if (!/^\d+$/.test(plan.mainPort) || !/^\d+$/.test(plan.adminPort)) {
    throw new Error("Playwright cleanup ports must be numeric");
  }
  if (!/^[a-f0-9]{8}$/.test(plan.runId)) {
    throw new Error("Playwright cleanup run id is invalid");
  }
  const expectedPrefix = `idream:e2e:${plan.mainPort}:${plan.runId}`;
  if (plan.bullmqPrefix !== expectedPrefix) {
    throw new Error("Playwright cleanup Redis prefix does not match this run");
  }
  const expectedMainDistDir =
    `.next/playwright-main-${plan.mainPort}-${plan.runId}`;
  const expectedAdminDistDir =
    `.next/playwright-admin-${plan.adminPort}-${plan.runId}`;
  const expectedMainTsconfigPath =
    `.next/playwright-config-main-${plan.mainPort}-${plan.runId}/tsconfig.json`;
  const expectedAdminTsconfigPath =
    `.next/playwright-config-admin-${plan.adminPort}-${plan.runId}/tsconfig.json`;
  const expectedLifecycleReceiptPath =
    `.next/playwright-lifecycle-main-${plan.mainPort}-${plan.runId}/cleanup.json`;
  if (
    plan.mainDistDir !== expectedMainDistDir ||
    plan.adminDistDir !== expectedAdminDistDir ||
    plan.mainTsconfigPath !== expectedMainTsconfigPath ||
    plan.adminTsconfigPath !== expectedAdminTsconfigPath ||
    plan.lifecycleReceiptPath !== expectedLifecycleReceiptPath
  ) {
    throw new Error(
      "Playwright cleanup Next.js resources do not match this run",
    );
  }
  const isolationHash = createHash("sha256")
    .update(`${databaseURL}/${plan.mainPort}/${plan.runId}`)
    .digest("hex")
    .slice(0, 12);
  const expectedChatRoot = path.resolve(
    MAIN_PACKAGE_ROOT,
    "data",
    `playwright-chat-${plan.mainPort}-${isolationHash}`,
  );
  if (path.resolve(plan.chatFsRoot) !== expectedChatRoot) {
    throw new Error(
      "Playwright cleanup chat filesystem root does not match this run",
    );
  }
  const expectedBlobRoot = assertPlaywrightBlobRoot(
    path.resolve(
      tmpdir(),
      "idream-playwright-blobs",
      `playwright-blob-${plan.mainPort}-${plan.runId}-${isolationHash}`,
    ),
  );
  if (path.resolve(plan.blobRoot) !== expectedBlobRoot) {
    throw new Error(
      "Playwright cleanup blob root does not match this run",
    );
  }
  if (plan.ownsDatabase) {
    const parsedDatabase = new URL(databaseURL);
    const databaseName = decodeURIComponent(
      parsedDatabase.pathname.replace(/^\//, ""),
    );
    if (!databaseName.endsWith(`_playwright_${plan.mainPort}_${plan.runId}`)) {
      throw new Error("Playwright-owned database does not match this run");
    }
    const hostname = parsedDatabase.hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      const authority = plan.remoteDatabaseAuthority;
      if (
        !authority.allowReset ||
        !authority.ci ||
        authority.confirmedDatabaseName !== databaseName
      ) {
        throw new Error(
          `Refusing remote Playwright database cleanup for "${databaseName}" without CI=true, CHAT_TEST_ALLOW_REMOTE_RESET=1, and exact CHAT_TEST_RESET_CONFIRM`,
        );
      }
    }
  }
  return {
    ...plan,
    databaseURL,
    redisURL,
  };
}

export async function cleanupPlaywrightResources(
  unsafePlan: PlaywrightCleanupPlan,
) {
  const plan = assertPlaywrightCleanupPlan(unsafePlan);
  const cleanupResults = await Promise.allSettled([
    ...(plan.ownsDatabase ? [dropOwnedDatabase(plan.databaseURL)] : []),
    cleanupRedis(plan.redisURL, plan.bullmqPrefix),
    rm(plan.chatFsRoot, { recursive: true, force: true }),
    rm(plan.blobRoot, { recursive: true, force: true }),
    rm(path.resolve(MAIN_PACKAGE_ROOT, plan.mainDistDir), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(ADMIN_PACKAGE_ROOT, plan.adminDistDir), {
      recursive: true,
      force: true,
    }),
    rm(
      path.dirname(path.resolve(MAIN_PACKAGE_ROOT, plan.mainTsconfigPath)),
      { recursive: true, force: true },
    ),
    rm(
      path.dirname(path.resolve(ADMIN_PACKAGE_ROOT, plan.adminTsconfigPath)),
      { recursive: true, force: true },
    ),
  ]);
  const failures = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Playwright resource cleanup failed");
  }
}

export async function preparePlaywrightResources(
  unsafePlan: PlaywrightCleanupPlan,
) {
  const plan = assertPlaywrightCleanupPlan(unsafePlan);
  const prepareResults = await Promise.allSettled([
    cleanupRedis(plan.redisURL, plan.bullmqPrefix),
    rm(plan.chatFsRoot, { recursive: true, force: true }),
    rm(plan.blobRoot, { recursive: true, force: true }),
    rm(path.resolve(MAIN_PACKAGE_ROOT, plan.mainDistDir), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(ADMIN_PACKAGE_ROOT, plan.adminDistDir), {
      recursive: true,
      force: true,
    }),
    rm(
      path.dirname(path.resolve(MAIN_PACKAGE_ROOT, plan.mainTsconfigPath)),
      { recursive: true, force: true },
    ),
    rm(
      path.dirname(path.resolve(ADMIN_PACKAGE_ROOT, plan.adminTsconfigPath)),
      { recursive: true, force: true },
    ),
    rm(
      path.dirname(path.resolve(MAIN_PACKAGE_ROOT, plan.lifecycleReceiptPath)),
      { recursive: true, force: true },
    ),
  ]);
  const failures = prepareResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Playwright resource preparation failed");
  }
  await Promise.all([
    mkdir(plan.chatFsRoot, { recursive: true }),
    mkdir(plan.blobRoot, { recursive: true }),
    writeIsolatedTsconfig(MAIN_PACKAGE_ROOT, plan.mainTsconfigPath),
    writeIsolatedTsconfig(ADMIN_PACKAGE_ROOT, plan.adminTsconfigPath),
  ]);
}

export async function assertPlaywrightBlobRootRemoved(
  unsafePlan: PlaywrightCleanupPlan,
) {
  const plan = assertPlaywrightCleanupPlan(unsafePlan);
  try {
    await access(plan.blobRoot);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  throw new Error(
    `Playwright run-owned blob root still exists after cleanup: ${plan.blobRoot}`,
  );
}

async function writeIsolatedTsconfig(
  packageRoot: string,
  relativeTsconfigPath: string,
) {
  const absolutePath = path.resolve(packageRoot, relativeTsconfigPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify({ extends: "../../tsconfig.json" }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function cleanupRedis(redisURL: string, bullmqPrefix: string) {
  const redis = new IORedis(redisURL, {
    commandTimeout: 3_000,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${bullmqPrefix}:*`,
        "COUNT",
        1_000,
      );
      cursor = nextCursor;
      if (keys.length > 0) await redis.unlink(...keys);
    } while (cursor !== "0");
  } finally {
    redis.disconnect(false);
  }
}

async function dropOwnedDatabase(databaseURL: string) {
  const parsed = new URL(assertPlaywrightDatabaseUrl(databaseURL));
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  parsed.pathname = "/postgres";
  parsed.searchParams.delete("schema");
  const client = new pg.Client({
    connectionString: parsed.toString(),
    application_name: "idream-playwright-cleanup",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
  });
  await client.connect();
  try {
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
  } finally {
    await client.end();
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function isMissingPathError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
