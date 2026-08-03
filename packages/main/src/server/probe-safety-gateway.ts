import { SafetyGatewayModerationProvider } from "@idream/shared";
import type { ProbeReportOf, SafetyGatewayProbeEvidence } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
// INTENT: confidence 标成按路径可省 —— 只有 moderation 调用成功时才有分数。以前这里写 null，
//         而契约声明的是 number，靠消费端把 null 洗成 undefined 才没炸；现在直接省略这个 key。
type SafetyProbeReport = ProbeReportOf<SafetyGatewayProbeEvidence, "confidence">;

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

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("safetyGatewayProbe"),
    prompt:
      probeCliArg("prompt") ??
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
  const report: SafetyProbeReport = {
    ok,
    checkedAt,
    durationMs: Date.now() - startedAt,
    provider,
    serviceUrl,
    targetType: options.targetType,
    status: result.ok ? result.data.status : null,
    policyCode: result.ok ? result.data.policyCode ?? null : null,
    confidence: result.ok ? result.data.confidence : undefined,
    error: result.ok
      ? null
      : {
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        },
  };

  if (options.report) {
    await writeProbeReport(options.report, report);
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

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
