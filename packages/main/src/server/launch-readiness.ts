import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  chatFsRootFingerprint,
  resolveChatFsRoot,
  characterVideoProductionRecipe,
  looksLikeMockChatResponse,
} from "@idream/shared";
import {
  defaultBullmqPrefix,
  mainProviderKeysForLaunchScope,
  requiredNonMockMainProviderKeysForLaunchScope,
  resolveLaunchScope,
  type LaunchScope,
  type MainLaunchProviderKey,
} from "@idream/shared/env";
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { SENTRY_CANARY_EMITTERS } from "@idream/shared/observability/sentry-canary";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { isPublicHttpsUrl } from "../lib/public-site-origin";
import { auditCharacterSoulAuthority } from "./modules/admin-v2/characters/soul-authority-audit";
// SPEC: evidence 契约的家在 readiness/evidence.ts —— 生产端（probe-*.ts）与这里共用同一份声明。
import type {
  AdminTextProbeEvidence,
  AgeVerificationProbeEvidence,
  BlobStorageProbeEvidence,
  ChatModelProbeEvidence,
  ChatServiceProbeEvidence,
  GenBlobAuthorityEvidence,
  GenerationPersistenceProbeEvidence,
  ImagePipelineProbeEvidence,
  PaymentProviderProbeEvidence,
  ProductConfigProbeEvidence,
  PublicCatalogProbeEvidence,
  SafetyGatewayProbeEvidence,
  SentryCanaryProbeEvidence,
  SentryCanaryService,
  VideoGenerationProbeEvidence,
  VoiceModelProbeEvidence,
  WebSurfaceProbeEvidence,
} from "./readiness/evidence";
// SPEC: “哪个 probe 用哪个 env 变量”只在 readiness/probe-report.ts 定义一次，两端都从那里取。
import {
  loadProbeReport,
  PROBE_NAMES,
  PROBE_REPORTS,
  SENTRY_CANARY_PROBE_NAMES,
  resolveWorkspacePath,
  type LaunchReadinessProbeOptions,
  type ProbeEvidenceOf,
  type ProbeName,
} from "./readiness/probe-report";
import {
  inspectMigrationAuthority,
  loadExpectedMigrationAuthority,
} from "./readiness/migration-authority";
import { inspectMainToChatFailedBacklog } from "./readiness/main-to-chat-backlog-authority";
import { inspectRecoveryRehearsalBundle } from "./readiness/recovery-rehearsal-authority";
import { resolveRecoveryRehearsalSourceAuthority } from "./readiness/recovery-rehearsal-producer";
import { loadRecoveryServiceEnvironment } from "./readiness/recovery-service-environment";

const DEDICATED_CHAT_PROBE_USER_ID = "seed-chat-probe-user";

export type LaunchReadinessStatus = "pass" | "fail" | "warn";

export interface LaunchReadinessCheck {
  id: string;
  area: string;
  status: LaunchReadinessStatus;
  message: string;
  remediation?: string;
}

export interface LaunchReadinessReport {
  ok: boolean;
  generatedAt: string;
  sourceRevision: string | null;
  evidenceDigest: string;
  environmentDigest: string;
  summary: Record<LaunchReadinessStatus, number>;
  checks: LaunchReadinessCheck[];
}

type EnvLike = Record<string, string | undefined>;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

function sha256Canonical(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

function environmentDigestInput(env: EnvLike) {
  const sensitive =
    /(?:authorization|cookie|database_url|dsn|key|password|secret|token)/iu;
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        sensitive.test(key) ? (value?.trim() ? "present" : "missing") : value,
      ]),
  );
}

export interface LaunchReadinessCapabilities {
  mainProviderImplementations: Record<MainLaunchProviderKey, readonly string[]>;
  genImageProviders: readonly string[];
  genVideoProviders: readonly string[];
}

export type LaunchReadinessCapabilityOverride = {
  mainProviderImplementations?: Partial<
    Record<MainLaunchProviderKey, readonly string[]>
  >;
  genImageProviders?: readonly string[];
  genVideoProviders?: readonly string[];
};

// INVARIANT: probe 注入面由 PROBE_REPORTS 映射而来 —— 新增一个 probe 而没接进门禁是编译错误。
export interface LaunchReadinessOptions extends LaunchReadinessProbeOptions {
  env?: EnvLike;
  capabilities?: LaunchReadinessCapabilityOverride;
  now?: Date;
  preflightChecks?: LaunchReadinessCheck[];
}

export interface LaunchReadinessCliOptions {
  envFile?: string;
  adminEnvFile?: string;
  chatEnvFile?: string;
  genEnvFile?: string;
  reportFile?: string;
  help: boolean;
  json: boolean;
}

export const currentLaunchCapabilities: LaunchReadinessCapabilities = {
  mainProviderImplementations: {
    CHAT_PROVIDER: ["mock", "pipeline"],
    VOICE_PROVIDER: ["mock", "pipeline", "pocket-tts", "fish-audio"],
    MODERATION_PROVIDER: ["mock", "safety-gateway"],
    PAYMENT_PROVIDER: ["mock", "btcpay"],
    BLOB_PROVIDER: ["mock", "r2", "s3"],
    AGE_VERIFICATION_PROVIDER: ["mock", "gocam"],
  },
  genImageProviders: ["mock", "pipeline", "backend"],
  genVideoProviders: ["mock", "pipeline", "backend"],
};

const developmentSecret = "development-only-secret-change-before-production";

function mergeCapabilities(
  override: LaunchReadinessCapabilityOverride | undefined,
): LaunchReadinessCapabilities {
  return {
    mainProviderImplementations: {
      ...currentLaunchCapabilities.mainProviderImplementations,
      ...override?.mainProviderImplementations,
    },
    genImageProviders:
      override?.genImageProviders ??
      currentLaunchCapabilities.genImageProviders,
    genVideoProviders:
      override?.genVideoProviders ??
      currentLaunchCapabilities.genVideoProviders,
  };
}

function summarize(checks: LaunchReadinessCheck[]) {
  return checks.reduce<Record<LaunchReadinessStatus, number>>(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, fail: 0, warn: 0 },
  );
}

function isUrl(value: string | undefined) {
  if (!value || isPlaceholderValue(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function sentryProjectId(value: string | undefined) {
  if (!value || !isUrl(value)) return null;
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? null;
  } catch {
    return null;
  }
}

function isPostgresUrl(value: string | undefined) {
  return (
    !isPlaceholderValue(value) &&
    (value?.startsWith("postgresql://") || value?.startsWith("postgres://"))
  );
}

function postgresUser(value: string | undefined) {
  if (!value || !isPostgresUrl(value)) return undefined;
  try {
    return decodeURIComponent(new URL(value).username);
  } catch {
    return undefined;
  }
}

function isChatServiceDatabaseUrl(value: string | undefined) {
  return isPostgresUrl(value) && postgresUser(value) === "chat_service";
}

// INTENT: 非生产的 prefix 默认值由 env 契约推导，不在这里第二次抄一遍字面量 ——
// 三个服务的 env.ts 早先各抄一份默认值，这里再抄一份，同一条不变量四处防守而无一处定义。
// "idream:chat" / "idream:gen" 是服务本地的历史默认值，契约里没有，保留为显式历史项。
const NON_PRODUCTION_BULLMQ_PREFIXES = new Set([
  ...(["development", "test"] as const).map((appEnv) =>
    defaultBullmqPrefix(appEnv),
  ),
  "idream:chat",
  "idream:gen",
]);

function isProductionBullmqPrefix(value: string | undefined) {
  if (typeof value !== "string" || !hasMinLength(value, 1)) return false;
  return !NON_PRODUCTION_BULLMQ_PREFIXES.has(value);
}

function isDurableChatFsRoot(value: string | undefined) {
  if (typeof value !== "string" || !hasMinLength(value, 1)) return false;
  return path.isAbsolute(value);
}

function hasMinLength(value: string | undefined, minLength: number) {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    !isPlaceholderValue(value)
  );
}

function genAuthorityValue(
  env: EnvLike,
  sanitizedKey: string,
  legacyKey: string,
) {
  return env[sanitizedKey] !== undefined
    ? env[sanitizedKey]
    : env[legacyKey];
}

function isPlaceholderValue(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return [
    "replace-with",
    "example.com",
    "example.net",
    "example.org",
    "account-id",
    "public-key@",
    "dev-",
    "development",
    "local-check",
    "changeme",
    "change-me",
    "placeholder",
  ].some((marker) => normalized.includes(marker));
}

function kebab(value: string) {
  return value.toLowerCase().replaceAll("_", "-");
}

function addCheck(checks: LaunchReadinessCheck[], check: LaunchReadinessCheck) {
  checks.push(check);
}

// SPEC: 每个 probe 的判定都以“证据够新吗”收尾，此前是 11 份逐字相同的复制。
// INVARIANT: push 顺序与文案必须保持原样 —— 它们会被 join 进 check.message。
function addProbeFreshnessProblems(
  problems: string[],
  env: EnvLike,
  name: ProbeName,
  checkedAtValue: string | null | undefined,
  now: Date,
) {
  const checkedAt = parseProbeDate(checkedAtValue);
  if (!checkedAt) {
    problems.push("probe checkedAt is missing or invalid");
    return;
  }
  const maxAgeMs = probeMaxAgeMs(env, PROBE_REPORTS[name].maxAgeEnvKey);
  if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
    problems.push(
      `probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`,
    );
  }
  if (checkedAt.getTime() - now.getTime() > 60_000) {
    problems.push("probe checkedAt is in the future");
  }
}

/** `<KEY> is not set` —— KEY 从注册表取，不再由每个检查各写一遍字面量。 */
function probeReportPathValue(env: EnvLike, name: ProbeName) {
  return env[PROBE_REPORTS[name].reportEnvKey];
}

function addMissingProbeReportProblem(
  problems: string[],
  env: EnvLike,
  name: ProbeName,
) {
  if (!probeReportPathValue(env, name)) {
    problems.push(`${PROBE_REPORTS[name].reportEnvKey} is not set`);
  }
}

function addRequiredCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  spec: {
    id: string;
    area: string;
    key: string;
    label: string;
    minLength?: number;
    url?: boolean;
    remediation: string;
  },
) {
  const value = env[spec.key];
  const present =
    spec.url === true ? isUrl(value) : hasMinLength(value, spec.minLength ?? 1);

  addCheck(checks, {
    id: spec.id,
    area: spec.area,
    status: present ? "pass" : "fail",
    message: present
      ? `${spec.label} is configured.`
      : `${spec.label} is missing or invalid.`,
    remediation: present ? undefined : spec.remediation,
  });
}

function addAtLeastOneCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  spec: {
    id: string;
    area: string;
    keys: readonly string[];
    label: string;
    remediation: string;
  },
) {
  const present = spec.keys.some((key) => hasMinLength(env[key], 1));
  addCheck(checks, {
    id: spec.id,
    area: spec.area,
    status: present ? "pass" : "fail",
    message: present
      ? `${spec.label} is configured.`
      : `${spec.label} is missing.`,
    remediation: present ? undefined : spec.remediation,
  });
}

function addValueCheck(
  checks: LaunchReadinessCheck[],
  spec: {
    id: string;
    area: string;
    label: string;
    value: string | undefined;
    minLength?: number;
    url?: boolean;
    remediation: string;
  },
) {
  const present =
    spec.url === true
      ? isUrl(spec.value)
      : hasMinLength(spec.value, spec.minLength ?? 1);

  addCheck(checks, {
    id: spec.id,
    area: spec.area,
    status: present ? "pass" : "fail",
    message: present
      ? `${spec.label} is configured.`
      : `${spec.label} is missing or invalid.`,
    remediation: present ? undefined : spec.remediation,
  });
}

function addProviderChecks(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  capabilities: LaunchReadinessCapabilities,
  scope: LaunchScope,
) {
  const providerKeys = mainProviderKeysForLaunchScope(scope);
  const requiredNonMockProviders = new Set(
    requiredNonMockMainProviderKeysForLaunchScope(scope),
  );

  for (const key of providerKeys) {
    const configured = env[key] ?? "mock";
    const providerId = kebab(key);
    const mockAllowed = !requiredNonMockProviders.has(key);

    addCheck(checks, {
      id: `${providerId}-non-mock`,
      area: "Providers",
      status: configured !== "mock" || mockAllowed ? "pass" : "fail",
      message:
        configured !== "mock"
          ? `${key}=${configured} is not mock.`
          : mockAllowed
            ? `${key}=mock is allowed by the current launch scope.`
            : `${key} is still mock.`,
      remediation: mockAllowed
        ? undefined
        : `Configure a production ${key} adapter and credentials before launch.`,
    });

    if (configured === "mock") continue;

    const supported = capabilities.mainProviderImplementations[key] ?? [];
    const implementationReady = supported.includes(configured);
    addCheck(checks, {
      id: `${providerId}-implementation`,
      area: "Providers",
      status: implementationReady ? "pass" : "fail",
      message: implementationReady
        ? `${key}=${configured} is supported by this build.`
        : `${key}=${configured} is configured, but this build only wires: ${supported.join(", ")}.`,
      remediation: implementationReady
        ? undefined
        : `Implement and test the ${configured} adapter for ${key}.`,
    });
  }

  if (env.CHAT_PROVIDER === "pipeline") {
    addValueCheck(checks, {
      id: "main-chat-pipeline-api-url",
      area: "Chat",
      label: "Main pipeline chat API URL",
      value: env.PIPELINE_API_URL,
      url: true,
      remediation:
        "Set PIPELINE_API_URL in Main's production environment; CHAT_MODEL_BASE_URL configures the split Chat service and cannot replace it.",
    });
    addValueCheck(checks, {
      id: "main-chat-pipeline-api-token",
      area: "Chat",
      label: "Main pipeline chat API token",
      value: env.PIPELINE_API_TOKEN,
      minLength: 16,
      remediation:
        "Set PIPELINE_API_TOKEN in Main's production environment; CHAT_MODEL_API_KEY configures the split Chat service and cannot replace it.",
    });
  }
}

function addChatServiceChecks(checks: LaunchReadinessCheck[], env: EnvLike) {
  const chatModelProvider =
    env.CHAT_MODEL_PROVIDER ?? env.CHAT_PROVIDER ?? "mock";
  const supportedChatModelProviders = ["openai", "pipeline"];
  const chatRedisUrl = env.CHAT_REDIS_URL ?? env.REDIS_URL;

  addCheck(checks, {
    id: "chat-database-url",
    area: "Chat",
    status: isChatServiceDatabaseUrl(env.CHAT_DATABASE_URL) ? "pass" : "fail",
    message: isChatServiceDatabaseUrl(env.CHAT_DATABASE_URL)
      ? "CHAT_DATABASE_URL uses the chat_service Postgres role."
      : "CHAT_DATABASE_URL is missing, not Postgres, or not using the chat_service role.",
    remediation:
      "Set CHAT_DATABASE_URL to the production Postgres URL for the chat_service role; do not reuse main-web DATABASE_URL.",
  });

  addValueCheck(checks, {
    id: "chat-redis-url",
    area: "Chat",
    label: "Chat Redis URL",
    value: chatRedisUrl,
    url: true,
    remediation:
      "Set CHAT_REDIS_URL or shared REDIS_URL so packages/chat uses the production queue Redis instance.",
  });

  addCheck(checks, {
    id: "chat-fs-root",
    area: "Chat",
    status: isDurableChatFsRoot(env.CHAT_FS_ROOT) ? "pass" : "fail",
    message: isDurableChatFsRoot(env.CHAT_FS_ROOT)
      ? "CHAT_FS_ROOT is an absolute durable-storage path."
      : "CHAT_FS_ROOT is missing or not an absolute durable-storage path.",
    remediation:
      "Set CHAT_FS_ROOT to an absolute path mounted on durable storage for chat logs and memories.",
  });

  addCheck(checks, {
    id: "chat-model-provider",
    area: "Chat",
    status: supportedChatModelProviders.includes(chatModelProvider)
      ? "pass"
      : "fail",
    message: supportedChatModelProviders.includes(chatModelProvider)
      ? `Chat model provider is ${chatModelProvider}.`
      : `Chat model provider is ${chatModelProvider}.`,
    remediation:
      "Set CHAT_MODEL_PROVIDER=pipeline or openai for packages/chat; mock is not production-ready.",
  });

  addValueCheck(checks, {
    id: "chat-model-base-url",
    area: "Chat",
    label: "Chat model base URL",
    value: env.CHAT_MODEL_BASE_URL ?? env.PIPELINE_API_URL,
    url: true,
    remediation:
      "Set CHAT_MODEL_BASE_URL or PIPELINE_API_URL to the production OpenAI-compatible chat gateway.",
  });

  addValueCheck(checks, {
    id: "chat-model-api-key",
    area: "Chat",
    label: "Chat model API key",
    value: env.CHAT_MODEL_API_KEY ?? env.PIPELINE_API_TOKEN,
    minLength: 16,
    remediation:
      "Set CHAT_MODEL_API_KEY or PIPELINE_API_TOKEN so packages/chat can authenticate to the chat gateway.",
  });
}

function addChatServiceProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ChatServiceProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "chatServiceProbe";

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (!sameUrl(probe.serviceUrl, env.CHAT_SERVICE_URL)) {
      problems.push("probe service URL does not match CHAT_SERVICE_URL");
    }
    if (probe.userId !== DEDICATED_CHAT_PROBE_USER_ID) {
      problems.push(
        `probe user id is not the dedicated actor ${DEDICATED_CHAT_PROBE_USER_ID}`,
      );
    }
    if (probe.actorDataClass !== "audit") {
      problems.push("probe actor is not classified as audit");
    }
    if (probe.dedicatedActor !== true) {
      problems.push("probe did not use a dedicated actor");
    }
    if (probe.usedSignedBff !== true) {
      problems.push("probe did not use signed BFF headers");
    }
    if (probe.health?.ok !== true || probe.health.status !== 200) {
      problems.push("healthz did not return HTTP 200 ok");
    }
    if (
      probe.signedRequest?.ok !== true ||
      probe.signedRequest.status !== 200
    ) {
      problems.push("signed chat request did not return HTTP 200");
    }
    let expectedChatFsFingerprint: string | null = null;
    try {
      if (env.CHAT_FS_ROOT) {
        expectedChatFsFingerprint = chatFsRootFingerprint(
          resolveChatFsRoot(
            env.CHAT_FS_ROOT,
            resolveWorkspacePath("packages/chat"),
          ),
        );
      }
    } catch {
      expectedChatFsFingerprint = null;
    }
    if (
      probe.runtimeAuthority?.ok !== true ||
      probe.runtimeAuthority.status !== 200 ||
      !expectedChatFsFingerprint ||
      probe.runtimeAuthority.chatFsRootFingerprint !==
        expectedChatFsFingerprint
    ) {
      problems.push(
        "signed Chat runtime authority does not match canonical CHAT_FS_ROOT",
      );
    }
    if (probe.unsignedRequest?.status !== 401) {
      problems.push("unsigned chat request was not rejected with HTTP 401");
    }
    if (
      probe.conversation?.attempted !== true ||
      probe.conversation.ok !== true
    ) {
      problems.push("conversation smoke did not complete");
    } else {
      if (probe.conversation.preflightCleanup?.ok !== true) {
        problems.push("conversation smoke did not clean prior audit state");
      }
      if (probe.conversation.createSession?.ok !== true) {
        problems.push("conversation smoke did not create a session");
      }
      if (probe.conversation.sendMessage?.ok !== true) {
        problems.push("conversation smoke did not send a message");
      }
      if (
        probe.conversation.stream?.ok !== true ||
        probe.conversation.stream.sawStart !== true ||
        probe.conversation.stream.sawDelta !== true ||
        probe.conversation.stream.sawDone !== true
      ) {
        problems.push(
          "conversation smoke did not observe start/delta/done stream events",
        );
      }
      if (
        probe.conversation.getSession?.ok !== true ||
        probe.conversation.getSession.assistantSent !== true ||
        probe.conversation.getSession.derivationSettled !== true
      ) {
        problems.push(
          "conversation smoke did not reload the assistant message",
        );
      }
      if (
        probe.conversation.regenerateAnchor?.ok !== true ||
        probe.conversation.regenerateAnchor.originalSceneVersion !== 0 ||
        probe.conversation.regenerateAnchor.futureUserSceneVersion !== 1 ||
        probe.conversation.regenerateAnchor.futureSceneVersion !== 1 ||
        probe.conversation.regenerateAnchor.regeneratedSceneVersion !== 0
      ) {
        problems.push(
          "conversation smoke did not prove old-turn Scene anchoring",
        );
      }
      if (
        probe.conversation.noMemory?.ok !== true ||
        probe.conversation.noMemory.authorityPinned !== true ||
        probe.conversation.noMemory.relationshipUnchanged !== true ||
        probe.conversation.noMemory.memorySourceAbsent !== true
      ) {
        problems.push(
          "conversation smoke did not prove no-memory turn authority",
        );
      }
      if (
        probe.conversation.blockedInput?.ok !== true ||
        probe.conversation.blockedInput.status_ !== "blocked"
      ) {
        problems.push(
          "conversation smoke did not prove blocked input handling",
        );
      }
      if (
        probe.conversation.cleanup?.ok !== true ||
        probe.conversation.cleanup.sessionDeleted !== true ||
        probe.conversation.cleanup.memoryGone !== true ||
        probe.conversation.cleanup.relationshipDeleted !== true ||
        probe.conversation.cleanup.relationshipsGone !== true ||
        probe.conversation.cleanup.sessionGone !== true
      ) {
        problems.push("conversation smoke did not clean its audit state");
      }
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "chat-service-live-probe",
    area: "Chat",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent chat service probe used a dedicated audit actor, reached signed/unsigned boundaries, proved per-turn no-memory authority, and cleaned visible audit state."
        : `Chat service probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:chat-service -- --report .tmp/launch-chat-service-probe.json\` against the real chat service, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addChatModelProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ChatModelProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "chatModelProbe";
  const configuredProvider =
    env.CHAT_MODEL_PROVIDER ?? env.CHAT_PROVIDER ?? "mock";
  const configuredBaseUrl = env.CHAT_MODEL_BASE_URL ?? env.PIPELINE_API_URL;
  const configuredModel =
    env.CHAT_MODEL_NAME ?? env.PIPELINE_CHAT_MODEL_DEFAULT;

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider !== "mock") {
      if (!sameUrl(probe.baseUrl, configuredBaseUrl)) {
        problems.push(
          "probe base URL does not match CHAT_MODEL_BASE_URL or PIPELINE_API_URL",
        );
      }
      if (hasMinLength(configuredModel, 1) && probe.model !== configuredModel) {
        problems.push(
          "probe model does not match CHAT_MODEL_NAME or PIPELINE_CHAT_MODEL_DEFAULT",
        );
      }
    }
    if ((probe.chunks ?? 0) < 1) {
      problems.push("probe produced no response chunks");
    }
    if ((probe.characters ?? 0) < 1) {
      problems.push("probe produced no assistant text");
    }
    if (looksLikeMockChatResponse(probe.assistantPreview ?? "")) {
      problems.push("probe assistant text is a mock/template response");
    }
    if (probe.done !== true) {
      problems.push("probe stream did not finish");
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "chat-model-live-probe",
    area: "Chat",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent chat model probe authenticated and received a complete assistant response."
        : `Chat model probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:chat -- --report .tmp/launch-chat-probe.json\` against the real chat model gateway, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addAdminTextProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: AdminTextProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "adminTextProbe";
  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== env.CHAT_PROVIDER) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${env.CHAT_PROVIDER ?? "unset"}`,
      );
    }
    for (const [label, runtime] of [
      ["Character Assist", probe.characterAssist?.runtime],
      ["Production Directions", probe.productionDirections?.runtime],
    ] as const) {
      if (
        runtime?.provider !== probe.provider ||
        !sameUrl(runtime?.pipelineUrl, probe.pipelineUrl) ||
        runtime?.model !== probe.model
      ) {
        problems.push(`${label} runtime identity is missing or inconsistent`);
      }
    }
    if (!sameUrl(probe.pipelineUrl, env.PIPELINE_API_URL)) {
      problems.push("probe pipeline URL does not match Main PIPELINE_API_URL");
    }
    if (probe.model !== env.PIPELINE_CHAT_MODEL_DEFAULT) {
      problems.push(
        "probe model does not match Main PIPELINE_CHAT_MODEL_DEFAULT",
      );
    }
    if (!sameUrl(probe.adminUrl, env.ADMIN_WEB_URL)) {
      problems.push("probe Admin URL does not match ADMIN_WEB_URL");
    }
    if (
      !hasMinLength(env.ADMIN_TEXT_PROBE_CHARACTER_ID, 1) ||
      probe.characterId !== env.ADMIN_TEXT_PROBE_CHARACTER_ID
    ) {
      problems.push(
        "probe Character does not match ADMIN_TEXT_PROBE_CHARACTER_ID",
      );
    }
    if (probe.authMode !== "cookie" && probe.authMode !== "authorization") {
      problems.push("probe did not use an authenticated Admin credential");
    }
    if (!hasMinLength(probe.correlationId ?? undefined, 1)) {
      problems.push("probe correlation id is missing");
    }
    if (
      probe.requestIds?.characterAssist !== `${probe.correlationId}-assist` ||
      probe.requestIds?.productionDirections !==
        `${probe.correlationId}-directions`
    ) {
      problems.push("probe request ids are not bound to its correlation id");
    }
    if (
      probe.characterAssist?.ok !== true ||
      probe.characterAssist.status !== 200 ||
      (probe.characterAssist.descriptionCharacters ?? 0) < 1 ||
      (probe.characterAssist.nameIdeas ?? 0) < 1 ||
      (probe.characterAssist.personalityCharacters ?? 0) < 1 ||
      (probe.characterAssist.speakingStyleCharacters ?? 0) < 1 ||
      (probe.characterAssist.firstMessageCharacters ?? 0) < 1 ||
      (probe.characterAssist.visualBriefCharacters ?? 0) < 1
    ) {
      problems.push("Character Assist did not return the complete structured draft");
    }
    if (
      probe.productionDirections?.ok !== true ||
      probe.productionDirections.status !== 200 ||
      probe.productionDirections.directions !== 4 ||
      probe.productionDirections.source !== "model" ||
      (probe.productionDirections.scenePromptCharacters ?? 0) < 1
    ) {
      problems.push(
        "Production Directions did not return four structured model directions",
      );
    }
    if (
      probe.cleanup?.fixture !== "not_created" ||
      probe.cleanup.immutableModerationAudit !== "retained_by_authority"
    ) {
      problems.push("probe side-effect accounting is missing or invalid");
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "admin-text-live-probe",
    area: "Admin",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent authenticated Admin probe exercised Character Assist and Production Directions and observed Main's exact pipeline runtime identity."
        : `Admin text probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:admin-text -- --allow-immutable-audit --character-id <reviewed-character-id> --report .tmp/launch-admin-text-probe.json\` with an authenticated Admin credential, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch. Character Assist retains immutable moderation audit rows.`,
  });
}

function addVoiceModelProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: VoiceModelProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "voiceModelProbe";
  const configuredProvider = env.VOICE_PROVIDER ?? "mock";
  const configuredBaseUrl =
    configuredProvider === "fish-audio"
      ? env.FISH_AUDIO_API_URL
      : configuredProvider === "pocket-tts"
        ? env.POCKET_TTS_API_URL
        : (env.PIPELINE_VOICE_API_URL ?? env.PIPELINE_API_URL);
  const configuredModel =
    configuredProvider === "fish-audio"
      ? env.FISH_AUDIO_MODEL
      : configuredProvider === "pocket-tts"
        ? env.POCKET_TTS_MODEL
        : env.PIPELINE_VOICE_MODEL_DEFAULT;

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider === "pipeline") {
      if (!sameUrl(probe.baseUrl, configuredBaseUrl)) {
        problems.push(
          "probe base URL does not match PIPELINE_VOICE_API_URL or PIPELINE_API_URL",
        );
      }
      if (hasMinLength(configuredModel, 1) && probe.model !== configuredModel) {
        problems.push(
          "probe model does not match PIPELINE_VOICE_MODEL_DEFAULT",
        );
      }
    }
    if (configuredProvider === "pocket-tts") {
      if (!sameUrl(probe.baseUrl, configuredBaseUrl)) {
        problems.push("probe base URL does not match POCKET_TTS_API_URL");
      }
      if (hasMinLength(configuredModel, 1) && probe.model !== configuredModel) {
        problems.push("probe model does not match POCKET_TTS_MODEL");
      }
      if (probe.voiceCloningAvailable !== true) {
        problems.push("Pocket TTS probe did not confirm oMLX voice cloning");
      }
      if (probe.voiceCloneVerified !== true) {
        problems.push(
          "Pocket TTS probe did not complete clone, synthesize, and delete",
        );
      }
    }
    if (configuredProvider === "fish-audio") {
      if (!sameUrl(probe.baseUrl, configuredBaseUrl)) {
        problems.push("probe base URL does not match FISH_AUDIO_API_URL");
      }
      if (hasMinLength(configuredModel, 1) && probe.model !== configuredModel) {
        problems.push("probe model does not match FISH_AUDIO_MODEL");
      }
      if (probe.voiceCloningAvailable !== true) {
        problems.push("Fish Audio probe did not confirm MLX voice cloning");
      }
      if (probe.voiceCloneVerified !== true) {
        problems.push(
          "Fish Audio probe did not complete clone, synthesize, and delete",
        );
      }
    }
    if (!hasMinLength(probe.key ?? undefined, 1)) {
      problems.push("probe did not return a voice asset key");
    }
    if ((probe.audioDurationMs ?? 0) <= 0) {
      problems.push("probe returned no positive audio duration");
    }
    if (probe.bytes !== undefined && probe.bytes <= 0) {
      problems.push("probe stored an empty audio payload");
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "voice-model-live-probe",
    area: "Generation",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent voice model probe authenticated and produced a voice asset."
        : `Voice model probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json\` against the real voice model gateway, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addChatModerationChecks(checks: LaunchReadinessCheck[], env: EnvLike) {
  const chatModerationProvider =
    env.CHAT_MODERATION_PROVIDER ?? env.MODERATION_PROVIDER ?? "mock";
  const externalModerationEnabled = chatModerationProvider === "safety-gateway";
  addCheck(checks, {
    id: "chat-moderation-provider",
    area: "Chat",
    status:
      chatModerationProvider === "mock" || externalModerationEnabled
        ? "pass"
        : "fail",
    message: `Chat moderation provider is ${chatModerationProvider}.`,
    remediation:
      "Set CHAT_MODERATION_PROVIDER to a supported provider: mock or safety-gateway.",
  });

  if (!externalModerationEnabled) {
    addCheck(checks, {
      id: "chat-moderation-service-url",
      area: "Chat",
      status: "pass",
      message: `Chat moderation provider ${chatModerationProvider} does not require CHAT_MODERATION_SERVICE_URL.`,
    });
    addCheck(checks, {
      id: "chat-moderation-api-key",
      area: "Chat",
      status: "pass",
      message: `Chat moderation provider ${chatModerationProvider} does not require CHAT_MODERATION_API_KEY.`,
    });
    return;
  }

  addValueCheck(checks, {
    id: "chat-moderation-service-url",
    area: "Chat",
    label: "Chat moderation service URL",
    value: env.CHAT_MODERATION_SERVICE_URL ?? env.MODERATION_SERVICE_URL,
    url: true,
    remediation:
      "Set CHAT_MODERATION_SERVICE_URL or MODERATION_SERVICE_URL to the production safety gateway.",
  });

  addValueCheck(checks, {
    id: "chat-moderation-api-key",
    area: "Chat",
    label: "Chat moderation API key",
    value: env.CHAT_MODERATION_API_KEY ?? env.MODERATION_API_KEY,
    minLength: 16,
    remediation:
      "Set CHAT_MODERATION_API_KEY or MODERATION_API_KEY to the production safety gateway token.",
  });
}

function addPaymentProviderProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: PaymentProviderProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "paymentProviderProbe";
  const configuredProvider = env.PAYMENT_PROVIDER ?? "mock";

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider === "btcpay") {
      if (!sameUrl(probe.baseUrl, env.BTCPAY_BASE_URL)) {
        problems.push("probe base URL does not match BTCPAY_BASE_URL");
      }
      if (
        hasMinLength(env.BTCPAY_STORE_ID, 1) &&
        probe.storeId !== env.BTCPAY_STORE_ID
      ) {
        problems.push("probe store id does not match BTCPAY_STORE_ID");
      }
      if (probe.canViewStore !== true) {
        problems.push("probe could not read the BTCPay store");
      }
      if (probe.canLookupInvoice !== true) {
        problems.push(
          "probe could not look up the product-bound BTCPay invoice",
        );
      }
      if (!hasMinLength(probe.invoiceId ?? undefined, 1)) {
        problems.push("probe did not return a BTCPay invoice id");
      }
      if (!isPublicHttpsUrl(probe.checkoutUrl ?? undefined)) {
        problems.push(
          "probe did not return a public HTTPS BTCPay checkout URL",
        );
      }
      if ((probe.invoiceAmountCents ?? 0) <= 0) {
        problems.push(
          "product-bound BTCPay invoice amount is missing or invalid",
        );
      }
      if (!/^[A-Z]{3}$/.test(probe.invoiceCurrency ?? "")) {
        problems.push(
          "product-bound BTCPay invoice currency is missing or invalid",
        );
      }
      if (
        hasMinLength(env.BTCPAY_STORE_ID, 1) &&
        probe.returnedStoreId !== env.BTCPAY_STORE_ID
      ) {
        problems.push("BTCPay returned a different store id");
      }
      const terminal = probe.terminal;
      if (!terminal) {
        problems.push("product checkout settlement evidence is missing");
      } else {
        if (terminal.authorityVersion !== "payment_product_settlement_v1") {
          problems.push(
            "product checkout settlement authority version is missing or unsupported",
          );
        }
        if (!hasMinLength(terminal.checkoutId ?? undefined, 1)) {
          problems.push("product checkout id is missing");
        }
        if (terminal.checkoutStatus !== "completed") {
          problems.push(
            `product checkout is ${terminal.checkoutStatus ?? "unknown"}, not completed`,
          );
        }
        if (!isInternalReturnPath(terminal.checkoutReturnPath)) {
          problems.push("product checkout return path is missing or unsafe");
        }
        if (
          !terminal.providerInvoiceId ||
          terminal.providerInvoiceId !== probe.invoiceId
        ) {
          problems.push(
            "settled provider invoice does not match the checkout probe invoice",
          );
        }
        if (terminal.providerInvoiceStatus !== "settled") {
          problems.push("provider invoice is not settled");
        }
        if (
          !new Set(["none", "marked", "paid_late", "paid_over"]).has(
            terminal.providerInvoiceAdditionalStatus ?? "",
          )
        ) {
          problems.push(
            "provider invoice additional status is not an accepted settlement",
          );
        }
        if (terminal.providerLookupVerified !== true) {
          problems.push(
            "provider invoice lookup did not verify the settled product order",
          );
        }
        if (
          !hasMinLength(terminal.providerEventId ?? undefined, 1) ||
          terminal.providerEventType !== "invoice.confirmed" ||
          !parseProbeDate(terminal.providerEventProcessedAt)
        ) {
          problems.push(
            "signed settlement webhook evidence is missing or unprocessed",
          );
        }
        if (
          !/^[a-f0-9]{64}$/.test(terminal.providerEventTargetHash ?? "") ||
          !Array.isArray(terminal.providerDeliveryIds) ||
          terminal.providerDeliveryIds.length !==
            terminal.providerDeliveryCount ||
          new Set(terminal.providerDeliveryIds).size !==
            terminal.providerDeliveryIds.length ||
          !Array.isArray(terminal.providerDeliveryPayloadHashes) ||
          terminal.providerDeliveryPayloadHashes.length !==
            terminal.providerDeliveryCount ||
          terminal.providerDeliveryPayloadHashes.some(
            (hash) => !/^[a-f0-9]{64}$/.test(hash),
          ) ||
          (terminal.providerDeliveryCount ?? 0) < 2 ||
          terminal.replayVerified !== true
        ) {
          problems.push(
            "signed settlement webhook replay was not proven idempotent",
          );
        }
        if (
          !hasMinLength(terminal.subscriptionId ?? undefined, 1) ||
          terminal.subscriptionEffectCount !== 1 ||
          !new Set(["active", "checkout_completed"]).has(
            terminal.subscriptionStatus ?? "",
          )
        ) {
          problems.push(
            "settled checkout did not produce subscription authority",
          );
        }
        if ((terminal.entitlementCount ?? 0) < 1) {
          problems.push(
            "settled checkout did not produce subscription entitlements",
          );
        }
        if (
          !hasMinLength(terminal.ledgerEntryId ?? undefined, 1) ||
          terminal.ledgerEntryCount !== 1
        ) {
          problems.push(
            "settled checkout did not produce exactly one ledger grant",
          );
        }
      }
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "payment-provider-live-probe",
    area: "Billing",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent payment provider evidence proved a product checkout, signed webhook replay, provider settlement, subscription, entitlements, and exactly one ledger grant."
        : `Payment provider probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Complete and replay a small checkout through the real product flow, then run \`bun run --filter @idream/main probe:payment -- --checkout-id <checkout-id> --report .tmp/launch-payment-probe.json\` with read-only Main DB and BTCPay access. Set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addAgeVerificationProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: AgeVerificationProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "ageVerificationProbe";
  const configuredProvider = env.AGE_VERIFICATION_PROVIDER ?? "mock";

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider === "gocam") {
      if (!sameUrl(probe.serviceUrl, env.AGE_VERIFY_SERVICE_URL)) {
        problems.push(
          "probe service URL does not match AGE_VERIFY_SERVICE_URL",
        );
      }
      if (!hasMinLength(probe.providerVerificationId ?? undefined, 1)) {
        problems.push("probe did not return a provider verification id");
      }
      if (probe.status !== "verified") {
        problems.push(
          `probe product verification is ${probe.status ?? "unknown"}, not verified`,
        );
      }
      if (!isPublicHttpsUrl(probe.url ?? undefined)) {
        problems.push("probe verification URL is missing or not public HTTPS");
      }
      const terminal = probe.terminal;
      if (!terminal) {
        problems.push("verified callback evidence is missing");
      } else {
        if (terminal.authorityVersion !== "age_verified_callback_v1") {
          problems.push(
            "verified callback authority version is missing or unsupported",
          );
        }
        if (!hasMinLength(terminal.verificationId ?? undefined, 1)) {
          problems.push("local age verification id is missing");
        }
        if (
          terminal.verificationStatus !== "verified" ||
          !parseProbeDate(terminal.verifiedAt)
        ) {
          problems.push(
            "age verification did not reach a verified terminal state",
          );
        }
        if (!sameUrl(terminal.callbackUrl, env.AGE_VERIFY_CALLBACK_URL)) {
          problems.push(
            "verified callback evidence does not match AGE_VERIFY_CALLBACK_URL",
          );
        }
        if (!sameUrl(terminal.linkBackUrl, env.AGE_VERIFY_LINK_BACK_URL)) {
          problems.push(
            "verified return evidence does not match AGE_VERIFY_LINK_BACK_URL",
          );
        }
        if (
          !hasMinLength(terminal.providerEventId ?? undefined, 1) ||
          terminal.providerEventType !== "age.verification" ||
          !parseProbeDate(terminal.providerEventProcessedAt)
        ) {
          problems.push(
            "signed verified callback evidence is missing or unprocessed",
          );
        }
        if (
          !/^[a-f0-9]{64}$/.test(terminal.providerEventTargetHash ?? "") ||
          !/^[a-f0-9]{64}$/.test(terminal.providerPayloadHash ?? "") ||
          terminal.verificationEffectCount !== 1 ||
          !Array.isArray(terminal.providerDeliveryIds) ||
          terminal.providerDeliveryIds.length !==
            terminal.providerDeliveryCount ||
          new Set(terminal.providerDeliveryIds).size !==
            terminal.providerDeliveryIds.length ||
          !Array.isArray(terminal.providerDeliveryPayloadHashes) ||
          terminal.providerDeliveryPayloadHashes.length !==
            terminal.providerDeliveryCount ||
          terminal.providerDeliveryPayloadHashes.some(
            (hash) => !/^[a-f0-9]{64}$/.test(hash),
          ) ||
          (terminal.providerDeliveryCount ?? 0) < 2 ||
          terminal.replayVerified !== true
        ) {
          problems.push("signed age callback replay was not proven idempotent");
        }
      }
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "age-verification-live-probe",
    area: "Compliance",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent age verification evidence proved a product session, signed verified callback, idempotent replay, and configured return path."
        : `Age verification probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Complete and replay a verification through the real signed-in product flow, then run \`bun run --filter @idream/main probe:age -- --age-verification-id <verification-id> --report .tmp/launch-age-probe.json\` with read-only Main DB access. Set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addSentryCanaryProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probes: Readonly<
    Record<SentryCanaryService, SentryCanaryProbeEvidence | null>
  >,
  now: Date,
) {
  const problems: string[] = [];

  for (const service of Object.keys(
    SENTRY_CANARY_PROBE_NAMES,
  ) as SentryCanaryService[]) {
    const probeName = SENTRY_CANARY_PROBE_NAMES[service];
    const probe = probes[service];
    const prefix = `${service} runtime`;
    addMissingProbeReportProblem(problems, env, probeName);
    if (!probe) {
      problems.push(`${prefix} report was not loaded`);
      continue;
    }
    if (probe.loadError) {
      problems.push(`${prefix}: ${probe.loadError}`);
      continue;
    }
    if (probe.ok !== true)
      problems.push(`${prefix} probe did not complete successfully`);
    if (probe.provider !== "sentry")
      problems.push(`${prefix} probe provider is not sentry`);
    if (probe.service !== service) {
      problems.push(`${prefix} report service is not ${service}`);
    }
    if (probe.emitter !== SENTRY_CANARY_EMITTERS[service]) {
      problems.push(
        `${prefix} emitter is not ${SENTRY_CANARY_EMITTERS[service]}`,
      );
    }
    if (
      !hasMinLength(env.SENTRY_RELEASE, 1) ||
      probe.release !== env.SENTRY_RELEASE
    ) {
      problems.push(`${prefix} release does not match SENTRY_RELEASE`);
    }
    if (probe.verified !== true) {
      problems.push(
        `${prefix} canary event was not verified through the Sentry API`,
      );
    }
    if (!/^sentry-canary-[0-9a-z-]+$/i.test(probe.correlationId ?? "")) {
      problems.push(`${prefix} probe correlation id is missing or invalid`);
    }
    if (!/^[0-9a-f]{32}$/i.test(probe.eventId ?? "")) {
      problems.push(`${prefix} probe event id is missing or invalid`);
    }
    const configuredProjectId = sentryProjectId(env.SENTRY_DSN);
    if (!configuredProjectId || probe.projectId !== configuredProjectId) {
      problems.push(`${prefix} probe project id does not match SENTRY_DSN`);
    }
    const checkedAt = parseProbeDate(probe.checkedAt);
    const verifiedAt = parseProbeDate(probe.verifiedAt);
    if (
      !verifiedAt ||
      (checkedAt && verifiedAt.getTime() < checkedAt.getTime())
    ) {
      problems.push(
        `${prefix} probe verifiedAt is missing or precedes checkedAt`,
      );
    }
    const freshnessProblems: string[] = [];
    addProbeFreshnessProblems(
      freshnessProblems,
      env,
      probeName,
      probe.checkedAt,
      now,
    );
    problems.push(
      ...freshnessProblems.map((problem) => `${prefix} ${problem}`),
    );
  }

  addCheck(checks, {
    id: "sentry-live-probe",
    area: "Observability",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent Main, Admin, Chat, and Gen Sentry canaries were ingested and resolved with their correlation ids."
        : `Sentry canary evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : "Run each package-specific `probe:sentry` command for Main, Admin, Chat, and Gen with a distinct `--report` path; reports cannot be relabeled across runtimes.",
  });
}

function addImagePipelineChecks(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  capabilities: LaunchReadinessCapabilities,
  probe: ImagePipelineProbeEvidence | null,
  productConfigProbe: ProductConfigProbeEvidence | null,
  now: Date,
) {
  const configured = env.GEN_IMAGE_PROVIDER ?? "mock";
  const genPipelineApiUrl = genAuthorityValue(
    env,
    "IDREAM_GEN_PIPELINE_API_URL",
    "PIPELINE_API_URL",
  );
  const genPipelineApiToken = genAuthorityValue(
    env,
    "IDREAM_GEN_PIPELINE_API_TOKEN",
    "PIPELINE_API_TOKEN",
  );
  const genComfyuiApiUrl = genAuthorityValue(
    env,
    "IDREAM_GEN_COMFYUI_API_URL",
    "COMFYUI_API_URL",
  );
  const genDrawThingsCli = genAuthorityValue(
    env,
    "IDREAM_GEN_DRAWTHINGS_CLI",
    "DRAWTHINGS_CLI",
  );
  const genImageModel = genAuthorityValue(
    env,
    "IDREAM_GEN_PIPELINE_IMAGE_MODEL_DEFAULT",
    "PIPELINE_IMAGE_MODEL_DEFAULT",
  );
  const supported = capabilities.genImageProviders.includes(configured);
  // "pipeline" (legacy OpenAI-compat gateway) and "backend" (P1: gen worker calls
  // ComfyUI/sd-cli directly via GenBackend) are both valid non-mock production
  // image providers — see packages/gen/src/providers.ts and docs/architecture.
  const isNonMockImageProvider =
    configured === "pipeline" || configured === "backend";

  addCheck(checks, {
    id: "gen-image-provider",
    area: "Generation",
    status: isNonMockImageProvider && supported ? "pass" : "fail",
    message:
      isNonMockImageProvider && supported
        ? `Image generation worker is configured for the ${configured} provider.`
        : `Image generation worker is configured as ${configured}.`,
    remediation:
      isNonMockImageProvider && supported
        ? undefined
        : "Set GEN_IMAGE_PROVIDER=pipeline or GEN_IMAGE_PROVIDER=backend (matching a supported build) and run the matching live probe against the real service.",
  });

  if (configured === "backend") {
    const hasDrawThings = hasMinLength(genDrawThingsCli, 1);
    const hasComfyui = hasMinLength(genComfyuiApiUrl, 1);

    if (hasDrawThings) {
      addValueCheck(checks, {
        id: "drawthings-cli",
        area: "Generation",
        label: "Draw Things CLI",
        value: genDrawThingsCli,
        minLength: 1,
        remediation:
          "Set DRAWTHINGS_CLI to the pinned executable used by drawthings workflows.",
      });
    }
    if (hasComfyui || !hasDrawThings) {
      addValueCheck(checks, {
        id: "comfyui-api-url",
        area: "Generation",
        label: "Gen ComfyUI API URL",
        value: genComfyuiApiUrl,
        url: true,
        remediation:
          "Set COMFYUI_API_URL, or configure DRAWTHINGS_CLI for the backend workflows in use.",
      });
    }
  } else if (configured === "pipeline") {
    addValueCheck(checks, {
      id: "pipeline-api-url",
      area: "Generation",
      label: "Gen pipeline API URL",
      value: genPipelineApiUrl,
      url: true,
      remediation:
        "Set PIPELINE_API_URL in Gen's production environment to the internal ComfyUI/Z-Image gateway.",
    });
    addValueCheck(checks, {
      id: "pipeline-api-token",
      area: "Generation",
      label: "Gen pipeline API token",
      value: genPipelineApiToken,
      minLength: 16,
      remediation:
        "Set PIPELINE_API_TOKEN in Gen's production environment so its worker authenticates to the pipeline.",
    });

    const model = genImageModel;
    addCheck(checks, {
      id: "pipeline-image-model",
      area: "Generation",
      status: hasMinLength(model, 1) ? "pass" : "warn",
      message: hasMinLength(model, 1)
        ? "Default image model is documented for the pipeline."
        : "Default image model is not set in product env.",
      remediation: hasMinLength(model, 1)
        ? undefined
        : "Set PIPELINE_IMAGE_MODEL_DEFAULT in Gen's production environment or document the default model in the pipeline service.",
    });
  }

  // INVARIANT: every production image adapter must prove one real execution.
  // The same Gen probe now binds either the OpenAI-compatible pipeline target
  // or the exact workflow-native backend and emits immutable TerminalRecord
  // evidence, so backend deployments cannot pass on configuration alone.
  addImagePipelineProbeCheck(checks, env, probe, productConfigProbe, now);
}

function addVideoPipelineChecks(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  capabilities: LaunchReadinessCapabilities,
  productConfigProbe: ProductConfigProbeEvidence | null,
) {
  const configured = env.GEN_VIDEO_PROVIDER ?? "mock";
  const genComfyuiApiUrl = genAuthorityValue(
    env,
    "IDREAM_GEN_COMFYUI_API_URL",
    "COMFYUI_API_URL",
  );
  if (!configured || configured === "mock") {
    const productConfigOk =
      productConfigProbe?.ok === true && !productConfigProbe.loadError;
    const videoFeatureEnabled =
      productConfigOk && productConfigProbe.videoFeatureEnabled === true;
    const videoFeatureDisabled =
      productConfigOk && productConfigProbe.videoFeatureEnabled === false;
    addCheck(checks, {
      id: "gen-video-provider",
      area: "Generation",
      status: videoFeatureDisabled
        ? "pass"
        : videoFeatureEnabled
          ? "fail"
          : "warn",
      message: videoFeatureDisabled
        ? "Video generation is disabled in product config; a production video provider is not required for launch."
        : videoFeatureEnabled
          ? "Video generation is enabled in product config but the video worker is not configured for a production provider."
          : "Video generation worker is not configured for a production provider; video must remain disabled.",
      remediation: videoFeatureDisabled
        ? undefined
        : "Keep the video_gen feature flag off, or set GEN_VIDEO_PROVIDER=backend with the pinned LTX workflow before enabling video generation.",
    });
    return;
  }

  const supported = capabilities.genVideoProviders.includes(configured);
  const isProductionProvider = configured === "backend";
  addCheck(checks, {
    id: "gen-video-provider",
    area: "Generation",
    status: isProductionProvider && supported ? "pass" : "fail",
    message:
      isProductionProvider && supported
        ? `Video generation worker is configured for the ${configured} provider.`
        : `Video generation worker is configured as ${configured}.`,
    remediation:
      isProductionProvider && supported
        ? undefined
        : "Use GEN_VIDEO_PROVIDER=backend with the pinned LTX workflow, or keep video generation disabled for launch.",
  });

  if (configured === "backend") {
    addValueCheck(checks, {
      id: "video-comfyui-api-url",
      area: "Generation",
      label: "Gen video ComfyUI API URL",
      value: genComfyuiApiUrl,
      url: true,
      remediation:
        "Set COMFYUI_API_URL in Gen's production environment to the ComfyUI runtime hosting the pinned LTX video workflow.",
    });
  }
}

function addVideoGenerationProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  productConfigProbe: ProductConfigProbeEvidence | null,
  probe: VideoGenerationProbeEvidence | null,
  now: Date,
) {
  const genComfyuiApiUrl = genAuthorityValue(
    env,
    "IDREAM_GEN_COMFYUI_API_URL",
    "COMFYUI_API_URL",
  );
  const probeName: ProbeName = "videoGenerationProbe";
  if (
    productConfigProbe?.ok === true &&
    !productConfigProbe.loadError &&
    productConfigProbe.videoFeatureEnabled === false
  ) {
    addCheck(checks, {
      id: "video-generation-live-probe",
      area: "Generation",
      status: "pass",
      message:
        "Video generation is disabled in authoritative product config; live video evidence is not required.",
    });
    return;
  }

  const problems: string[] = [];
  addMissingProbeReportProblem(problems, env, probeName);
  if (
    productConfigProbe?.ok !== true ||
    productConfigProbe.loadError ||
    productConfigProbe.videoFeatureEnabled !== true
  ) {
    problems.push(
      "authoritative product config does not prove whether video is enabled",
    );
  }
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== "backend") {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not backend`,
      );
    }
    if (probe.backendKind !== "comfyui") {
      problems.push(
        `probe backend is ${probe.backendKind ?? "unknown"}, not comfyui`,
      );
    }
    if (!sameUrl(probe.backendTarget, genComfyuiApiUrl)) {
      problems.push(
        "probe ComfyUI target does not match Gen ComfyUI authority",
      );
    }
    if (probe.workflowKey !== characterVideoProductionRecipe.workflowKey) {
      problems.push(
        "probe workflow does not match the production video recipe",
      );
    }
    if (
      probe.workflowVersion !== characterVideoProductionRecipe.workflowVersion
    ) {
      problems.push(
        "probe workflow version does not match the production video recipe",
      );
    }
    if (probe.model !== characterVideoProductionRecipe.workflowKey) {
      problems.push("probe model does not match the production video recipe");
    }
    if (probe.seconds !== characterVideoProductionRecipe.durationSeconds) {
      problems.push(
        "probe duration does not match the production video recipe",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(probe.referenceSha256 ?? "")) {
      problems.push("probe does not identify the exact source image bytes");
    }
    addGenBlobAuthorityProblems(problems, env, probe.blobAuthority);
    if (!probe.terminal) {
      problems.push("probe has no immutable terminal record evidence");
    } else {
      if (
        !hasMinLength(probe.terminal.ref ?? undefined, 1) ||
        !/^[a-f0-9]{64}$/.test(probe.terminal.checksum ?? "")
      ) {
        problems.push("probe terminal record reference or checksum is invalid");
      }
      if (probe.terminal.outcome !== "succeeded") {
        problems.push(
          `probe terminal outcome is ${probe.terminal.outcome ?? "unknown"}, not succeeded`,
        );
      }
      if ((probe.terminal.assets ?? 0) !== 1) {
        problems.push(
          "probe terminal record must contain exactly one video asset",
        );
      }
      if (probe.terminal.error !== null) {
        problems.push("probe terminal record contains an error");
      }
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "video-generation-live-probe",
    area: "Generation",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent video probe completed the exact production LTX workflow through the shared Blob authority and emitted a successful immutable terminal record."
        : `Video generation probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/gen probe:video -- --model ${characterVideoProductionRecipe.workflowKey} --reference <reviewed-character-image> --report .tmp/launch-video-probe.json\` against production ComfyUI and Blob, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addGenerationPersistenceProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  mode: "image" | "video",
  probe: GenerationPersistenceProbeEvidence | null,
  directProbe: ImagePipelineProbeEvidence | VideoGenerationProbeEvidence | null,
  productConfigProbe: ProductConfigProbeEvidence | null,
  now: Date,
) {
  const probeName: ProbeName =
    mode === "image"
      ? "imageGenerationPersistenceProbe"
      : "videoGenerationPersistenceProbe";
  const checkId = `generation-${mode}-main-persistence`;
  if (
    mode === "video" &&
    productConfigProbe?.ok === true &&
    !productConfigProbe.loadError &&
    productConfigProbe.videoFeatureEnabled === false
  ) {
    addCheck(checks, {
      id: checkId,
      area: "Generation",
      status: "pass",
      message:
        "Video generation is disabled in authoritative product config; Main persistence evidence is not required.",
    });
    return;
  }

  const problems: string[] = [];
  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no Main persistence report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.mode !== mode) problems.push(`probe mode is not ${mode}`);
    if (!hasMinLength(probe.generationJobId ?? undefined, 1)) {
      problems.push("generation job id is missing");
    }
    if (
      !hasMinLength(probe.attemptId ?? undefined, 1) ||
      !Number.isInteger(probe.attemptNo) ||
      (probe.attemptNo ?? 0) < 1
    ) {
      problems.push("generation attempt identity is invalid");
    }
    if (probe.jobStatus !== "completed" || probe.attemptStatus !== "succeeded") {
      problems.push("Main Job/Attempt are not completed/succeeded");
    }
    if (
      !hasMinLength(probe.provider ?? undefined, 1) ||
      !hasMinLength(probe.profileKey ?? undefined, 1) ||
      !Number.isInteger(probe.profileVersion) ||
      (probe.profileVersion ?? 0) < 1
    ) {
      problems.push("provider and pinned generation profile are incomplete");
    }
    if (directProbe?.workflowKey) {
      if (
        probe.workflowKey !== directProbe.workflowKey ||
        probe.workflowVersion !== directProbe.workflowVersion
      ) {
        problems.push("Main Attempt workflow does not match the Gen probe");
      }
    }
    const terminal = probe.terminal;
    if (!terminal) {
      problems.push("Main terminal persistence authority is missing");
    } else {
      if (
        !hasMinLength(terminal.ref ?? undefined, 1) ||
        !/^[a-f0-9]{64}$/.test(terminal.checksum ?? "")
      ) {
        problems.push("persisted terminal reference or checksum is invalid");
      }
      if (
        !hasMinLength(terminal.receiptId ?? undefined, 1) ||
        terminal.receiptState !== "processed" ||
        terminal.outboxState !== "delivered"
      ) {
        problems.push("terminal receipt/outbox is not processed/delivered");
      }
      if (
        (terminal.transportCount ?? 0) < 1 ||
        terminal.transportStatus !== "succeeded"
      ) {
        problems.push("transport execution is not succeeded");
      }
      if (
        (terminal.artifactCount ?? 0) < 1 ||
        terminal.deliveredCount !== terminal.artifactCount ||
        terminal.mediaAssetCount !== terminal.artifactCount
      ) {
        problems.push("artifact, delivery, and MediaAsset counts do not match");
      }
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
    addProbeFreshnessProblems(problems, env, probeName, probe.observedAt, now);
    const checkedAt = parseProbeDate(probe.checkedAt);
    const observedAt = parseProbeDate(probe.observedAt);
    if (!observedAt || (checkedAt && observedAt.getTime() > checkedAt.getTime())) {
      problems.push("observed terminal time is missing or after checkedAt");
    }
  }

  addCheck(checks, {
    id: checkId,
    area: "Generation",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? `Recent ${mode} product generation was ingested by Main and projected to delivered artifacts and MediaAssets.`
        : `Main ${mode} generation persistence evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Complete a real product ${mode} job, then run \`bun run --filter @idream/main probe:generation-persistence -- --job-id <generation-job-id> --report .tmp/launch-${mode}-persistence-probe.json\` and set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addProductConfigProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ProductConfigProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "productConfigProbe";

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if ((probe.activeImageProfiles ?? 0) < 1) {
      problems.push("no active image model profile is configured");
    }
    if (!Array.isArray(probe.activeImageExecutionBindings)) {
      problems.push("probe predates image execution binding evidence");
    } else if (
      probe.activeImageExecutionBindings.length !==
      (probe.activeImageProfiles ?? 0)
    ) {
      problems.push(
        "image execution binding count does not match active profiles",
      );
    }
    if (!Array.isArray(probe.invalidActiveImageProfileIds)) {
      problems.push(
        "probe predates the image workflow descriptor authority check",
      );
    } else if (probe.invalidActiveImageProfileIds.length > 0) {
      problems.push(
        `active declared text-to-image profiles are not publicly executable: ${probe.invalidActiveImageProfileIds.join(", ")}`,
      );
    }
    if ((probe.activeImageCharacterTemplates ?? 0) < 1) {
      problems.push("no active image character prompt template is configured");
    }
    if ((probe.activeImageFreeplayTemplates ?? 0) < 1) {
      problems.push("no active image freeplay prompt template is configured");
    }
    if ((probe.activeImagePricingRules ?? 0) !== 1) {
      problems.push("image pricing does not have exactly one active rule");
    }
    if ((probe.activeVoicePricingRules ?? 0) !== 1) {
      problems.push("voice pricing does not have exactly one active rule");
    }
    if (
      (probe.publicCharactersWithSystemPrompt ?? 0) !==
      (probe.publicCharacters ?? 0)
    ) {
      problems.push("not every public character has a chat system prompt");
    }

    if (probe.videoFeatureEnabled === true) {
      if ((probe.activeVideoProfiles ?? 0) < 1) {
        problems.push(
          "video_gen is enabled but no active video model profile is configured",
        );
      }
      if ((probe.activeVideoCharacterTemplates ?? 0) < 1) {
        problems.push(
          "video_gen is enabled but no active video character prompt template is configured",
        );
      }
      if ((probe.activeVideoPricingRules ?? 0) !== 1) {
        problems.push(
          "video_gen is enabled but video pricing does not have exactly one active rule",
        );
      }
    }

    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "product-config-live-probe",
    area: "Product",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent product config probe found active generation config and verified the video feature flag state."
        : `Product config probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:product-config -- --report .tmp/launch-product-config-probe.json\`, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addPublicCatalogProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: PublicCatalogProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "publicCatalogProbe";

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if ((probe.counts?.publicCharacters ?? 0) < 1) {
      problems.push("no approved public characters were found");
    }
    if ((probe.counts?.publicCollections ?? 0) < 1) {
      problems.push("no public collections were found");
    }
    if ((probe.counts?.publicCreators ?? 0) < 1) {
      problems.push("no public creators were found");
    }
    if ((probe.counts?.publicFeedbackItems ?? 0) < 1) {
      problems.push("no public roadmap feedback items were found");
    }
    if ((probe.counts?.distinctImages ?? 0) < 1) {
      problems.push("no distinct public catalog images were found");
    }
    if ((probe.issueTotals?.fail ?? 0) > 0) {
      problems.push(
        `${probe.issueTotals?.fail ?? 0} launch-blocking catalog issue(s) found`,
      );
    }
    if ((probe.issueTotals?.warn ?? 0) > 0) {
      problems.push(
        `${probe.issueTotals?.warn ?? 0} catalog warning issue(s) found`,
      );
    }

    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "public-catalog-live-probe",
    area: "Product",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent public catalog probe found clean public characters, creators, collections, roadmap items, and images."
        : `Public catalog probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:catalog -- --report .tmp/public-catalog-probe.json\`, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addWebSurfaceProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: WebSurfaceProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "webSurfaceProbe";
  const expectedMainUrl = env.MAIN_WEB_URL;

  addMissingProbeReportProblem(problems, env, probeName);
  if (!isPublicHttpsUrl(expectedMainUrl)) {
    problems.push("MAIN_WEB_URL must be a public HTTPS URL");
  }
  if (!isUrl(env.ADMIN_WEB_URL)) {
    problems.push("ADMIN_WEB_URL is missing or invalid");
  }

  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (!sameUrl(probe.mainUrl, expectedMainUrl)) {
      problems.push(
        "probe main URL does not match MAIN_WEB_URL or BETTER_AUTH_URL",
      );
    }
    if (!sameUrl(probe.adminUrl, env.ADMIN_WEB_URL)) {
      problems.push("probe admin URL does not match ADMIN_WEB_URL");
    }
    if (
      probe.home?.ok !== true ||
      probe.home.status !== 200 ||
      probe.home.containsBrand !== true ||
      probe.home.nextErrorShell === true ||
      probe.home.assets?.ok !== true ||
      !probe.home.assets.checked
    ) {
      problems.push(
        "main homepage did not return healthy branded HTML with complete linked assets",
      );
    }
    if (
      probe.generate?.ok !== true ||
      probe.generate.status !== 200 ||
      probe.generate.containsGenerator !== true ||
      probe.generate.nextErrorShell === true ||
      probe.generate.assets?.ok !== true ||
      !probe.generate.assets.checked
    ) {
      problems.push(
        "generation page did not return healthy generator HTML with complete linked assets",
      );
    }
    if (
      probe.apiAgeGate?.ok !== true ||
      probe.apiAgeGate.status !== 403 ||
      probe.apiAgeGate.code !== "forbidden" ||
      probe.apiAgeGate.reason !== "age_gate_required"
    ) {
      problems.push(
        "unauthenticated character API did not fail closed on the age gate",
      );
    }
    if (
      probe.admin?.ok !== true ||
      probe.admin.status !== 200 ||
      probe.admin.protected !== true ||
      probe.admin.nextErrorShell === true ||
      probe.admin.assets?.ok !== true ||
      !probe.admin.assets.checked
    ) {
      problems.push(
        "admin surface did not return the protected unauthenticated state with complete linked assets",
      );
    }
    if (probe.admin?.protectedReason !== "access_denied") {
      problems.push(
        "admin surface did not prove production access denial (development login walls are not launch protection)",
      );
    }
    if (
      probe.adminApi?.ok !== true ||
      probe.adminApi.status !== 401 ||
      probe.adminApi.code !== "unauthorized"
    ) {
      problems.push("unauthenticated admin API did not fail closed");
    }

    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "web-surface-live-probe",
    area: "Runtime",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent web surface probe reached main-web, generation page, age-gated API, protected admin-web, and locked admin API."
        : `Web surface probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:web-surface -- --report .tmp/launch-web-surface-probe.json\` against the deployed main/admin web surfaces, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addImagePipelineProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ImagePipelineProbeEvidence | null,
  productConfigProbe: ProductConfigProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "imagePipelineProbe";
  const configuredProvider = env.GEN_IMAGE_PROVIDER ?? "mock";
  const genPipelineApiUrl = genAuthorityValue(
    env,
    "IDREAM_GEN_PIPELINE_API_URL",
    "PIPELINE_API_URL",
  );
  const genComfyuiApiUrl = genAuthorityValue(
    env,
    "IDREAM_GEN_COMFYUI_API_URL",
    "COMFYUI_API_URL",
  );
  const genDrawThingsCli = genAuthorityValue(
    env,
    "IDREAM_GEN_DRAWTHINGS_CLI",
    "DRAWTHINGS_CLI",
  );
  const genImageModel = genAuthorityValue(
    env,
    "IDREAM_GEN_PIPELINE_IMAGE_MODEL_DEFAULT",
    "PIPELINE_IMAGE_MODEL_DEFAULT",
  );

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider === "pipeline") {
      if (!sameUrl(probe.pipelineUrl, genPipelineApiUrl)) {
        problems.push("probe pipeline URL does not match Gen pipeline URL");
      }
    } else if (configuredProvider === "backend") {
      if (probe.backendKind === "comfyui") {
        if (!sameUrl(probe.backendTarget, genComfyuiApiUrl)) {
          problems.push(
            "probe ComfyUI target does not match Gen ComfyUI authority",
          );
        }
      } else if (probe.backendKind === "drawthings") {
        if (
          !hasMinLength(probe.backendTarget ?? undefined, 1) ||
          probe.backendTarget !== genDrawThingsCli
        ) {
          problems.push(
            "probe Draw Things target does not match DRAWTHINGS_CLI",
          );
        }
      } else {
        problems.push("probe does not identify the workflow backend kind");
      }
      if (
        !hasMinLength(probe.workflowKey ?? undefined, 1) ||
        !Number.isInteger(probe.workflowVersion) ||
        (probe.workflowVersion ?? 0) < 1
      ) {
        problems.push("probe does not bind an exact workflow key and version");
      }
    }
    if (
      configuredProvider === "pipeline" &&
      hasMinLength(genImageModel, 1) &&
      probe.model !== genImageModel
    ) {
      problems.push("probe model does not match Gen image model");
    }
    const executionBindings = productConfigProbe?.activeImageExecutionBindings;
    if (
      productConfigProbe?.ok !== true ||
      productConfigProbe.loadError ||
      !Array.isArray(executionBindings) ||
      executionBindings.length < 1
    ) {
      problems.push(
        "product config does not expose authoritative image execution bindings",
      );
    } else {
      const mismatchedProfileIds = executionBindings.flatMap((binding) => {
        const adapter = imageAdapterForProfileRunner(binding.runner);
        const commonMatches =
          adapter === configuredProvider && binding.model === probe.model;
        const workflowMatches =
          configuredProvider !== "backend" ||
          (binding.workflowKey === probe.workflowKey &&
            binding.workflowVersion === probe.workflowVersion);
        return commonMatches && workflowMatches
          ? []
          : [binding.profileId ?? "unknown-profile"];
      });
      if (mismatchedProfileIds.length > 0) {
        problems.push(
          `probe does not cover active public image profile binding(s): ${mismatchedProfileIds.join(", ")}`,
        );
      }
    }
    addGenBlobAuthorityProblems(problems, env, probe.blobAuthority);
    if (!probe.terminal) {
      problems.push("probe predates immutable terminal record evidence");
    } else {
      if (
        !hasMinLength(probe.terminal.ref ?? undefined, 1) ||
        !/^[a-f0-9]{64}$/.test(probe.terminal.checksum ?? "")
      ) {
        problems.push("probe terminal record reference or checksum is invalid");
      }
      if (probe.terminal.outcome !== "succeeded") {
        problems.push(
          `probe terminal outcome is ${probe.terminal.outcome ?? "unknown"}, not succeeded`,
        );
      }
      if ((probe.terminal.assets ?? 0) < 1) {
        problems.push("probe terminal record contains no assets");
      }
      if (probe.terminal.error !== null) {
        problems.push("probe terminal record contains an error");
      }
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "pipeline-image-live-probe",
    area: "Generation",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent image generation probe completed through the configured adapter and shared Blob authority, then emitted a successful immutable terminal record."
        : `Image generation probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/gen probe:image -- --model <active-product-config-model> --report .tmp/launch-image-probe.json\` with the production Gen adapter, workflow and blob configuration, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addGenBlobAuthorityProblems(
  problems: string[],
  env: EnvLike,
  authority: GenBlobAuthorityEvidence | null | undefined,
) {
  const mainProvider = env.BLOB_PROVIDER ?? "mock";
  const genProvider = env.GEN_BLOB_PROVIDER ?? mainProvider;
  const genEndpoint = env.IDREAM_GEN_BLOB_ENDPOINT ?? env.BLOB_ENDPOINT;
  const genBucket = env.IDREAM_GEN_BLOB_BUCKET ?? env.BLOB_BUCKET;
  const mainRoot = resolveLocalBlobRoot(env.BLOB_ROOT);
  const genRoot = resolveLocalBlobRoot(
    env.IDREAM_GEN_BLOB_ROOT ?? env.BLOB_ROOT,
  );

  if (genProvider !== mainProvider) {
    problems.push(
      `configured Gen Blob provider ${genProvider || "empty"} does not match Main BLOB_PROVIDER ${mainProvider || "empty"}`,
    );
  }
  if (
    (genProvider === "r2" || genProvider === "s3") &&
    (!sameUrl(genEndpoint, env.BLOB_ENDPOINT) || genBucket !== env.BLOB_BUCKET)
  ) {
    problems.push("configured Gen Blob endpoint/bucket does not match Main authority");
  }
  if (genProvider === "mock" && genRoot !== mainRoot) {
    problems.push("configured Gen local Blob root does not match Main authority");
  }
  if (!authority) {
    problems.push("probe does not identify the effective Gen Blob authority");
    return;
  }
  if (authority.provider !== genProvider) {
    problems.push(
      `probe Blob provider is ${authority.provider ?? "unknown"}, not ${genProvider || "empty"}`,
    );
  }

  if (genProvider === "r2" || genProvider === "s3") {
    if (!sameUrl(authority.endpoint, genEndpoint)) {
      problems.push("probe Blob endpoint does not match Gen runtime authority");
    }
    if (authority.bucket !== genBucket) {
      problems.push("probe Blob bucket does not match Gen runtime authority");
    }
    if (authority.root !== null) {
      problems.push(
        "remote Gen Blob authority unexpectedly includes a local root",
      );
    }
    return;
  }

  if (genProvider === "mock") {
    if (authority.root !== genRoot) {
      problems.push(
        "probe Blob root does not match the Gen runtime authority",
      );
    }
    if (authority.endpoint !== null || authority.bucket !== null) {
      problems.push(
        "local Gen Blob authority unexpectedly includes a remote target",
      );
    }
    return;
  }

  problems.push(
    `configured Gen Blob provider ${genProvider || "empty"} is unsupported`,
  );
}

function imageAdapterForProfileRunner(runner: string | undefined) {
  switch (runner) {
    case "comfyui":
      return "backend";
    case "mlx":
    case "external":
      return "pipeline";
    default:
      return runner;
  }
}

function addBlobStorageProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: BlobStorageProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "blobStorageProbe";
  const configuredProvider = env.BLOB_PROVIDER ?? "mock";

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider !== "mock") {
      if (!sameUrl(probe.endpoint, env.BLOB_ENDPOINT)) {
        problems.push("probe endpoint does not match BLOB_ENDPOINT");
      }
      if (
        hasMinLength(env.BLOB_BUCKET, 1) &&
        probe.bucket !== env.BLOB_BUCKET
      ) {
        problems.push("probe bucket does not match BLOB_BUCKET");
      }
    }
    if (probe.put?.ok !== true) {
      problems.push("probe PUT did not succeed");
    }
    if (probe.signedGetUrl?.ok !== true) {
      problems.push("probe signed GET URL was not created");
    }
    if (probe.readback?.ok !== true || probe.readback?.matches !== true) {
      problems.push("probe could not read back matching object bytes");
    }
    if (probe.delete?.ok !== true) {
      problems.push("probe DELETE did not succeed");
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "blob-storage-live-probe",
    area: "Storage",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent object storage probe wrote, signed, read, and deleted an object."
        : `Object storage probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:blob -- --report .tmp/launch-blob-probe.json\` against the real object store, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function addSafetyGatewayProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: SafetyGatewayProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const probeName: ProbeName = "safetyGatewayProbe";
  const configuredProvider = env.MODERATION_PROVIDER ?? "mock";

  if (configuredProvider !== "safety-gateway") {
    addCheck(checks, {
      id: "safety-gateway-live-probe",
      area: "Safety",
      status: "pass",
      message: `MODERATION_PROVIDER=${configuredProvider}; external probe evidence is not required for this provider.`,
    });
    return;
  }

  addMissingProbeReportProblem(problems, env, probeName);
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== configuredProvider) {
      problems.push(
        `probe provider is ${probe.provider ?? "unknown"}, not ${configuredProvider}`,
      );
    }
    if (configuredProvider === "safety-gateway") {
      if (!sameUrl(probe.serviceUrl, env.MODERATION_SERVICE_URL)) {
        problems.push(
          "probe service URL does not match MODERATION_SERVICE_URL",
        );
      }
    }
    if (probe.targetType !== "text") {
      problems.push("probe target type is not text");
    }
    if (probe.status !== "passed") {
      problems.push(
        `probe decision is ${probe.status ?? "unknown"}, not passed`,
      );
    }
    if (
      typeof probe.confidence !== "number" ||
      probe.confidence < 0 ||
      probe.confidence > 1
    ) {
      problems.push("probe confidence is missing or outside 0..1");
    }
    addProbeFreshnessProblems(problems, env, probeName, probe.checkedAt, now);
  }

  addCheck(checks, {
    id: "safety-gateway-live-probe",
    area: "Safety",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent safety gateway probe authenticated and passed benign text moderation."
        : `Safety gateway probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : `Run \`bun run --filter @idream/main probe:safety -- --report .tmp/launch-safety-probe.json\` against the real safety gateway, then set ${PROBE_REPORTS[probeName].reportEnvKey} before check:launch.`,
  });
}

function parseProbeDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function probeMaxAgeMs(env: EnvLike, key: string) {
  const parsed = Number.parseInt(env[key] ?? "1440", 10);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 1440) * 60_000;
}

function sameUrl(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.toString().replace(/\/$/, "") ===
      rightUrl.toString().replace(/\/$/, "")
    );
  } catch {
    return left.replace(/\/$/, "") === right.replace(/\/$/, "");
  }
}

function isInternalReturnPath(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return false;
  try {
    const url = new URL(value, "https://ourdream.invalid");
    return url.origin === "https://ourdream.invalid";
  } catch {
    return false;
  }
}

// SPEC: 门禁读回全部 probe 证据。测试注入优先，其余按注册表里的 env 变量读文件。
// INVARIANT: 遍历 PROBE_NAMES 而不是逐个手写 —— 少接一个 probe 在类型上就不可能了。
function resolveProbeEvidence(
  env: EnvLike,
  options: LaunchReadinessOptions,
): { [K in ProbeName]: ProbeEvidenceOf<K> | null } {
  const resolved: Record<string, unknown> = {};
  for (const name of PROBE_NAMES) {
    resolved[name] =
      options[name] !== undefined ? options[name] : loadProbeReport(env, name);
  }
  return resolved as { [K in ProbeName]: ProbeEvidenceOf<K> | null };
}

function isReleaseRevision(value: string | null | undefined) {
  const revision = value?.trim() ?? "";
  return (
    revision.length >= 7 &&
    revision.length <= 160 &&
    !/(?:change[_-]?me|development|local|placeholder|replace|unknown)/iu.test(
      revision,
    )
  );
}

function requiredRevisionProbeNames(
  scope: LaunchScope,
  env: EnvLike,
  probes: { [K in ProbeName]: ProbeEvidenceOf<K> | null },
) {
  const names = new Set<ProbeName>([
    "imagePipelineProbe",
    "imageGenerationPersistenceProbe",
    "blobStorageProbe",
    "chatServiceProbe",
    "chatModelProbe",
    "adminTextProbe",
    "voiceModelProbe",
    "productConfigProbe",
    "publicCatalogProbe",
    "webSurfaceProbe",
    "sentryMainCanaryProbe",
    "sentryAdminCanaryProbe",
    "sentryChatCanaryProbe",
    "sentryGenCanaryProbe",
  ]);
  if (
    probes.productConfigProbe?.ok === true &&
    !probes.productConfigProbe.loadError &&
    probes.productConfigProbe.videoFeatureEnabled === true
  ) {
    names.add("videoGenerationProbe");
    names.add("videoGenerationPersistenceProbe");
  }
  if (
    (env.MODERATION_PROVIDER ?? "mock") !== "mock" ||
    (env.CHAT_MODERATION_PROVIDER ?? "mock") !== "mock"
  ) {
    names.add("safetyGatewayProbe");
  }
  if (scope === "full") {
    names.add("paymentProviderProbe");
    names.add("ageVerificationProbe");
  }
  return names;
}

function addSourceRevisionAuthorityCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probes: { [K in ProbeName]: ProbeEvidenceOf<K> | null },
  scope: LaunchScope,
) {
  const expectedRevision = env.IDREAM_MAIN_SOURCE_REVISION?.trim() ?? "";
  const serviceRevisions = [
    env.IDREAM_MAIN_SOURCE_REVISION,
    env.IDREAM_ADMIN_SOURCE_REVISION,
    env.IDREAM_CHAT_SOURCE_REVISION,
    env.IDREAM_GEN_SOURCE_REVISION,
  ];
  const problems: string[] = [];
  if (
    !isReleaseRevision(expectedRevision) ||
    serviceRevisions.some((revision) => revision?.trim() !== expectedRevision)
  ) {
    problems.push("Main, Admin, Chat, and Gen source revisions are missing or inconsistent");
  }
  for (const name of requiredRevisionProbeNames(scope, env, probes)) {
    const revision = probes[name]?.sourceRevision?.trim() ?? "";
    if (!expectedRevision || revision !== expectedRevision) {
      problems.push(`${PROBE_REPORTS[name].reportEnvKey} is not bound to the expected revision`);
    }
  }
  if (
    probes.chatServiceProbe?.runtimeAuthority?.sourceRevision?.trim() !==
    env.IDREAM_CHAT_SOURCE_REVISION?.trim()
  ) {
    problems.push("signed Chat runtime authority is not bound to the Chat revision");
  }
  const adminText = probes.adminTextProbe;
  if (
    adminText?.adminSourceRevision?.trim() !==
      env.IDREAM_ADMIN_SOURCE_REVISION?.trim() ||
    adminText?.characterAssist?.runtime?.sourceRevision?.trim() !==
      expectedRevision ||
    adminText?.productionDirections?.runtime?.sourceRevision?.trim() !==
      expectedRevision
  ) {
    problems.push("Admin BFF and Main text runtime are not bound to their revisions");
  }
  addCheck(checks, {
    id: "source-revision-authority",
    area: "Runtime",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? `All required runtime and probe evidence is bound to ${expectedRevision}.`
        : `Source revision authority is incomplete: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : "Deploy one immutable source revision to Main, Admin, Chat, and Gen; set the same SENTRY_RELEASE/IDREAM_SOURCE_REVISION in each service; rerun every required probe from that revision before check:launch.",
  });
}

export function assessLaunchReadiness(
  options: LaunchReadinessOptions = {},
): LaunchReadinessReport {
  const env = options.env ?? process.env;
  const configuredScope = resolveLaunchScope(env.LAUNCH_SCOPE);
  const scope = configuredScope ?? "full";
  const capabilities = mergeCapabilities(options.capabilities);
  // INVARIANT: 显式传入（含 null）优先于按 env 读文件；未传才落回 *_PROBE_REPORT。
  const probes = resolveProbeEvidence(env, options);
  const now = options.now ?? new Date();
  const checks: LaunchReadinessCheck[] = [...(options.preflightChecks ?? [])];

  addCheck(checks, {
    id: "launch-scope",
    area: "Runtime",
    status: configuredScope === null ? "fail" : "pass",
    message:
      configuredScope === null
        ? `LAUNCH_SCOPE=${env.LAUNCH_SCOPE} is invalid; only full or core are supported.`
        : scope === "core"
          ? "LAUNCH_SCOPE=core requires the complete core product envelope and explicitly excludes Billing and Age Verification."
          : "LAUNCH_SCOPE=full requires the complete product envelope.",
    remediation:
      configuredScope === null
        ? "Set LAUNCH_SCOPE to full or core; unknown values never weaken the full launch gate."
        : undefined,
  });
  addSourceRevisionAuthorityCheck(checks, env, probes, scope);

  addCheck(checks, {
    id: "app-env-production",
    area: "Runtime",
    status:
      env.APP_ENV === "production" &&
      env.IDREAM_ADMIN_APP_ENV === "production" &&
      env.IDREAM_CHAT_APP_ENV === "production" &&
      env.IDREAM_GEN_APP_ENV === "production"
        ? "pass"
        : "fail",
    message:
      env.APP_ENV === "production" &&
      env.IDREAM_ADMIN_APP_ENV === "production" &&
      env.IDREAM_CHAT_APP_ENV === "production" &&
      env.IDREAM_GEN_APP_ENV === "production"
        ? "Main, Admin, Chat, and Gen APP_ENV are production."
        : "Main, Admin, Chat, and Gen are not all configured with APP_ENV=production.",
    remediation:
      "Run Main, Admin, Chat, and Gen with APP_ENV=production before evaluating the launch gate.",
  });

  addCheck(checks, {
    id: "database-url",
    area: "Data",
    status: isPostgresUrl(env.DATABASE_URL) ? "pass" : "fail",
    message: isPostgresUrl(env.DATABASE_URL)
      ? "DATABASE_URL is a Postgres connection string."
      : "DATABASE_URL is missing or not Postgres.",
    remediation: "Set DATABASE_URL to the production Postgres pooled URL.",
  });

  addCheck(checks, {
    id: "main-web-url",
    area: "Runtime",
    status: isPublicHttpsUrl(env.MAIN_WEB_URL) ? "pass" : "fail",
    message: isPublicHttpsUrl(env.MAIN_WEB_URL)
      ? "MAIN_WEB_URL resolves to a public HTTPS origin."
      : "MAIN_WEB_URL is missing, non-HTTPS, localhost, or a placeholder.",
    remediation:
      "Set MAIN_WEB_URL to the public main-site origin, for example https://ourdream.ai.",
  });

  addCheck(checks, {
    id: "better-auth-url",
    area: "Runtime",
    status: isPublicHttpsUrl(env.BETTER_AUTH_URL) ? "pass" : "fail",
    message: isPublicHttpsUrl(env.BETTER_AUTH_URL)
      ? "BETTER_AUTH_URL is a public HTTPS origin."
      : "BETTER_AUTH_URL is missing, non-HTTPS, localhost, or a placeholder.",
    remediation:
      "Set BETTER_AUTH_URL to the public production origin, for example https://ourdream.ai.",
  });

  addCheck(checks, {
    id: "better-auth-secret",
    area: "Security",
    status:
      hasMinLength(env.BETTER_AUTH_SECRET, 32) &&
      env.BETTER_AUTH_SECRET !== developmentSecret
        ? "pass"
        : "fail",
    message:
      hasMinLength(env.BETTER_AUTH_SECRET, 32) &&
      env.BETTER_AUTH_SECRET !== developmentSecret
        ? "BETTER_AUTH_SECRET is production length."
        : "BETTER_AUTH_SECRET is missing, short, or still the development placeholder.",
    remediation:
      "Generate a unique production BETTER_AUTH_SECRET with at least 32 characters.",
  });

  const internalTokenAuthoritiesMatch =
    hasMinLength(env.INTERNAL_TOKEN, 16) &&
    env.IDREAM_ADMIN_INTERNAL_TOKEN === env.INTERNAL_TOKEN &&
    env.IDREAM_CHAT_INTERNAL_TOKEN === env.INTERNAL_TOKEN &&
    env.IDREAM_GEN_INTERNAL_TOKEN === env.INTERNAL_TOKEN;
  addCheck(checks, {
    id: "internal-token",
    area: "Security",
    status: internalTokenAuthoritiesMatch ? "pass" : "fail",
    message: internalTokenAuthoritiesMatch
      ? "Main, Admin, Chat, and Gen use one internal token authority."
      : "Main, Admin, Chat, and Gen internal tokens are missing or inconsistent.",
    remediation:
      "Set the same production INTERNAL_TOKEN in the Main, Admin, Chat, and Gen service environments.",
  });
  addRequiredCheck(checks, env, {
    id: "cron-secret",
    area: "Security",
    key: "CRON_SECRET",
    label: "Cron secret",
    minLength: 16,
    remediation:
      "Set CRON_SECRET to a production-only secret distinct from INTERNAL_TOKEN.",
  });

  addCheck(checks, {
    id: "service-token-separation",
    area: "Security",
    status:
      hasMinLength(env.INTERNAL_TOKEN, 16) &&
      hasMinLength(env.CRON_SECRET, 16) &&
      env.INTERNAL_TOKEN !== env.CRON_SECRET
        ? "pass"
        : "fail",
    message:
      hasMinLength(env.INTERNAL_TOKEN, 16) &&
      hasMinLength(env.CRON_SECRET, 16) &&
      env.INTERNAL_TOKEN !== env.CRON_SECRET
        ? "Internal and cron tokens are distinct."
        : "Internal and cron tokens are missing or identical.",
    remediation:
      "Use separate random secrets for INTERNAL_TOKEN and CRON_SECRET.",
  });
  addWebSurfaceProbeCheck(checks, env, probes.webSurfaceProbe, now);

  addRequiredCheck(checks, env, {
    id: "redis-url",
    area: "Queues",
    key: "REDIS_URL",
    label: "Redis URL",
    url: true,
    remediation: "Set REDIS_URL to the production queue Redis instance.",
  });
  addCheck(checks, {
    id: "bullmq-prefix",
    area: "Queues",
    status:
      env.IDREAM_CHAT_APP_ENV === "production" &&
      env.IDREAM_GEN_APP_ENV === "production" &&
      isProductionBullmqPrefix(env.BULLMQ_PREFIX) &&
      env.IDREAM_CHAT_BULLMQ_PREFIX === env.BULLMQ_PREFIX &&
      env.IDREAM_GEN_BULLMQ_PREFIX === env.BULLMQ_PREFIX
        ? "pass"
        : "fail",
    message:
      env.IDREAM_CHAT_APP_ENV === "production" &&
      env.IDREAM_GEN_APP_ENV === "production" &&
      isProductionBullmqPrefix(env.BULLMQ_PREFIX) &&
      env.IDREAM_CHAT_BULLMQ_PREFIX === env.BULLMQ_PREFIX &&
      env.IDREAM_GEN_BULLMQ_PREFIX === env.BULLMQ_PREFIX
        ? "Main, Chat, and Gen share one explicit production BullMQ prefix."
        : "Main, Chat, and Gen are not bound to one production BullMQ prefix.",
    remediation:
      "Set one shared production BULLMQ_PREFIX, such as idream:prod, for main-web, chat, and gen workers.",
  });

  addProviderChecks(checks, env, capabilities, scope);

  addRequiredCheck(checks, env, {
    id: "chat-service-url",
    area: "Chat",
    key: "CHAT_SERVICE_URL",
    label: "Chat service URL",
    url: true,
    remediation: "Deploy packages/chat and set CHAT_SERVICE_URL.",
  });
  const chatBffAuthoritiesMatch =
    hasMinLength(env.CHAT_BFF_SIGNING_SECRET, 32) &&
    env.IDREAM_CHAT_BFF_SIGNING_SECRET === env.CHAT_BFF_SIGNING_SECRET;
  addCheck(checks, {
    id: "chat-bff-signing-secret",
    area: "Chat",
    status: chatBffAuthoritiesMatch ? "pass" : "fail",
    message: chatBffAuthoritiesMatch
      ? "Main and Chat share one production BFF signing authority."
      : "Main and Chat BFF signing secrets are missing or inconsistent.",
    remediation:
      "Set CHAT_BFF_SIGNING_SECRET to the same shared secret used by packages/chat.",
  });
  const adminBffAuthoritiesMatch =
    hasMinLength(env.ADMIN_BFF_SIGNING_SECRET, 32) &&
    env.IDREAM_ADMIN_BFF_SIGNING_SECRET === env.ADMIN_BFF_SIGNING_SECRET;
  addCheck(checks, {
    id: "admin-bff-signing-secret",
    area: "Admin",
    status: adminBffAuthoritiesMatch ? "pass" : "fail",
    message: adminBffAuthoritiesMatch
      ? "Main and Admin share one production BFF signing authority."
      : "Main and Admin BFF signing secrets are missing or inconsistent.",
    remediation:
      "Set ADMIN_BFF_SIGNING_SECRET to the same shared secret used by packages/admin.",
  });
  addChatServiceChecks(checks, env);
  addChatServiceProbeCheck(checks, env, probes.chatServiceProbe, now);
  addChatModelProbeCheck(checks, env, probes.chatModelProbe, now);
  addAdminTextProbeCheck(checks, env, probes.adminTextProbe, now);
  addChatModerationChecks(checks, env);

  addImagePipelineChecks(
    checks,
    env,
    capabilities,
    probes.imagePipelineProbe,
    probes.productConfigProbe,
    now,
  );
  addProductConfigProbeCheck(checks, env, probes.productConfigProbe, now);
  addPublicCatalogProbeCheck(checks, env, probes.publicCatalogProbe, now);
  addGenerationPersistenceProbeCheck(
    checks,
    env,
    "image",
    probes.imageGenerationPersistenceProbe,
    probes.imagePipelineProbe,
    probes.productConfigProbe,
    now,
  );
  addVideoPipelineChecks(checks, env, capabilities, probes.productConfigProbe);
  addVideoGenerationProbeCheck(
    checks,
    env,
    probes.productConfigProbe,
    probes.videoGenerationProbe,
    now,
  );
  addGenerationPersistenceProbeCheck(
    checks,
    env,
    "video",
    probes.videoGenerationPersistenceProbe,
    probes.videoGenerationProbe,
    probes.productConfigProbe,
    now,
  );
  addVoiceModelProbeCheck(checks, env, probes.voiceModelProbe, now);

  if ((env.MODERATION_PROVIDER ?? "mock") === "safety-gateway") {
    addRequiredCheck(checks, env, {
      id: "moderation-service-url",
      area: "Safety",
      key: "MODERATION_SERVICE_URL",
      label: "Moderation service URL",
      url: true,
      remediation: "Set MODERATION_SERVICE_URL for the configured provider.",
    });
    addRequiredCheck(checks, env, {
      id: "moderation-api-key",
      area: "Safety",
      key: "MODERATION_API_KEY",
      label: "Moderation API key",
      minLength: 16,
      remediation: "Set MODERATION_API_KEY for the configured provider.",
    });
  } else {
    addCheck(checks, {
      id: "moderation-service-url",
      area: "Safety",
      status: "pass",
      message: `MODERATION_PROVIDER=${env.MODERATION_PROVIDER ?? "mock"} does not require MODERATION_SERVICE_URL.`,
    });
    addCheck(checks, {
      id: "moderation-api-key",
      area: "Safety",
      status: "pass",
      message: `MODERATION_PROVIDER=${env.MODERATION_PROVIDER ?? "mock"} does not require MODERATION_API_KEY.`,
    });
  }
  addSafetyGatewayProbeCheck(checks, env, probes.safetyGatewayProbe, now);
  if (scope === "full") {
    addAtLeastOneCheck(checks, env, {
      id: "payment-api-key",
      area: "Billing",
      keys: ["PAYMENT_API_KEY", "BTCPAY_API_KEY", "NOWPAYMENTS_API_KEY"],
      label: "Payment provider API key",
      remediation: "Configure production payment processor credentials.",
    });
    addRequiredCheck(checks, env, {
      id: "payment-btcpay-base-url",
      area: "Billing",
      key: "BTCPAY_BASE_URL",
      label: "BTCPay base URL",
      url: true,
      remediation: "Set BTCPAY_BASE_URL when PAYMENT_PROVIDER=btcpay.",
    });
    addRequiredCheck(checks, env, {
      id: "payment-btcpay-store-id",
      area: "Billing",
      key: "BTCPAY_STORE_ID",
      label: "BTCPay store id",
      minLength: 1,
      remediation: "Set BTCPAY_STORE_ID for the production payment store.",
    });
    addAtLeastOneCheck(checks, env, {
      id: "payment-webhook-secret",
      area: "Billing",
      keys: [
        "PAYMENT_WEBHOOK_SECRET",
        "BTCPAY_WEBHOOK_SECRET",
        "NOWPAYMENTS_IPN_SECRET",
      ],
      label: "Payment webhook secret",
      remediation:
        "Configure and verify the production payment webhook secret.",
    });
    addPaymentProviderProbeCheck(checks, env, probes.paymentProviderProbe, now);
    addRequiredCheck(checks, env, {
      id: "age-verification-service-url",
      area: "Compliance",
      key: "AGE_VERIFY_SERVICE_URL",
      label: "Age verification service URL",
      url: true,
      remediation: "Set AGE_VERIFY_SERVICE_URL to the Go.cam gateway service.",
    });
    addRequiredCheck(checks, env, {
      id: "age-verification-api-key",
      area: "Compliance",
      key: "AGE_VERIFY_API_KEY",
      label: "Age verification API key",
      minLength: 16,
      remediation: "Set AGE_VERIFY_API_KEY for the Go.cam gateway service.",
    });
    addRequiredCheck(checks, env, {
      id: "age-verification-webhook-secret",
      area: "Compliance",
      key: "AGE_VERIFY_WEBHOOK_SECRET",
      label: "Age verification webhook secret",
      minLength: 16,
      remediation:
        "Set AGE_VERIFY_WEBHOOK_SECRET and configure the gateway to sign callbacks.",
    });
    addCheck(checks, {
      id: "age-verification-link-back-url",
      area: "Compliance",
      status: isPublicHttpsUrl(env.AGE_VERIFY_LINK_BACK_URL) ? "pass" : "fail",
      message: isPublicHttpsUrl(env.AGE_VERIFY_LINK_BACK_URL)
        ? "Age verification link-back URL is public HTTPS."
        : "Age verification link-back URL is missing, non-HTTPS, localhost, or a placeholder.",
      remediation:
        "Set AGE_VERIFY_LINK_BACK_URL to the public page users return to after age verification.",
    });
    addCheck(checks, {
      id: "age-verification-callback-url",
      area: "Compliance",
      status: isPublicHttpsUrl(env.AGE_VERIFY_CALLBACK_URL) ? "pass" : "fail",
      message: isPublicHttpsUrl(env.AGE_VERIFY_CALLBACK_URL)
        ? "Age verification callback URL is public HTTPS."
        : "Age verification callback URL is missing, non-HTTPS, localhost, or a placeholder.",
      remediation:
        "Set AGE_VERIFY_CALLBACK_URL to the public signed-webhook endpoint for Go.cam callbacks.",
    });
    addAgeVerificationProbeCheck(checks, env, probes.ageVerificationProbe, now);
  }

  addRequiredCheck(checks, env, {
    id: "blob-bucket",
    area: "Storage",
    key: "BLOB_BUCKET",
    label: "Object storage bucket",
    minLength: 1,
    remediation: "Set BLOB_BUCKET for private generated media storage.",
  });
  addRequiredCheck(checks, env, {
    id: "blob-endpoint",
    area: "Storage",
    key: "BLOB_ENDPOINT",
    label: "Object storage endpoint",
    url: true,
    remediation: "Set BLOB_ENDPOINT for the production object store.",
  });
  addAtLeastOneCheck(checks, env, {
    id: "blob-access-key",
    area: "Storage",
    keys: ["BLOB_ACCESS_KEY_ID", "BLOB_ACCESS_KEY", "AWS_ACCESS_KEY_ID"],
    label: "Object storage access key",
    remediation: "Configure object storage access credentials.",
  });
  addAtLeastOneCheck(checks, env, {
    id: "blob-secret-key",
    area: "Storage",
    keys: [
      "BLOB_SECRET_ACCESS_KEY",
      "BLOB_SECRET_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ],
    label: "Object storage secret key",
    remediation: "Configure object storage secret credentials.",
  });
  addBlobStorageProbeCheck(checks, env, probes.blobStorageProbe, now);

  addRequiredCheck(checks, env, {
    id: "sentry-dsn",
    area: "Observability",
    key: "SENTRY_DSN",
    label: "Sentry DSN",
    url: true,
    remediation: "Set SENTRY_DSN so production errors are captured.",
  });
  addCheck(checks, {
    id: "sentry-browser-app-env",
    area: "Observability",
    status: env.NEXT_PUBLIC_APP_ENV === "production" ? "pass" : "fail",
    message:
      env.NEXT_PUBLIC_APP_ENV === "production"
        ? "Browser observability is explicitly marked as production."
        : "NEXT_PUBLIC_APP_ENV is not production.",
    remediation:
      "Set NEXT_PUBLIC_APP_ENV=production in both Main and Admin production builds.",
  });
  addCheck(checks, {
    id: "sentry-browser-dsn",
    area: "Observability",
    status:
      isUrl(env.NEXT_PUBLIC_SENTRY_DSN) &&
      sameUrl(env.NEXT_PUBLIC_SENTRY_DSN, env.SENTRY_DSN)
        ? "pass"
        : "fail",
    message:
      isUrl(env.NEXT_PUBLIC_SENTRY_DSN) &&
      sameUrl(env.NEXT_PUBLIC_SENTRY_DSN, env.SENTRY_DSN)
        ? "Browser Sentry DSN matches the server DSN."
        : "NEXT_PUBLIC_SENTRY_DSN is missing, invalid, or does not match SENTRY_DSN.",
    remediation:
      "Set NEXT_PUBLIC_SENTRY_DSN to the same public DSN used by the Next.js server runtimes.",
  });
  addSentryCanaryProbeCheck(
    checks,
    env,
    {
      main: probes.sentryMainCanaryProbe,
      admin: probes.sentryAdminCanaryProbe,
      chat: probes.sentryChatCanaryProbe,
      gen: probes.sentryGenCanaryProbe,
    },
    now,
  );

  const summary = summarize(checks);
  return {
    ok: summary.fail === 0,
    generatedAt: now.toISOString(),
    sourceRevision: env.IDREAM_MAIN_SOURCE_REVISION?.trim() || null,
    evidenceDigest: sha256Canonical(probes),
    environmentDigest: sha256Canonical(environmentDigestInput(env)),
    summary,
    checks,
  };
}

export function formatLaunchReadinessReport(report: LaunchReadinessReport) {
  const lines = [
    `Launch readiness: ${report.ok ? "PASS" : "FAIL"} (${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.warn} warn)`,
  ];

  for (const check of report.checks) {
    const remediation =
      check.status !== "pass" && check.remediation
        ? ` Remediation: ${check.remediation}`
        : "";
    lines.push(
      `[${check.status.toUpperCase()}] ${check.area} / ${check.id}: ${check.message}${remediation}`,
    );
  }

  return lines.join("\n");
}

export function parseLaunchReadinessCliArgs(
  args: readonly string[],
): LaunchReadinessCliOptions {
  const options: LaunchReadinessCliOptions = { help: false, json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--report") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--report requires a path");
      }
      options.reportFile = next;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--env-file" || arg === "--launch-env-file") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${arg} requires a path`);
      }
      options.envFile = next;
      index += 1;
      continue;
    }
    if (
      arg === "--admin-env-file" ||
      arg === "--chat-env-file" ||
      arg === "--gen-env-file"
    ) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${arg} requires a path`);
      }
      if (arg === "--admin-env-file") options.adminEnvFile = next;
      else if (arg === "--chat-env-file") options.chatEnvFile = next;
      else options.genEnvFile = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--launch-env-file=")) {
      const envFile = arg.slice("--launch-env-file=".length);
      if (!envFile) throw new Error("--launch-env-file requires a path");
      options.envFile = envFile;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      const envFile = arg.slice("--env-file=".length);
      if (!envFile) throw new Error("--env-file requires a path");
      options.envFile = envFile;
      continue;
    }
    if (arg.startsWith("--chat-env-file=")) {
      const envFile = arg.slice("--chat-env-file=".length);
      if (!envFile) throw new Error("--chat-env-file requires a path");
      options.chatEnvFile = envFile;
      continue;
    }
    if (arg.startsWith("--admin-env-file=")) {
      const envFile = arg.slice("--admin-env-file=".length);
      if (!envFile) throw new Error("--admin-env-file requires a path");
      options.adminEnvFile = envFile;
      continue;
    }
    if (arg.startsWith("--gen-env-file=")) {
      const envFile = arg.slice("--gen-env-file=".length);
      if (!envFile) throw new Error("--gen-env-file requires a path");
      options.genEnvFile = envFile;
      continue;
    }
    if (arg.startsWith("--report=")) {
      const reportFile = arg.slice("--report=".length);
      if (!reportFile) throw new Error("--report requires a path");
      options.reportFile = reportFile;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function formatLaunchReadinessHelp() {
  return [
    "Usage: bun run check:launch -- [options]",
    "       bun run --filter @idream/main check:launch -- [options]",
    "",
    "Options:",
    "  --launch-env-file <path>  Load dotenv values before running the launch gate.",
    "  --admin-env-file <path>   Load Admin runtime authority from its dotenv file.",
    "  --chat-env-file <path>    Load Chat runtime authority from its dotenv file.",
    "  --gen-env-file <path>     Load Gen runtime authority from its dotenv file.",
    "  --report <path>           Write the structured report as JSON.",
    "  --json                    Print the structured report as JSON.",
    "  -h, --help                Show this help.",
  ].join("\n");
}

export async function writeLaunchReadinessReport(
  reportFile: string,
  report: LaunchReadinessReport,
) {
  const target = path.resolve(reportFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function isCliEntrypoint() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

async function addCharacterSoulAuthorityPreflight(
  env: EnvLike,
  checks: LaunchReadinessCheck[],
) {
  const databaseUrl = env.DATABASE_URL;
  const chatDatabaseUrl = env.CHAT_DATABASE_URL;
  if (
    !databaseUrl ||
    !isPostgresUrl(databaseUrl) ||
    !chatDatabaseUrl ||
    !isPostgresUrl(chatDatabaseUrl)
  ) {
    checks.push({
      id: "character-soul-authority",
      area: "Chat",
      status: "fail",
      message:
        "Character Soul authority audit requires PostgreSQL Main and Chat database URLs.",
      remediation:
        "Set DATABASE_URL and CHAT_DATABASE_URL to their least-privilege roles on the same target database, then rerun check:launch.",
    });
    return;
  }
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const chatDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: chatDatabaseUrl }),
  });
  try {
    const audit = await auditCharacterSoulAuthority(db, chatDb);
    checks.push(
      {
        id: "character-read-model-topology",
        area: "Chat",
        status: audit.topology.mode === "same_cluster_views" ? "pass" : "fail",
        message:
          audit.topology.mode === "same_cluster_views"
            ? `Character read model and Chat pin drain use least-privilege roles on ${audit.topology.database}.`
            : `Required same-cluster Character views are absent or Chat targets ${audit.topology.chatDatabase} instead of ${audit.topology.database}.`,
        remediation:
          "Apply the canonical core read-view SQL before starting Chat.",
      },
      {
        id: "character-read-model-parity",
        area: "Chat",
        status: audit.readModel.parityMismatches === 0 ? "pass" : "fail",
        message: `${audit.readModel.parityMismatches} Character serving/pointer read-model mismatches.`,
        remediation:
          "Inspect character-soul:audit output and repair the canonical view or serving pointers.",
      },
      {
        id: "character-soul-snapshot-load",
        area: "Chat",
        status: audit.snapshots.invalid.length === 0 ? "pass" : "fail",
        message: `${audit.snapshots.valid}/${audit.snapshots.referenced} serving/current/pinned Soul references load successfully.`,
        remediation:
          "Resolve every invalid referenced snapshot before cutover; do not silently fall back to mutable Character columns.",
      },
      {
        id: "character-soul-legacy-drain",
        area: "Chat",
        status:
          audit.drain.legacyServingSnapshots >= 0 &&
          audit.drain.legacyCurrentPointers >= 0
            ? "pass"
            : "fail",
        message: `${audit.drain.legacyServingSnapshots} legacy serving snapshots; ${audit.drain.legacyCurrentPointers} legacy current user pointers.`,
        remediation:
          "Keep the explicit legacy decoder and drain metrics until reviewed v1 replacements are published.",
      },
      {
        id: "character-soul-pin-drain",
        area: "Chat",
        status:
          audit.drain.nullPinSessions >= 0 &&
          audit.drain.legacyPinnedSessions >= 0
            ? "pass"
            : "fail",
        message: `${audit.drain.activeSessions} active sessions; ${audit.drain.nullPinSessions} null pins; ${audit.drain.legacyPinnedSessions} legacy pins.`,
        remediation:
          "Observe drain and use the compatibility-QA migration command only when an old session must move.",
      },
    );
  } catch (error) {
    checks.push({
      id: "character-soul-authority",
      area: "Chat",
      status: "fail",
      message: `Character Soul authority audit failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "Run character-soul:audit against the target database and repair topology, permissions, or snapshot authority.",
    });
  } finally {
    await Promise.all([db.$disconnect(), chatDb.$disconnect()]);
  }
}

async function addMigrationAuthorityPreflight(
  env: EnvLike,
  checks: LaunchReadinessCheck[],
) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || !isPostgresUrl(databaseUrl)) {
    checks.push({
      id: "database-migration-authority",
      area: "Data",
      status: "fail",
      message:
        "Database migration authority could not run without a PostgreSQL DATABASE_URL.",
      remediation:
        "Set the target Main database URL and rerun check:launch; do not infer migration state from the application schema alone.",
    });
    return;
  }

  try {
    const authority = await inspectMigrationAuthority(databaseUrl);
    const differences = [
      authority.localOnly.length > 0
        ? `pending=${authority.localOnly.join(",")}`
        : null,
      authority.databaseOnly.length > 0
        ? `databaseOnly=${authority.databaseOnly.join(",")}`
        : null,
      authority.checksumMismatches.length > 0
        ? `checksumMismatch=${authority.checksumMismatches.join(",")}`
        : null,
      authority.incomplete.length > 0
        ? `unfinished=${authority.incomplete.join(",")}`
        : null,
      authority.duplicateApplied.length > 0
        ? `duplicateApplied=${authority.duplicateApplied.join(",")}`
        : null,
      authority.schemaPostconditionFailures.length > 0
        ? `schemaDrift=${authority.schemaPostconditionFailures.join(",")}`
        : null,
    ].filter((value): value is string => value !== null);
    checks.push({
      id: "database-migration-authority",
      area: "Data",
      status: authority.ok ? "pass" : "fail",
      message: authority.ok
        ? `Target database exactly matches ${authority.expectedCount} repository migrations, checksums, and launch-critical schema postconditions.`
        : `Target database has ${authority.appliedCount}/${authority.expectedCount} exact applied migrations; ${differences.join("; ") || "migration history is not exact"}.`,
      remediation: authority.ok
        ? undefined
        : authority.schemaPostconditionFailures.length > 0
          ? "Have the database operator compare the target catalog/data with the four launch-critical migration postconditions and repair the drift through a reviewed migration; the launch gate never applies migrations."
          : "Have the database operator review and deploy the repository migrations, then rerun check:launch. The launch gate never applies migrations.",
    });
  } catch (error) {
    checks.push({
      id: "database-migration-authority",
      area: "Data",
      status: "fail",
      message: `Database migration authority inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "Grant the launch-gate role read access to _prisma_migrations, repair migration history if needed, and rerun check:launch.",
    });
  }
}

async function addMainToChatBacklogPreflight(
  env: EnvLike,
  checks: LaunchReadinessCheck[],
) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl || !isPostgresUrl(databaseUrl)) {
    checks.push({
      id: "main-to-chat-failed-backlog",
      area: "Chat",
      status: "fail",
      message:
        "Main to Chat failed-backlog authority could not run without a PostgreSQL DATABASE_URL.",
      remediation:
        "Set the target Main database URL and rerun check:launch.",
    });
    return;
  }

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  try {
    const authority = await inspectMainToChatFailedBacklog(db);
    checks.push({
      id: "main-to-chat-failed-backlog",
      area: "Chat",
      status: authority.ok ? "pass" : "fail",
      message: authority.ok
        ? "Main has no failed durable carriers targeting Chat."
        : `Main has ${authority.failed} unresolved failed durable carriers targeting Chat.`,
      remediation: authority.ok
        ? undefined
        : "Run `bun run --cwd packages/main admin:audit:main-chat-outbox --summary --fail-on-action`; replay only live-authority rows and use the audited target-missing disposition for confirmed obsolete callbacks before launch.",
    });
  } catch (error) {
    checks.push({
      id: "main-to-chat-failed-backlog",
      area: "Chat",
      status: "fail",
      message: `Main to Chat failed-backlog inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "Grant the launch-gate role read access to Main outbox authority and rerun check:launch.",
    });
  } finally {
    await db.$disconnect();
  }
}

async function addRecoveryRehearsalPreflight(
  env: EnvLike,
  checks: LaunchReadinessCheck[],
) {
  const configuredPath = env.RECOVERY_REHEARSAL_BUNDLE?.trim();
  if (!configuredPath) {
    checks.push({
      id: "recovery-rehearsal-authority",
      area: "Recovery",
      status: "fail",
      message:
        "No current Main PostgreSQL + Chat FS + Blob recovery rehearsal bundle is configured.",
      remediation:
        "Create a fresh quiesced three-authority checkpoint, restore it into isolated targets, and set RECOVERY_REHEARSAL_BUNDLE to the published checksummed bundle.",
    });
    return;
  }
  const approvedBundleDigest =
    env.RECOVERY_REHEARSAL_APPROVED_SHA256?.trim() ?? "";
  if (!/^[a-f0-9]{64}$/u.test(approvedBundleDigest)) {
    checks.push({
      id: "recovery-rehearsal-authority",
      area: "Recovery",
      status: "fail",
      message:
        "The recovery bundle has no exact operator-approved manifest digest.",
      remediation:
        "Review the published bundle manifest, record sha256(<bundle>.sha256) as RECOVERY_REHEARSAL_APPROVED_SHA256 outside the bundle, and rerun check:launch.",
    });
    return;
  }

  const parsedMaxAge = Number.parseInt(
    env.RECOVERY_REHEARSAL_MAX_AGE_MINUTES ?? "1440",
    10,
  );
  const maxAgeMinutes =
    Number.isFinite(parsedMaxAge) && parsedMaxAge > 0 ? parsedMaxAge : 1440;
  try {
    const expectedMigrations = await loadExpectedMigrationAuthority();
    const expectedSourceAuthority = resolveRecoveryRehearsalSourceAuthority({
      env,
      workspaceRoot: resolveWorkspacePath("."),
      chatWorkingDirectory: resolveWorkspacePath("packages/chat"),
    });
    const authority = await inspectRecoveryRehearsalBundle({
      bundlePath: resolveWorkspacePath(configuredPath),
      expectedMigrations,
      expectedSourceAuthority,
      approvedBundleDigest,
      now: new Date(),
      maxAgeMinutes,
    });
    checks.push({
      id: "recovery-rehearsal-authority",
      area: "Recovery",
      status: authority.ok ? "pass" : "fail",
      message: authority.ok
        ? `Current checksummed recovery bundle proves an isolated ${authority.migrationCount}/${expectedMigrations.length} restore of Main PostgreSQL, Chat FS and Blob.`
        : `Recovery rehearsal bundle is not launch authority: ${authority.problems.join("; ") || "unknown recovery evidence failure"}.`,
      remediation: authority.ok
        ? undefined
        : "Create a fresh quiesced three-authority checkpoint at the exact repository migration revision, perform an isolated restore, publish all source/restore manifests in one checksummed bundle, and rerun check:launch.",
    });
  } catch (error) {
    checks.push({
      id: "recovery-rehearsal-authority",
      area: "Recovery",
      status: "fail",
      message: `Recovery rehearsal inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation:
        "Repair or regenerate the checksummed recovery bundle and rerun check:launch.",
    });
  }
}

async function runLaunchReadinessCli() {
  try {
    const cliOptions = parseLaunchReadinessCliArgs(process.argv.slice(2));
    if (cliOptions.help) {
      process.stdout.write(`${formatLaunchReadinessHelp()}\n`);
      process.exitCode = 0;
    } else {
      const preflightChecks: LaunchReadinessCheck[] = [];
      let env: EnvLike = process.env;
      try {
        env = loadRecoveryServiceEnvironment({
          workspaceRoot: resolveWorkspacePath("."),
          launchEnvFile: cliOptions.envFile ?? null,
          adminEnvFile: cliOptions.adminEnvFile ?? null,
          chatEnvFile: cliOptions.chatEnvFile ?? null,
          genEnvFile: cliOptions.genEnvFile ?? null,
          processEnv: process.env,
        });
      } catch (error) {
        preflightChecks.push({
          id: "launch-env-file",
          area: "Runtime",
          status: "fail",
          message: error instanceof Error
            ? error.message
            : "Service environment resolution failed.",
          remediation:
            "Create exact Main, Admin, Chat, and Gen production env files and pass them to check:launch.",
        });
      }
      await addMigrationAuthorityPreflight(env, preflightChecks);
      await addMainToChatBacklogPreflight(env, preflightChecks);
      await addRecoveryRehearsalPreflight(env, preflightChecks);
      await addCharacterSoulAuthorityPreflight(env, preflightChecks);
      const report = assessLaunchReadiness({ env, preflightChecks });
      const output = cliOptions.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatLaunchReadinessReport(report)}\n`;

      if (cliOptions.reportFile) {
        await writeLaunchReadinessReport(cliOptions.reportFile, report);
      }

      process.stdout.write(output);
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Launch readiness failed before checks: ${message}\n`);
    process.exitCode = 2;
  }
}

if (isCliEntrypoint()) {
  void runLaunchReadinessCli();
}
