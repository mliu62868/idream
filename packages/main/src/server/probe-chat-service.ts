import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";

type ProbeOptions = {
  report: string | null;
  serviceUrl: string | null;
  userId: string;
};

type OperationEvidence = {
  ok: boolean;
  status?: number;
  error?: string | null;
};

type ChatServiceProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  serviceUrl: string | null;
  userId: string;
  usedSignedBff: boolean;
  health: OperationEvidence & { service?: string | null };
  signedRequest: OperationEvidence & { sessionsCount?: number };
  unsignedRequest: OperationEvidence;
  error: { code: string; message: string; retryable?: boolean } | null;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.CHAT_SERVICE_PROBE_REPORT ?? null,
    serviceUrl: readArg("service-url") ?? process.env.CHAT_SERVICE_URL ?? null,
    userId: readArg("user-id") ?? process.env.CHAT_SERVICE_PROBE_USER_ID ?? "seed-dev-user",
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    serviceUrl: options.serviceUrl,
    userId: options.userId,
    secret: process.env.CHAT_BFF_SIGNING_SECRET ?? null,
  });

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(input: {
  serviceUrl: string | null;
  userId: string;
  secret: string | null;
}): Promise<ChatServiceProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const baseReport = {
    checkedAt,
    serviceUrl: input.serviceUrl,
    userId: input.userId,
    usedSignedBff: Boolean(input.secret?.trim()),
  };

  const health = await probeHealth(input.serviceUrl);
  let signedRequest: ChatServiceProbeReport["signedRequest"] = {
    ok: false,
    error: "CHAT_BFF_SIGNING_SECRET is required for chat service probe",
  };
  let unsignedRequest: ChatServiceProbeReport["unsignedRequest"] = {
    ok: false,
    error: "not attempted",
  };

  try {
    if (!input.serviceUrl?.trim()) {
      throw new Error("CHAT_SERVICE_URL is required for chat service probe");
    }
    if (!input.secret?.trim()) {
      throw new Error("CHAT_BFF_SIGNING_SECRET is required for chat service probe");
    }

    signedRequest = await probeSignedSessions({
      serviceUrl: input.serviceUrl,
      secret: input.secret,
      userId: input.userId,
    });
    unsignedRequest = await probeUnsignedSessions(input.serviceUrl);
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      health,
      signedRequest,
      unsignedRequest,
      error: {
        code: "chat_service_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }

  const ok =
    health.ok &&
    signedRequest.ok &&
    unsignedRequest.status === 401 &&
    Boolean(input.secret?.trim());

  return {
    ...baseReport,
    ok,
    durationMs: Date.now() - startedAt,
    health,
    signedRequest,
    unsignedRequest,
    error: ok
      ? null
      : {
          code: "chat_service_probe_failed",
          message: "chat service health, signed request, or unsigned rejection failed",
          retryable: true,
        },
  };
}

async function probeHealth(serviceUrl: string | null): Promise<ChatServiceProbeReport["health"]> {
  if (!serviceUrl?.trim()) return { ok: false, error: "CHAT_SERVICE_URL is required" };
  try {
    const response = await fetch(new URL("/healthz", normalizedBase(serviceUrl)));
    const json = (await response.json().catch(() => ({}))) as unknown;
    const record = isRecord(json) ? json : {};
    return {
      ok: response.status === 200 && record.ok === true && record.service === "chat",
      status: response.status,
      service: typeof record.service === "string" ? record.service : null,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeSignedSessions(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
}): Promise<ChatServiceProbeReport["signedRequest"]> {
  const method = "GET";
  const requestPath = "/api/v1/chat/sessions";
  const body = "";
  const { signature, context } = signBffContext({
    secret: input.secret,
    userId: input.userId,
    method,
    path: requestPath,
    body,
  });
  const response = await fetch(new URL(requestPath, normalizedBase(input.serviceUrl)), {
    method,
    headers: {
      [BFF_HEADER]: signature,
      [BFF_USER_HEADER]: JSON.stringify(context),
    },
  });
  const json = (await response.json().catch(() => undefined)) as unknown;
  const isSessionList = Array.isArray(json);
  return {
    ok: response.status === 200 && isSessionList,
    status: response.status,
    sessionsCount: isSessionList ? json.length : undefined,
    error: response.status === 200 ? null : `HTTP ${response.status}`,
  };
}

async function probeUnsignedSessions(
  serviceUrl: string,
): Promise<ChatServiceProbeReport["unsignedRequest"]> {
  try {
    const response = await fetch(
      new URL("/api/v1/chat/sessions", normalizedBase(serviceUrl)),
    );
    return {
      ok: response.status === 401,
      status: response.status,
      error: response.status === 401 ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizedBase(serviceUrl: string) {
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  return new URL(base);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
