import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  initializeSentry,
  type SentryRuntimeOptions,
  type SentryService,
} from "./sentry";

export const SENTRY_CANARY_EMITTERS = {
  main: "main-nextjs",
  admin: "admin-nextjs",
  chat: "chat-node",
  gen: "gen-node",
} as const satisfies Record<SentryService, string>;

export type SentryCanaryEmitter =
  (typeof SENTRY_CANARY_EMITTERS)[SentryService];

export interface SentryCanaryReport {
  readonly checkedAt: string;
  readonly correlationId: string;
  readonly durationMs: number;
  readonly emitter: SentryCanaryEmitter;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly eventId: string | null;
  readonly ok: boolean;
  readonly projectId: string | null;
  readonly provider: "sentry";
  readonly release: string;
  readonly service: SentryService;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
}

export interface SentryCanaryInput {
  readonly apiBaseUrl: string;
  readonly appEnv: string;
  readonly authToken: string;
  readonly correlationId: string;
  readonly dsn: string;
  readonly emitter: SentryCanaryEmitter;
  readonly organization: string;
  readonly release: string;
  readonly service: SentryService;
}

export interface SentryCanarySdk {
  captureException(
    error: unknown,
    context: { tags: Record<string, string> },
  ): string;
  flush(timeoutMs: number): Promise<boolean>;
  init(options: SentryRuntimeOptions): void;
}

export interface SentryCanaryDependencies {
  readonly captureException: SentryCanarySdk["captureException"];
  readonly fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly flush: SentryCanarySdk["flush"];
  readonly init: SentryCanarySdk["init"];
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

function resolvedEvent(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const event = (value as { event?: unknown }).event;
  if (!event || typeof event !== "object") return null;
  const tags = (event as { tags?: unknown }).tags;
  const projectId = (event as { projectID?: unknown }).projectID;
  return {
    eventId:
      typeof (event as { eventID?: unknown }).eventID === "string"
        ? (event as { eventID: string }).eventID
        : null,
    projectId:
      typeof projectId === "string" || typeof projectId === "number"
        ? String(projectId)
        : null,
    tags: new Map(
      (Array.isArray(tags) ? tags : []).flatMap((tag) => {
        if (!tag || typeof tag !== "object") return [];
        const key = (tag as { key?: unknown }).key;
        const value = (tag as { value?: unknown }).value;
        return typeof key === "string" && typeof value === "string"
          ? [[key, value] as const]
          : [];
      }),
    ),
  };
}

function sanitizedApiBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("SENTRY_API_BASE_URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function projectIdFromDsn(value: string) {
  const projectId = new URL(value).pathname.split("/").filter(Boolean).at(-1);
  if (!projectId) throw new Error("Sentry DSN project id is missing");
  return projectId;
}

export async function runSentryRuntimeCanary(
  input: SentryCanaryInput,
  dependencies: SentryCanaryDependencies,
): Promise<SentryCanaryReport> {
  const checkedAt = dependencies.now();
  const baseReport = {
    checkedAt: checkedAt.toISOString(),
    correlationId: input.correlationId,
    emitter: input.emitter,
    provider: "sentry" as const,
    release: input.release,
    service: input.service,
  };

  try {
    if (SENTRY_CANARY_EMITTERS[input.service] !== input.emitter) {
      throw new Error("Sentry canary emitter does not match the runtime");
    }
    const initialized = initializeSentry(
      { init: dependencies.init },
      {
        appEnv: input.appEnv,
        dsn: input.dsn,
        release: input.release,
        service: input.service,
      },
    );
    if (!initialized) {
      throw new Error("Sentry SDK is not enabled for this production canary");
    }

    const eventId = dependencies.captureException(
      new Error(`iDream Sentry launch canary ${input.correlationId}`),
      {
        tags: {
          "idream.canary": "true",
          "idream.correlation_id": input.correlationId,
          "idream.probe_emitter": input.emitter,
          "idream.release": input.release,
          service: input.service,
        },
      },
    );
    if (!(await dependencies.flush(5_000))) {
      throw new Error("Sentry SDK did not flush the canary event");
    }

    const apiBaseUrl = sanitizedApiBaseUrl(input.apiBaseUrl);
    const expectedProjectId = projectIdFromDsn(input.dsn);
    const resolveUrl = `${apiBaseUrl}/api/0/organizations/${encodeURIComponent(input.organization)}/eventids/${eventId}/`;
    let projectId: string | null = null;
    let verified = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await dependencies.fetch(resolveUrl, {
        headers: { Authorization: `Bearer ${input.authToken}` },
      });
      if (response.ok) {
        const event = resolvedEvent(await response.json());
        const tags = event?.tags ?? new Map<string, string>();
        projectId = event?.projectId ?? null;
        verified =
          event?.eventId === eventId &&
          projectId === expectedProjectId &&
          tags.get("idream.correlation_id") === input.correlationId &&
          tags.get("idream.probe_emitter") === input.emitter &&
          tags.get("idream.release") === input.release &&
          tags.get("service") === input.service;
        if (verified) break;
      } else if (response.status !== 404) {
        throw new Error(`Sentry event lookup returned HTTP ${response.status}`);
      }
      if (attempt < 14) await dependencies.sleep(2_000);
    }
    if (!verified) {
      throw new Error(
        "Sentry did not return the runtime-bound canary event in time",
      );
    }

    return {
      ...baseReport,
      durationMs: dependencies.now().getTime() - checkedAt.getTime(),
      error: null,
      eventId,
      ok: true,
      projectId,
      verified: true,
      verifiedAt: dependencies.now().toISOString(),
    };
  } catch {
    return {
      ...baseReport,
      durationMs: dependencies.now().getTime() - checkedAt.getTime(),
      error: {
        code: "sentry_canary_failed",
        message: "Sentry canary failed; inspect restricted process logs.",
      },
      eventId: null,
      ok: false,
      projectId: null,
      verified: false,
      verifiedAt: null,
    };
  }
}

export async function runSentryRuntimeCanaryCli(input: {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly sdk: SentryCanarySdk;
  readonly service: SentryService;
}) {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  if (readArg(argv, "service") !== undefined) {
    throw new Error(
      "--service is not accepted; invoke the package-specific Sentry probe",
    );
  }
  const service = input.service;
  const report = await runSentryRuntimeCanary(
    {
      apiBaseUrl: env.SENTRY_API_BASE_URL?.trim() || "https://sentry.io",
      appEnv: required("APP_ENV", env.APP_ENV),
      authToken: required(
        "SENTRY_CANARY_AUTH_TOKEN",
        env.SENTRY_CANARY_AUTH_TOKEN,
      ),
      correlationId: `sentry-canary-${randomUUID()}`,
      dsn: required("SENTRY_DSN", env.SENTRY_DSN),
      emitter: SENTRY_CANARY_EMITTERS[service],
      organization: required("SENTRY_ORG", env.SENTRY_ORG),
      release: required("SENTRY_RELEASE", env.SENTRY_RELEASE),
      service,
    },
    {
      captureException: input.sdk.captureException,
      fetch: globalThis.fetch,
      flush: input.sdk.flush,
      init: input.sdk.init,
      now: () => new Date(),
      sleep: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
  );
  const reportPath =
    readArg(argv, "report") ?? env[sentryReportEnvKey(service)] ?? null;
  if (reportPath) {
    const absolute = resolveWorkspacePath(reportPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

function required(name: string, value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function readArg(argv: readonly string[], name: string) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sentryReportEnvKey(service: SentryService) {
  return `SENTRY_${service.toUpperCase()}_PROBE_REPORT`;
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return path.resolve(current, filePath);
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(process.cwd(), filePath);
    current = parent;
  }
}
