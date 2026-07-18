import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

type PlaywrightEnvironmentInput = Readonly<Record<string, string | undefined>>;

export type ResolvedPlaywrightEnvironment = {
  readonly mainBaseURL: string;
  readonly mainPort: string;
  readonly adminBaseURL: string;
  readonly adminPort: string;
  readonly pipelineBaseURL: string;
  readonly pipelinePort: string;
  readonly chatBaseURL: string;
  readonly chatPort: string;
  readonly databaseURL: string;
  readonly chatDatabaseURL: string;
  readonly redisURL: string;
  readonly bullmqPrefix: string;
  readonly chatFsRoot: string;
  readonly runId: string;
  readonly ownsDatabase: boolean;
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
  readonly serviceEnv: Readonly<Record<string, string>>;
};

export type ManagedPlaywrightWebServer = {
  readonly command: string;
  readonly url?: string;
  readonly reuseExistingServer: false;
  readonly timeout: number;
  readonly env: Readonly<Record<string, string>>;
  readonly wait?: {
    readonly stdout?: RegExp;
    readonly stderr?: RegExp;
  };
  readonly gracefulShutdown?: {
    readonly signal: "SIGINT" | "SIGTERM";
    readonly timeout: number;
  };
};

const TEST_DATABASE_TOKEN = /(^|[_-])test([_-]|$)/i;
const PLAYWRIGHT_DATABASE_TOKEN = /(^|[_-])playwright([_-]|$)/i;
const CHAT_SERVICE_PASSWORD = "chat_service_change_me";
const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5433/idream_test";

export function resolvePlaywrightEnvironment(
  input: PlaywrightEnvironmentInput = process.env,
): ResolvedPlaywrightEnvironment {
  if (input.PW_WEBSERVER !== undefined && input.PW_WEBSERVER !== "1") {
    throw new Error(
      "Playwright E2E always manages isolated Main, Admin, Chat, and fixture servers; PW_WEBSERVER must be 1 or unset",
    );
  }
  if (input.PW_CHAT_SERVICE_URL !== undefined) {
    throw new Error(
      "PW_CHAT_SERVICE_URL must not be set; the Playwright chat service URL is derived from PW_BASE_URL",
    );
  }
  if (input.PW_CHAT_DATABASE_URL !== undefined) {
    throw new Error(
      "PW_CHAT_DATABASE_URL must not be set; the Playwright chat database is derived from PW_DATABASE_URL",
    );
  }

  const mainBaseURL = loopbackBaseURL(
    input.PW_BASE_URL ?? "http://127.0.0.1:3000",
    "PW_BASE_URL",
  );
  const mainPort = new URL(mainBaseURL).port;
  const runId = playwrightRunId(input.PW_RUN_ID);
  const defaultAdminURL = offsetLoopbackURL(mainBaseURL, 1, "Playwright Admin");
  const adminBaseURL = loopbackBaseURL(
    input.PW_ADMIN_BASE_URL ?? defaultAdminURL,
    "PW_ADMIN_BASE_URL",
  );
  const adminPort = new URL(adminBaseURL).port;
  const pipelineBaseURL = offsetLoopbackURL(
    mainBaseURL,
    2,
    "Playwright pipeline fixture",
  );
  const pipelinePort = new URL(pipelineBaseURL).port;
  const chatBaseURL = offsetLoopbackURL(
    mainBaseURL,
    3,
    "Playwright Chat service",
  );
  const chatPort = new URL(chatBaseURL).port;
  const ports = [mainPort, adminPort, pipelinePort, chatPort];
  if (new Set(ports).size !== ports.length) {
    throw new Error(
      "Playwright Main, Admin, pipeline, and Chat ports must be distinct",
    );
  }

  // PW_DATABASE_URL selects the PostgreSQL authority, never a database that
  // multiple runs may share. Every Playwright run owns a derived database.
  const ownsDatabase = true;
  const databaseURL = derivedPlaywrightDatabaseUrl(
    input.PW_DATABASE_URL ??
      input.TEST_DATABASE_URL ??
      DEFAULT_TEST_DATABASE_URL,
    mainPort,
    runId,
  );
  const chatDatabaseURL = derivedPlaywrightChatDatabaseUrl(databaseURL);
  const redisURL = assertPlaywrightRedisUrl(
    input.PW_REDIS_URL ?? "redis://127.0.0.1:6379/14",
  );
  const bullmqPrefix = `idream:e2e:${mainPort}:${runId}`;
  const isolationHash = createHash("sha256")
    .update(`${databaseURL}/${mainPort}/${runId}`)
    .digest("hex")
    .slice(0, 12);
  const chatFsRoot = path.resolve(
    mainPackageRoot(),
    "data",
    `playwright-chat-${mainPort}-${isolationHash}`,
  );
  const bffSecret = `playwright-bff-${isolationHash}`;
  const internalToken = `playwright-internal-${isolationHash}`;
  const mainDistDir = `.next/playwright-main-${mainPort}-${runId}`;
  const adminDistDir = `.next/playwright-admin-${adminPort}-${runId}`;
  const mainTsconfigPath =
    `.next/playwright-config-main-${mainPort}-${runId}/tsconfig.json`;
  const adminTsconfigPath =
    `.next/playwright-config-admin-${adminPort}-${runId}/tsconfig.json`;
  const lifecycleReceiptPath =
    `.next/playwright-lifecycle-main-${mainPort}-${runId}/cleanup.json`;
  const remoteDatabaseAuthority = {
    allowReset: input.CHAT_TEST_ALLOW_REMOTE_RESET === "1",
    ci: input.CI === "true",
    confirmedDatabaseName: input.CHAT_TEST_RESET_CONFIRM ?? null,
  } as const;
  const serviceEnv = {
    APP_ENV: "test",
    PLAYWRIGHT_E2E: "1",
    PW_RUN_ID: runId,
    DB_PROVIDER: "postgresql",
    TEST_DATABASE_URL: databaseURL,
    DATABASE_URL: databaseURL,
    REDIS_URL: redisURL,
    BULLMQ_PREFIX: bullmqPrefix,
    CHAT_PROVIDER: input.PW_CHAT_PROVIDER ?? "mock",
    CHAT_MODEL_PROVIDER: input.PW_CHAT_PROVIDER ?? "mock",
    CHAT_SERVICE_URL: chatBaseURL,
    CHAT_DATABASE_URL: chatDatabaseURL,
    CHAT_REDIS_URL: redisURL,
    CHAT_FS_ROOT: chatFsRoot,
    CHAT_PORT: chatPort,
    CHAT_BFF_SIGNING_SECRET: bffSecret,
    INTERNAL_TOKEN: internalToken,
    MAIN_WEB_URL: mainBaseURL,
    CHAT_TEST_DB: databaseNameFromUrl(new URL(databaseURL)),
    CHAT_TEST_REQUIRE_PLAYWRIGHT: "1",
    CHAT_SERVICE_PASSWORD,
    IMAGE_PROVIDER: input.PW_IMAGE_PROVIDER ?? "pipeline",
    PIPELINE_API_URL: pipelineBaseURL,
    VIDEO_PROVIDER: input.PW_VIDEO_PROVIDER ?? "mock",
    VOICE_PROVIDER: input.PW_VOICE_PROVIDER ?? "mock",
    MODERATION_PROVIDER: input.PW_MODERATION_PROVIDER ?? "mock",
    PAYMENT_PROVIDER: input.PW_PAYMENT_PROVIDER ?? "mock",
    BLOB_PROVIDER: input.PW_BLOB_PROVIDER ?? "mock",
    AGE_VERIFICATION_PROVIDER: input.PW_AGE_VERIFICATION_PROVIDER ?? "mock",
    NEXT_PUBLIC_SITE_AFFILIATE_URL: "",
    NEXT_PUBLIC_SITE_DISCORD_URL: "",
    NEXT_PUBLIC_SITE_HELP_CENTER_URL: "",
    NEXT_PUBLIC_SITE_LEGAL_NAME: "",
    NEXT_PUBLIC_SITE_REDDIT_URL: "",
    NEXT_PUBLIC_SITE_SUPPORT_EMAIL: "",
    NEXT_PUBLIC_SITE_X_URL: "",
  } as const;

  return {
    mainBaseURL,
    mainPort,
    adminBaseURL,
    adminPort,
    pipelineBaseURL,
    pipelinePort,
    chatBaseURL,
    chatPort,
    databaseURL,
    chatDatabaseURL,
    redisURL,
    bullmqPrefix,
    chatFsRoot,
    runId,
    ownsDatabase,
    remoteDatabaseAuthority,
    mainDistDir,
    adminDistDir,
    mainTsconfigPath,
    adminTsconfigPath,
    lifecycleReceiptPath,
    serviceEnv,
  };
}

export function managedPlaywrightWebServers(
  environment: ResolvedPlaywrightEnvironment,
): [
  ManagedPlaywrightWebServer,
  ManagedPlaywrightWebServer,
  ManagedPlaywrightWebServer,
  ManagedPlaywrightWebServer,
  ManagedPlaywrightWebServer,
] {
  return [
    {
      command: "bun src/e2e/start-playwright-chat-service.ts",
      url: `${environment.chatBaseURL}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: {
        signal: "SIGTERM",
        timeout: 30_000,
      },
      env: {
        ...environment.serviceEnv,
        DATABASE_URL: environment.chatDatabaseURL,
        CHAT_DATABASE_URL: environment.chatDatabaseURL,
        CHAT_PORT: environment.chatPort,
        CHAT_SERVICE_URL: environment.chatBaseURL,
        MAIN_WEB_URL: environment.mainBaseURL,
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `bun run dev -- --port ${environment.mainPort}`,
      url: environment.mainBaseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...environment.serviceEnv,
        BETTER_AUTH_URL: environment.mainBaseURL,
        IDREAM_NEXT_DIST_DIR: environment.mainDistDir,
        IDREAM_NEXT_TSCONFIG: environment.mainTsconfigPath,
      },
    },
    {
      command: `bun run --cwd ../admin dev -- --port ${environment.adminPort}`,
      url: environment.adminBaseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...environment.serviceEnv,
        MAIN_WEB_URL: environment.mainBaseURL,
        IDREAM_NEXT_DIST_DIR: environment.adminDistDir,
        IDREAM_NEXT_TSCONFIG: environment.adminTsconfigPath,
      },
    },
    {
      command: `bun src/e2e/pipeline-image-fixture-server.ts --port ${environment.pipelinePort}`,
      url: `${environment.pipelineBaseURL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        APP_ENV: "test",
      },
    },
    {
      // Playwright 1.61 supports managed background processes without a
      // port/url. Readiness is the Gen entrypoint's stable startup log after
      // both image-generation and character-preview workers are constructed.
      command: "bun run --cwd ../gen start:image",
      reuseExistingServer: false,
      timeout: 30_000,
      wait: {
        stdout: /gen\/image workers started/,
      },
      gracefulShutdown: {
        signal: "SIGTERM",
        timeout: 30_000,
      },
      env: {
        ...environment.serviceEnv,
        // packages/gen/.env defines higher-priority GEN_* aliases. Pin them
        // explicitly so this worker cannot escape the run-owned Redis,
        // provider, pipeline fixture, or blob authority.
        GEN_REDIS_URL: environment.redisURL,
        GEN_IMAGE_PROVIDER: environment.serviceEnv.IMAGE_PROVIDER,
        GEN_VIDEO_PROVIDER: environment.serviceEnv.VIDEO_PROVIDER,
        GEN_MODERATION_PROVIDER: environment.serviceEnv.MODERATION_PROVIDER,
        GEN_BLOB_PROVIDER: environment.serviceEnv.BLOB_PROVIDER,
        LOG_LEVEL: "info",
      },
    },
  ];
}

export function assertPlaywrightDatabaseUrl(value: string) {
  const parsed = postgresUrl(value, "Playwright authority database");
  const databaseName = databaseNameFromUrl(parsed);
  assertPlaywrightDatabaseName(databaseName);
  return parsed.toString();
}

export function assertPlaywrightChatDatabaseUrl(
  value: string,
  authorityDatabaseUrl: string,
) {
  const authority = new URL(assertPlaywrightDatabaseUrl(authorityDatabaseUrl));
  const parsed = postgresUrl(value, "Playwright Chat database");
  const databaseName = databaseNameFromUrl(parsed);
  assertPlaywrightDatabaseName(databaseName);
  if (decodeURIComponent(parsed.username) !== "chat_service") {
    throw new Error(
      "Playwright Chat database must connect with the chat_service role",
    );
  }
  if (
    parsed.hostname !== authority.hostname ||
    normalizedPort(parsed) !== normalizedPort(authority) ||
    parsed.pathname !== authority.pathname
  ) {
    throw new Error(
      "Playwright Chat must use the same database authority as Playwright Main",
    );
  }
  return parsed.toString();
}

function derivedPlaywrightChatDatabaseUrl(authorityDatabaseUrl: string) {
  const parsed = new URL(assertPlaywrightDatabaseUrl(authorityDatabaseUrl));
  parsed.username = "chat_service";
  parsed.password = CHAT_SERVICE_PASSWORD;
  parsed.searchParams.delete("schema");
  return assertPlaywrightChatDatabaseUrl(
    parsed.toString(),
    authorityDatabaseUrl,
  );
}

function derivedPlaywrightDatabaseUrl(
  baseValue: string,
  mainPort: string,
  runId: string,
) {
  const parsed = postgresUrl(baseValue, "TEST_DATABASE_URL");
  const baseName = databaseNameFromUrl(parsed)
    .replace(/(?:[_-]playwright[_-]\d+)(?:[_-][a-f0-9]{8})?$/i, "");
  const suffix = `_playwright_${mainPort}_${runId}`;
  const testScopedBase = TEST_DATABASE_TOKEN.test(baseName)
    ? baseName
    : `${baseName}_test`;
  const availableBaseLength = 63 - suffix.length;
  const compactBase = testScopedBase
    .slice(0, Math.max(1, availableBaseLength))
    .replace(/[_-]+$/g, "");
  parsed.pathname = `/${compactBase}${suffix}`;
  parsed.searchParams.delete("schema");
  return assertPlaywrightDatabaseUrl(parsed.toString());
}

function assertPlaywrightDatabaseName(databaseName: string) {
  if (
    !TEST_DATABASE_TOKEN.test(databaseName) ||
    !PLAYWRIGHT_DATABASE_TOKEN.test(databaseName)
  ) {
    throw new Error(
      `Refusing non-Playwright test database "${databaseName || "(missing)"}"; the database name must contain both test and playwright`,
    );
  }
  if (Buffer.byteLength(databaseName, "utf8") > 63) {
    throw new Error(
      "Playwright database name exceeds PostgreSQL's 63-byte identifier limit",
    );
  }
}

function postgresUrl(value: string, variableName: string) {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${variableName} must be a PostgreSQL URL`);
  }
  if (!parsed.hostname || !databaseNameFromUrl(parsed)) {
    throw new Error(`${variableName} must name a PostgreSQL host and database`);
  }
  return parsed;
}

export function assertPlaywrightRedisUrl(value: string) {
  const parsed = new URL(value);
  const database = Number(parsed.pathname.replace(/^\//, ""));
  if (
    parsed.protocol !== "redis:" ||
    !["127.0.0.1", "localhost", "::1"].includes(normalizedHostname(parsed)) ||
    !Number.isInteger(database) ||
    database < 1
  ) {
    throw new Error(
      "PW_REDIS_URL must be a loopback Redis URL with a dedicated non-zero database",
    );
  }
  return parsed.toString();
}

function playwrightRunId(value: string | undefined) {
  const runId = value ?? randomBytes(4).toString("hex");
  if (!/^[a-f0-9]{8}$/.test(runId)) {
    throw new Error("PW_RUN_ID must be exactly 8 lowercase hexadecimal characters");
  }
  return runId;
}

function offsetLoopbackURL(baseValue: string, offset: number, label: string) {
  const parsed = new URL(baseValue);
  const port = Number(parsed.port) + offset;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} port is outside the valid TCP range`);
  }
  parsed.port = String(port);
  return loopbackBaseURL(parsed.toString(), `${label} URL`);
}

function loopbackBaseURL(value: string, variableName: string) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(normalizedHostname(parsed)) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${variableName} must be a plain loopback http origin with an explicit port`,
    );
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} contains an invalid port`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizedPort(value: URL) {
  if (value.port) return value.port;
  return "5432";
}

function normalizedHostname(value: URL) {
  return value.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function mainPackageRoot() {
  return process.cwd().endsWith(path.join("packages", "main"))
    ? process.cwd()
    : path.resolve(process.cwd(), "packages/main");
}

function databaseNameFromUrl(value: URL) {
  return decodeURIComponent(value.pathname.replace(/^\//, ""));
}
