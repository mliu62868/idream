import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type ProbeOptions = {
  report: string | null;
};

type PaymentProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  provider: string;
  baseUrl: string | null;
  storeId: string | null;
  canViewStore: boolean;
  returnedStoreId: string | null;
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
    report: readArg("report") ?? process.env.PAYMENT_PROVIDER_PROBE_REPORT ?? null,
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    provider: process.env.PAYMENT_PROVIDER ?? "mock",
    baseUrl: process.env.BTCPAY_BASE_URL ?? null,
    storeId: process.env.BTCPAY_STORE_ID ?? null,
    apiKey: process.env.BTCPAY_API_KEY ?? null,
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
  baseUrl: string | null;
  storeId: string | null;
  apiKey: string | null;
}): Promise<PaymentProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const baseReport = {
    checkedAt,
    provider: input.provider,
    baseUrl: input.baseUrl,
    storeId: input.storeId,
  };

  if (input.provider === "mock") {
    return {
      ...baseReport,
      ok: true,
      durationMs: Date.now() - startedAt,
      canViewStore: true,
      returnedStoreId: "mock-store",
      error: null,
    };
  }
  if (input.provider !== "btcpay") {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      canViewStore: false,
      returnedStoreId: null,
      error: {
        code: "unsupported_payment_provider",
        message: `Unsupported payment provider: ${input.provider}`,
        retryable: false,
      },
    };
  }

  try {
    const baseUrl = requireValue("BTCPAY_BASE_URL", input.baseUrl);
    const storeId = requireValue("BTCPAY_STORE_ID", input.storeId);
    const apiKey = requireValue("BTCPAY_API_KEY", input.apiKey);
    const endpoint = new URL(`/api/v1/stores/${encodeURIComponent(storeId)}`, baseUrl);
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        authorization: `token ${apiKey}`,
        accept: "application/json",
      },
    });
    const json = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      return {
        ...baseReport,
        ok: false,
        durationMs: Date.now() - startedAt,
        canViewStore: false,
        returnedStoreId: null,
        error: {
          code: "btcpay_store_read_failed",
          message: responseErrorMessage(json) ?? `BTCPay store read failed with HTTP ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        },
      };
    }

    const returnedStoreId = stringField(asRecord(json), "id");
    return {
      ...baseReport,
      ok: true,
      durationMs: Date.now() - startedAt,
      canViewStore: true,
      returnedStoreId: returnedStoreId ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      canViewStore: false,
      returnedStoreId: null,
      error: {
        code: "payment_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function responseErrorMessage(value: unknown) {
  const record = asRecord(value);
  return stringField(record, "message") ?? stringField(record, "error");
}

function requireValue(name: string, value: string | null | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for payment provider probe`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
