import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoCamAgeVerificationProvider } from "./providers/verify/gocam";
import { MockAgeVerificationProvider } from "./providers/verify/mock";
import type { AgeVerificationProvider } from "./providers/types";

type ProbeOptions = {
  report: string | null;
  jurisdiction: string;
};

type AgeProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  provider: string;
  serviceUrl: string | null;
  jurisdiction: string;
  providerVerificationId: string | null;
  status: string | null;
  url: string | null;
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
    report: readArg("report") ?? process.env.AGE_VERIFICATION_PROBE_REPORT ?? null,
    jurisdiction: readArg("jurisdiction") ?? "US",
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    provider: process.env.AGE_VERIFICATION_PROVIDER ?? "mock",
    serviceUrl: process.env.AGE_VERIFY_SERVICE_URL ?? null,
    jurisdiction: options.jurisdiction,
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
  provider: string;
  serviceUrl: string | null;
  jurisdiction: string;
}): Promise<AgeProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const baseReport = {
    checkedAt,
    provider: input.provider,
    serviceUrl: input.serviceUrl,
    jurisdiction: input.jurisdiction,
  };

  try {
    const ageVerification = createAgeVerificationProvider(input.provider);
    const session = await ageVerification.createSession({
      userId: `launch-probe-${randomUUID()}`,
      jurisdiction: input.jurisdiction,
    });
    if (!session.ok) {
      return {
        ...baseReport,
        ok: false,
        durationMs: Date.now() - startedAt,
        providerVerificationId: null,
        status: null,
        url: null,
        error: {
          code: session.error.code,
          message: session.error.message,
          retryable: session.error.retryable,
        },
      };
    }

    return {
      ...baseReport,
      ok:
        input.provider === "mock"
          ? session.data.status === "not_required"
          : session.data.status === "pending" && Boolean(session.data.url),
      durationMs: Date.now() - startedAt,
      providerVerificationId: session.data.providerVerificationId,
      status: session.data.status,
      url: session.data.url ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      providerVerificationId: null,
      status: null,
      url: null,
      error: {
        code: "age_verification_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function createAgeVerificationProvider(provider: string): AgeVerificationProvider {
  if (provider === "mock") return new MockAgeVerificationProvider();
  if (provider !== "gocam") {
    throw new Error(`Unsupported age verification provider: ${provider}`);
  }

  return new GoCamAgeVerificationProvider({
    serviceUrl: requireValue("AGE_VERIFY_SERVICE_URL", process.env.AGE_VERIFY_SERVICE_URL),
    apiKey: requireValue("AGE_VERIFY_API_KEY", process.env.AGE_VERIFY_API_KEY),
    webhookSecret: requireValue(
      "AGE_VERIFY_WEBHOOK_SECRET",
      process.env.AGE_VERIFY_WEBHOOK_SECRET,
    ),
    linkBackUrl: requireValue(
      "AGE_VERIFY_LINK_BACK_URL",
      process.env.AGE_VERIFY_LINK_BACK_URL,
    ),
    callbackUrl: requireValue(
      "AGE_VERIFY_CALLBACK_URL",
      process.env.AGE_VERIFY_CALLBACK_URL,
    ),
    timeoutMs: Number.parseInt(process.env.AGE_VERIFY_TIMEOUT_MS ?? "10000", 10),
  });
}

function requireValue(name: string, value: string | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for age verification probe`);
  return value;
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
