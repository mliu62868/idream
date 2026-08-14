import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeAgeVerificationProbeEvidence,
  decodeAdminTextProbeEvidence,
  decodeBlobStorageProbeEvidence,
  decodeChatModelProbeEvidence,
  decodeChatServiceProbeEvidence,
  decodeImagePipelineProbeEvidence,
  decodeImageGenerationPersistenceProbeEvidence,
  decodePaymentProviderProbeEvidence,
  decodeProductConfigProbeEvidence,
  decodePublicCatalogProbeEvidence,
  decodeSafetyGatewayProbeEvidence,
  decodeSentryAdminCanaryProbeEvidence,
  decodeSentryChatCanaryProbeEvidence,
  decodeSentryGenCanaryProbeEvidence,
  decodeSentryMainCanaryProbeEvidence,
  decodeVoiceModelProbeEvidence,
  decodeVideoGenerationProbeEvidence,
  decodeVideoGenerationPersistenceProbeEvidence,
  decodeWebSurfaceProbeEvidence,
} from "./evidence";

// SPEC: 一个 probe 的“身份”= 报告文件走哪个 env 变量、报告过期阈值走哪个 env 变量、字节怎么解码。
//       这三件事此前每个 probe 各散在 6 处字面量里（生产端 1、消费端 5），而生产端写哪个 key、
//       消费端读哪个 key 之间没有任何东西对账。
// INTENT: 收成一张按 probe 名索引的表之后，“probe 写 A、门禁读 B”不可表达 —— 两侧都只能说
//         PROBE_REPORTS[name].reportEnvKey。表本身是 Record<ProbeName, …>，漏一个是编译错误。
// INVARIANT: 键名同时是 assessLaunchReadiness 的注入 option 名（LaunchReadinessProbeOptions
//            由这张表映射出来），所以“新增 evidence 却没接进门禁”也是编译错误。

type ProbeReportSpec = {
  /** 报告文件路径的 env 变量名；probe 写它，门禁读它。 */
  readonly reportEnvKey: string;
  /** 报告最大年龄（分钟）的 env 变量名。 */
  readonly maxAgeEnvKey: string;
  /** JSON → evidence 的运行时兜底解码。 */
  readonly decode: (value: unknown) => { ok?: boolean; loadError?: string };
};

export const PROBE_REPORTS = {
  imagePipelineProbe: {
    reportEnvKey: "PIPELINE_IMAGE_PROBE_REPORT",
    maxAgeEnvKey: "PIPELINE_IMAGE_PROBE_MAX_AGE_MINUTES",
    decode: decodeImagePipelineProbeEvidence,
  },
  videoGenerationProbe: {
    reportEnvKey: "VIDEO_GENERATION_PROBE_REPORT",
    maxAgeEnvKey: "VIDEO_GENERATION_PROBE_MAX_AGE_MINUTES",
    decode: decodeVideoGenerationProbeEvidence,
  },
  imageGenerationPersistenceProbe: {
    reportEnvKey: "GENERATION_IMAGE_PERSISTENCE_PROBE_REPORT",
    maxAgeEnvKey: "GENERATION_IMAGE_PERSISTENCE_PROBE_MAX_AGE_MINUTES",
    decode: decodeImageGenerationPersistenceProbeEvidence,
  },
  videoGenerationPersistenceProbe: {
    reportEnvKey: "GENERATION_VIDEO_PERSISTENCE_PROBE_REPORT",
    maxAgeEnvKey: "GENERATION_VIDEO_PERSISTENCE_PROBE_MAX_AGE_MINUTES",
    decode: decodeVideoGenerationPersistenceProbeEvidence,
  },
  blobStorageProbe: {
    reportEnvKey: "BLOB_STORAGE_PROBE_REPORT",
    maxAgeEnvKey: "BLOB_STORAGE_PROBE_MAX_AGE_MINUTES",
    decode: decodeBlobStorageProbeEvidence,
  },
  safetyGatewayProbe: {
    reportEnvKey: "SAFETY_GATEWAY_PROBE_REPORT",
    maxAgeEnvKey: "SAFETY_GATEWAY_PROBE_MAX_AGE_MINUTES",
    decode: decodeSafetyGatewayProbeEvidence,
  },
  chatServiceProbe: {
    reportEnvKey: "CHAT_SERVICE_PROBE_REPORT",
    maxAgeEnvKey: "CHAT_SERVICE_PROBE_MAX_AGE_MINUTES",
    decode: decodeChatServiceProbeEvidence,
  },
  chatModelProbe: {
    reportEnvKey: "CHAT_MODEL_PROBE_REPORT",
    maxAgeEnvKey: "CHAT_MODEL_PROBE_MAX_AGE_MINUTES",
    decode: decodeChatModelProbeEvidence,
  },
  adminTextProbe: {
    reportEnvKey: "ADMIN_TEXT_PROBE_REPORT",
    maxAgeEnvKey: "ADMIN_TEXT_PROBE_MAX_AGE_MINUTES",
    decode: decodeAdminTextProbeEvidence,
  },
  voiceModelProbe: {
    reportEnvKey: "VOICE_MODEL_PROBE_REPORT",
    maxAgeEnvKey: "VOICE_MODEL_PROBE_MAX_AGE_MINUTES",
    decode: decodeVoiceModelProbeEvidence,
  },
  paymentProviderProbe: {
    reportEnvKey: "PAYMENT_PROVIDER_PROBE_REPORT",
    maxAgeEnvKey: "PAYMENT_PROVIDER_PROBE_MAX_AGE_MINUTES",
    decode: decodePaymentProviderProbeEvidence,
  },
  ageVerificationProbe: {
    reportEnvKey: "AGE_VERIFICATION_PROBE_REPORT",
    maxAgeEnvKey: "AGE_VERIFICATION_PROBE_MAX_AGE_MINUTES",
    decode: decodeAgeVerificationProbeEvidence,
  },
  productConfigProbe: {
    reportEnvKey: "PRODUCT_CONFIG_PROBE_REPORT",
    maxAgeEnvKey: "PRODUCT_CONFIG_PROBE_MAX_AGE_MINUTES",
    decode: decodeProductConfigProbeEvidence,
  },
  publicCatalogProbe: {
    reportEnvKey: "PUBLIC_CATALOG_PROBE_REPORT",
    maxAgeEnvKey: "PUBLIC_CATALOG_PROBE_MAX_AGE_MINUTES",
    decode: decodePublicCatalogProbeEvidence,
  },
  webSurfaceProbe: {
    reportEnvKey: "WEB_SURFACE_PROBE_REPORT",
    maxAgeEnvKey: "WEB_SURFACE_PROBE_MAX_AGE_MINUTES",
    decode: decodeWebSurfaceProbeEvidence,
  },
  sentryMainCanaryProbe: {
    reportEnvKey: "SENTRY_MAIN_PROBE_REPORT",
    maxAgeEnvKey: "SENTRY_MAIN_PROBE_MAX_AGE_MINUTES",
    decode: decodeSentryMainCanaryProbeEvidence,
  },
  sentryAdminCanaryProbe: {
    reportEnvKey: "SENTRY_ADMIN_PROBE_REPORT",
    maxAgeEnvKey: "SENTRY_ADMIN_PROBE_MAX_AGE_MINUTES",
    decode: decodeSentryAdminCanaryProbeEvidence,
  },
  sentryChatCanaryProbe: {
    reportEnvKey: "SENTRY_CHAT_PROBE_REPORT",
    maxAgeEnvKey: "SENTRY_CHAT_PROBE_MAX_AGE_MINUTES",
    decode: decodeSentryChatCanaryProbeEvidence,
  },
  sentryGenCanaryProbe: {
    reportEnvKey: "SENTRY_GEN_PROBE_REPORT",
    maxAgeEnvKey: "SENTRY_GEN_PROBE_MAX_AGE_MINUTES",
    decode: decodeSentryGenCanaryProbeEvidence,
  },
} as const satisfies Record<string, ProbeReportSpec>;

export type ProbeName = keyof typeof PROBE_REPORTS;

export const SENTRY_CANARY_PROBE_NAMES = {
  main: "sentryMainCanaryProbe",
  admin: "sentryAdminCanaryProbe",
  chat: "sentryChatCanaryProbe",
  gen: "sentryGenCanaryProbe",
} as const satisfies Record<
  import("./evidence").SentryCanaryService,
  ProbeName
>;

export type ProbeEvidenceOf<K extends ProbeName> = ReturnType<
  (typeof PROBE_REPORTS)[K]["decode"]
> & {
  sourceRevision?: string | null;
};

/** 门禁的 probe 注入面：由 PROBE_REPORTS 映射，不能少一个也不能多一个。 */
export type LaunchReadinessProbeOptions = {
  [K in ProbeName]?: ProbeEvidenceOf<K> | null;
};

export const PROBE_NAMES = Object.keys(PROBE_REPORTS) as readonly ProbeName[];

export function resolveWorkspacePath(filePath: string) {
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

// SPEC: 门禁侧读回报告。读不到/解析不了不抛，落成 loadError —— 判定必须 fail closed 而不是崩掉。
export function loadProbeReport<K extends ProbeName>(
  env: Record<string, string | undefined>,
  name: K,
): ProbeEvidenceOf<K> | null {
  const spec = PROBE_REPORTS[name];
  const reportPath = env[spec.reportEnvKey];
  if (!reportPath) return null;
  try {
    const raw = JSON.parse(
      readFileSync(resolveWorkspacePath(reportPath), "utf8"),
    ) as unknown;
    const decoded = spec.decode(raw) as ProbeEvidenceOf<K>;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const revision =
        typeof record.sourceRevision === "string"
          ? record.sourceRevision
          : typeof record.release === "string"
            ? record.release
            : null;
      decoded.sourceRevision = revision;
    }
    return decoded;
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read ${spec.reportEnvKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    } as ProbeEvidenceOf<K>;
  }
}

/** `--name value` / `--name=value` —— 每个 probe 脚本原本各抄一份。 */
export function probeCliArg(name: string, argv: readonly string[] = process.argv) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

// SPEC: probe 侧解析报告路径。env 变量名从同一张表取，所以 probe 不可能写到门禁不看的地方。
export function probeReportPath(
  name: ProbeName,
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
) {
  return probeCliArg("report", argv) ?? env[PROBE_REPORTS[name].reportEnvKey] ?? null;
}

export async function writeProbeReport(reportPath: string, report: unknown) {
  const resolved = resolveWorkspacePath(reportPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const sourceRevision =
    process.env.IDREAM_SOURCE_REVISION?.trim() ||
    process.env.SENTRY_RELEASE?.trim() ||
    null;
  const revisionBoundReport =
    typeof report === "object" && report !== null && !Array.isArray(report)
      ? { ...(report as Record<string, unknown>), sourceRevision }
      : report;
  await writeFile(resolved, `${JSON.stringify(revisionBoundReport, null, 2)}\n`);
}
