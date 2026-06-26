import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SafetyGatewayModerationProvider } from "@idream/shared";

type ModerationStatus = "passed" | "flagged" | "blocked";

type ModerationResult =
  | {
      ok: true;
      data: {
        status: ModerationStatus;
        policyCode?: string;
        confidence: number;
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };

type ProbeOptions = {
  report: string | null;
  prompt: string;
  targetType: "text";
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
    report: readArg("report") ?? process.env.SAFETY_GATEWAY_PROBE_REPORT ?? null,
    prompt:
      readArg("prompt") ??
      "Launch readiness probe: classify this harmless systems check as safe.",
    targetType: "text",
  };
}

async function main() {
  const options = readOptions();
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const provider = process.env.MODERATION_PROVIDER ?? "mock";
  const serviceUrl = process.env.MODERATION_SERVICE_URL ?? null;

  const result = await runModerationProbe({
    provider,
    serviceUrl,
    prompt: options.prompt,
    targetType: options.targetType,
  });
  const ok = result.ok && result.data.status === "passed";
  const report = {
    ok,
    checkedAt,
    durationMs: Date.now() - startedAt,
    provider,
    serviceUrl,
    targetType: options.targetType,
    status: result.ok ? result.data.status : null,
    policyCode: result.ok ? result.data.policyCode ?? null : null,
    confidence: result.ok ? result.data.confidence : null,
    error: result.ok
      ? null
      : {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        },
  };

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function runModerationProbe(input: {
  provider: string;
  serviceUrl: string | null;
  prompt: string;
  targetType: "text";
}): Promise<ModerationResult> {
  if (input.provider === "mock") {
    return {
      ok: true,
      data: {
        status: "passed",
        confidence: 0.5,
      },
    };
  }
  if (input.provider !== "safety-gateway") {
    return {
      ok: false,
      error: {
        code: "unsupported_moderation_provider",
        message: `Unsupported moderation provider: ${input.provider}`,
        retryable: false,
      },
    };
  }

  const provider = new SafetyGatewayModerationProvider({
    serviceUrl: requireEnv("MODERATION_SERVICE_URL", input.serviceUrl),
    apiKey: requireEnv("MODERATION_API_KEY", process.env.MODERATION_API_KEY),
    timeoutMs: Number.parseInt(process.env.MODERATION_TIMEOUT_MS ?? "5000", 10),
  });
  return provider.check({
    targetType: input.targetType,
    content: input.prompt,
  });
}

function requireEnv(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for safety gateway probe`);
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
