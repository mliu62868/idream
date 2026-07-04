import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ProbeOptions = {
  report: string | null;
  invoiceAmountCents: number;
  invoiceCurrency: string;
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
  canCreateInvoice: boolean;
  invoiceId: string | null;
  checkoutUrl: string | null;
  invoiceAmountCents: number;
  invoiceCurrency: string;
  error: { code: string; message: string; retryable?: boolean } | null;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
    invoiceAmountCents: readPositiveInteger(
      readArg("amount-cents") ?? process.env.PAYMENT_PROVIDER_PROBE_AMOUNT_CENTS,
      1,
      100,
    ),
    invoiceCurrency: normalizeCurrency(
      readArg("currency") ?? process.env.PAYMENT_PROVIDER_PROBE_CURRENCY,
    ),
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    provider: process.env.PAYMENT_PROVIDER ?? "mock",
    baseUrl: process.env.BTCPAY_BASE_URL ?? null,
    storeId: process.env.BTCPAY_STORE_ID ?? null,
    apiKey: process.env.BTCPAY_API_KEY ?? null,
    invoiceAmountCents: options.invoiceAmountCents,
    invoiceCurrency: options.invoiceCurrency,
  });

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

export async function runProbe(input: {
  provider: string;
  baseUrl: string | null;
  storeId: string | null;
  apiKey: string | null;
  invoiceAmountCents?: number;
  invoiceCurrency?: string;
  fetchImpl?: FetchLike;
}): Promise<PaymentProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const invoiceAmountCents = readPositiveInteger(input.invoiceAmountCents, 1, 100);
  const invoiceCurrency = normalizeCurrency(input.invoiceCurrency);
  const baseReport = {
    checkedAt,
    provider: input.provider,
    baseUrl: input.baseUrl,
    storeId: input.storeId,
    invoiceAmountCents,
    invoiceCurrency,
  };

  if (input.provider === "mock") {
    return {
      ...baseReport,
      ok: true,
      durationMs: Date.now() - startedAt,
      canViewStore: true,
      returnedStoreId: "mock-store",
      canCreateInvoice: true,
      invoiceId: "mock-invoice",
      checkoutUrl: "https://mock-payments.idream.local/invoices/mock-invoice",
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
      canCreateInvoice: false,
      invoiceId: null,
      checkoutUrl: null,
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
    const fetchImpl = input.fetchImpl ?? fetch;
    const storeEndpoint = new URL(`/api/v1/stores/${encodeURIComponent(storeId)}`, baseUrl);
    const storeResponse = await fetchImpl(storeEndpoint, {
      method: "GET",
      headers: {
        authorization: `token ${apiKey}`,
        accept: "application/json",
      },
    });
    const storeJson = (await storeResponse.json().catch(() => ({}))) as unknown;
    if (!storeResponse.ok) {
      return {
        ...baseReport,
        ok: false,
        durationMs: Date.now() - startedAt,
        canViewStore: false,
        returnedStoreId: null,
        canCreateInvoice: false,
        invoiceId: null,
        checkoutUrl: null,
        error: {
          code: "btcpay_store_read_failed",
          message:
            responseErrorMessage(storeJson) ??
            `BTCPay store read failed with HTTP ${storeResponse.status}`,
          retryable: storeResponse.status === 429 || storeResponse.status >= 500,
        },
      };
    }

    const returnedStoreId = stringField(asRecord(storeJson), "id");
    const invoice = await createProbeInvoice({
      baseUrl,
      storeId,
      apiKey,
      checkedAt,
      amountCents: invoiceAmountCents,
      currency: invoiceCurrency,
      fetchImpl,
    });
    if (!invoice.ok) {
      return {
        ...baseReport,
        ok: false,
        durationMs: Date.now() - startedAt,
        canViewStore: true,
        returnedStoreId: returnedStoreId ?? null,
        canCreateInvoice: false,
        invoiceId: null,
        checkoutUrl: null,
        error: invoice.error,
      };
    }

    return {
      ...baseReport,
      ok: true,
      durationMs: Date.now() - startedAt,
      canViewStore: true,
      returnedStoreId: returnedStoreId ?? null,
      canCreateInvoice: true,
      invoiceId: invoice.data.invoiceId,
      checkoutUrl: invoice.data.checkoutUrl,
      error: null,
    };
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      canViewStore: false,
      returnedStoreId: null,
      canCreateInvoice: false,
      invoiceId: null,
      checkoutUrl: null,
      error: {
        code: "payment_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

type ProbeInvoiceResult =
  | { ok: true; data: { invoiceId: string; checkoutUrl: string } }
  | {
      ok: false;
      error: { code: string; message: string; retryable?: boolean };
    };

async function createProbeInvoice(input: {
  baseUrl: string;
  storeId: string;
  apiKey: string;
  checkedAt: string;
  amountCents: number;
  currency: string;
  fetchImpl: FetchLike;
}): Promise<ProbeInvoiceResult> {
  const endpoint = new URL(
    `/api/v1/stores/${encodeURIComponent(input.storeId)}/invoices`,
    input.baseUrl,
  );
  const response = await input.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `token ${input.apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount: (input.amountCents / 100).toFixed(2),
      currency: input.currency,
      metadata: {
        launchProbe: true,
        source: "idream-check-launch",
        checkedAt: input.checkedAt,
      },
    }),
  });
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "btcpay_invoice_create_failed",
        message:
          responseErrorMessage(json) ??
          `BTCPay invoice create failed with HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      },
    };
  }

  const record = asRecord(json);
  const invoiceId = stringField(record, "id");
  const checkoutUrl = stringField(record, "checkoutLink");
  if (!invoiceId || !checkoutUrl) {
    return {
      ok: false,
      error: {
        code: "btcpay_invoice_create_failed",
        message: "BTCPay invoice response missing id or checkoutLink",
        retryable: true,
      },
    };
  }

  return { ok: true, data: { invoiceId, checkoutUrl } };
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

function readPositiveInteger(
  value: string | number | null | undefined,
  fallback: number,
  max: number,
) {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function normalizeCurrency(value: string | null | undefined) {
  const currency = value?.trim().toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
