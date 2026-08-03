import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { S3CompatibleBlobStore } from "@idream/shared";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { MockBlobStore } from "./providers/blob/mock";
import type { BlobStore, ProviderFailure, ProviderResult } from "./providers/types";
import type { BlobStorageProbeEvidence, ProbeReportOf } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
  keyPrefix: string;
  ttlSeconds: number;
};

type BlobProvider = "mock" | "r2" | "s3";

type OperationEvidence = {
  ok: boolean;
  error?: { code?: string; message?: string };
};

// INTENT: 生产端自己的精确形状（source 是字面量联合、ok 必填），比契约里那份"能容忍脏 JSON 的
//         全可选声明"更强；报告组装时由 tsc 校验它能落进契约。
type ReadbackEvidence = {
  ok: boolean;
  source: "filesystem" | "signed-url" | "skipped";
  status?: number;
  bytes?: number;
  matches?: boolean;
  sha256?: string;
  error?: string;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
// INTENT: configurationError 只在对象存储配置不合法的早退路径出现，故标成按路径可省。
type BlobStorageProbeReport = ProbeReportOf<BlobStorageProbeEvidence, "configurationError">;

function readOptions(): ProbeOptions {
  const ttlSeconds = Number.parseInt(probeCliArg("ttl") ?? "60", 10);
  return {
    report: probeReportPath("blobStorageProbe"),
    keyPrefix: probeCliArg("key-prefix") ?? "launch-probes",
    ttlSeconds:
      Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? Math.min(ttlSeconds, 604_800)
        : 60,
  };
}

async function main() {
  const options = readOptions();
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const provider = blobProvider();
  const key = `${options.keyPrefix.replace(/\/+$/, "")}/${Date.now()}-${randomUUID()}.txt`;
  const body = new TextEncoder().encode(
    JSON.stringify({
      probe: "idream-blob-storage",
      checkedAt,
      nonce: randomUUID(),
    }),
  );
  const contentType = "text/plain; charset=utf-8";
  const expectedSha256 = sha256Hex(body);

  const report = await runProbe({
    provider,
    key,
    body,
    contentType,
    expectedSha256,
    ttlSeconds: options.ttlSeconds,
    startedAt,
    checkedAt,
  });

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(input: {
  provider: BlobProvider | string;
  key: string;
  body: Uint8Array;
  contentType: string;
  expectedSha256: string;
  ttlSeconds: number;
  startedAt: number;
  checkedAt: string;
}): Promise<BlobStorageProbeReport> {
  const baseReport = {
    checkedAt: input.checkedAt,
    provider: input.provider,
    endpoint: process.env.BLOB_ENDPOINT ?? null,
    bucket: process.env.BLOB_BUCKET ?? null,
    key: input.key,
    contentType: input.contentType,
    bytes: input.body.byteLength,
    sha256: input.expectedSha256,
  };

  let store: BlobStore;
  try {
    store = buildBlobStore(input.provider);
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - input.startedAt,
      configurationError: error instanceof Error ? error.message : String(error),
      put: { ok: false, error: { code: "configuration_error" } },
      signedGetUrl: { ok: false, error: { code: "skipped" } },
      readback: {
        ok: false,
        source: "skipped",
        error: "Object storage configuration is invalid.",
      },
      delete: { ok: false, error: { code: "skipped" } },
    };
  }

  const put = await store.putPrivate({
    key: input.key,
    body: input.body,
    contentType: input.contentType,
  });
  const signedGetUrl = put.ok
    ? await store.signGetUrl({
        key: input.key,
        expiresInSeconds: input.ttlSeconds,
        downloadFilename: "idream-blob-probe.txt",
      })
    : skipped<{ url: string }>("PUT did not succeed.");
  const readback = signedGetUrl.ok
    ? await readBackObject({
        provider: input.provider,
        key: input.key,
        signedUrl: signedGetUrl.data.url,
        expectedSha256: input.expectedSha256,
      })
    : {
        ok: false,
        source: "skipped" as const,
        error: "Signed GET URL was not created.",
      };
  const deleteResult = put.ok
    ? await deleteObject(store, input.provider, input.key)
    : skipped<{ deleted: true }>("PUT did not succeed.");
  const report = {
    ...baseReport,
    ok:
      put.ok &&
      signedGetUrl.ok &&
      readback.ok &&
      readback.matches === true &&
      deleteResult.ok,
    durationMs: Date.now() - input.startedAt,
    put: providerResultEvidence(put, (data) => ({ size: data.size })),
    signedGetUrl: providerResultEvidence(signedGetUrl, (data) => ({
      ...signedUrlEvidence(data.url),
      expiresInSeconds: input.ttlSeconds,
    })),
    readback,
    delete: providerResultEvidence(deleteResult),
  };

  return report;
}

function blobProvider() {
  return process.env.BLOB_PROVIDER ?? process.env.GEN_BLOB_PROVIDER ?? "mock";
}

function buildBlobStore(provider: string): BlobStore {
  if (provider === "mock") return new MockBlobStore();
  if (provider !== "r2" && provider !== "s3") {
    throw new Error(`Unsupported blob provider: ${provider}`);
  }

  return new S3CompatibleBlobStore({
    endpoint: requireEnv("BLOB_ENDPOINT", process.env.BLOB_ENDPOINT),
    bucket: requireEnv("BLOB_BUCKET", process.env.BLOB_BUCKET),
    region: process.env.BLOB_REGION,
    accessKeyId: requireEnv(
      "BLOB_ACCESS_KEY_ID",
      process.env.BLOB_ACCESS_KEY_ID ??
        process.env.BLOB_ACCESS_KEY ??
        process.env.AWS_ACCESS_KEY_ID,
    ),
    secretAccessKey: requireEnv(
      "BLOB_SECRET_ACCESS_KEY",
      process.env.BLOB_SECRET_ACCESS_KEY ??
        process.env.BLOB_SECRET_KEY ??
        process.env.AWS_SECRET_ACCESS_KEY,
    ),
  });
}

async function readBackObject(input: {
  provider: string;
  key: string;
  signedUrl: string;
  expectedSha256: string;
}): Promise<ReadbackEvidence> {
  if (input.provider === "mock") {
    try {
      const body = await readFile(resolveLocalBlobPath(input.key));
      const actualSha256 = sha256Hex(body);
      return {
        ok: actualSha256 === input.expectedSha256,
        source: "filesystem",
        bytes: body.byteLength,
        sha256: actualSha256,
        matches: actualSha256 === input.expectedSha256,
      };
    } catch (error) {
      return {
        ok: false,
        source: "filesystem",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const response = await fetch(input.signedUrl);
    const body = new Uint8Array(await response.arrayBuffer());
    const actualSha256 = sha256Hex(body);
    return {
      ok: response.ok && actualSha256 === input.expectedSha256,
      source: "signed-url",
      status: response.status,
      bytes: body.byteLength,
      sha256: actualSha256,
      matches: actualSha256 === input.expectedSha256,
    };
  } catch (error) {
    return {
      ok: false,
      source: "signed-url",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function deleteObject(
  store: BlobStore,
  provider: string,
  key: string,
): Promise<ProviderResult<{ deleted: true }>> {
  const result = await store.delete({ key });
  if (provider === "mock" && result.ok) {
    await rm(resolveLocalBlobPath(key), { force: true });
  }
  return result;
}

function providerResultEvidence<T, E extends Record<string, unknown> = Record<never, never>>(
  result: ProviderResult<T>,
  map?: (data: T) => E,
): OperationEvidence & E {
  if (!result.ok) return { ok: false, error: errorEvidence(result.error) } as OperationEvidence & E;
  return { ok: true, ...(map?.(result.data) ?? {}) } as OperationEvidence & E;
}

function skipped<T>(message: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: "skipped",
      message,
      retryable: false,
    },
  };
}

function errorEvidence(error: ProviderFailure) {
  return {
    code: error.code,
    message: error.message,
  };
}

function signedUrlEvidence(urlString: string) {
  try {
    const url = new URL(urlString);
    return {
      host: url.host,
      pathname: url.pathname,
    };
  } catch {
    return {
      host: null,
      pathname: null,
    };
  }
}

function requireEnv(name: string, value: string | undefined) {
  if (!value?.trim()) throw new Error(`${name} is required for blob storage probe`);
  return value;
}

function sha256Hex(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
