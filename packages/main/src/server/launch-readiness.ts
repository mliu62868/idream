import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { looksLikeMockChatResponse } from "@idream/shared";
import { parse as parseDotenv } from "dotenv";

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
  summary: Record<LaunchReadinessStatus, number>;
  checks: LaunchReadinessCheck[];
}

export interface ImagePipelineProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  pipelineUrl?: string | null;
  model?: string | null;
  orientation?: string;
  count?: number;
  generationJobId?: string;
  loadError?: string;
  finalize?: {
    kind?: string | null;
    assets?: number;
    error?: { code?: string; message?: string } | null;
  } | null;
}

export interface BlobStorageProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  endpoint?: string | null;
  bucket?: string | null;
  key?: string;
  bytes?: number;
  loadError?: string;
  put?: {
    ok?: boolean;
    size?: number;
    error?: { code?: string; message?: string } | null;
  } | null;
  signedGetUrl?: {
    ok?: boolean;
    host?: string | null;
    pathname?: string | null;
    expiresInSeconds?: number;
    error?: { code?: string; message?: string } | null;
  } | null;
  readback?: {
    ok?: boolean;
    source?: string | null;
    status?: number;
    bytes?: number;
    matches?: boolean;
    sha256?: string | null;
    error?: string | null;
  } | null;
  delete?: {
    ok?: boolean;
    error?: { code?: string; message?: string } | null;
  } | null;
}

export interface SafetyGatewayProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  serviceUrl?: string | null;
  targetType?: string | null;
  status?: string | null;
  policyCode?: string | null;
  confidence?: number;
  loadError?: string;
  error?: { code?: string; message?: string } | null;
}

export interface ChatModelProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  chunks?: number;
  characters?: number;
  assistantPreview?: string | null;
  done?: boolean;
  loadError?: string;
  error?: { code?: string; message?: string } | null;
}

export interface ChatServiceProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  serviceUrl?: string | null;
  userId?: string | null;
  usedSignedBff?: boolean;
  loadError?: string;
  health?: {
    ok?: boolean;
    status?: number;
    service?: string | null;
    error?: string | null;
  } | null;
  signedRequest?: {
    ok?: boolean;
    status?: number;
    sessionsCount?: number;
    error?: string | null;
  } | null;
  unsignedRequest?: {
    ok?: boolean;
    status?: number;
    error?: string | null;
  } | null;
  error?: { code?: string; message?: string } | null;
}

export interface VoiceModelProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  voiceId?: string | null;
  key?: string | null;
  audioDurationMs?: number;
  bytes?: number;
  contentType?: string | null;
  loadError?: string;
  error?: { code?: string; message?: string } | null;
}

export interface PaymentProviderProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  baseUrl?: string | null;
  storeId?: string | null;
  canViewStore?: boolean;
  returnedStoreId?: string | null;
  loadError?: string;
  error?: { code?: string; message?: string } | null;
}

export interface AgeVerificationProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  provider?: string | null;
  serviceUrl?: string | null;
  jurisdiction?: string | null;
  providerVerificationId?: string | null;
  status?: string | null;
  url?: string | null;
  loadError?: string;
  error?: { code?: string; message?: string } | null;
}

export interface ProductConfigProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  videoFeatureEnabled?: boolean;
  activeImageProfiles?: number;
  activeImageCharacterTemplates?: number;
  activeImageFreeplayTemplates?: number;
  activeImagePricingRules?: number;
  activeVideoProfiles?: number;
  activeVideoCharacterTemplates?: number;
  activeVideoFreeplayTemplates?: number;
  activeVideoPricingRules?: number;
  publicCharacters?: number;
  publicCharactersWithSystemPrompt?: number;
  loadError?: string;
  error?: { code?: string; message?: string } | null;
}

export interface WebSurfaceProbeEvidence {
  ok?: boolean;
  checkedAt?: string | null;
  durationMs?: number;
  mainUrl?: string | null;
  adminUrl?: string | null;
  loadError?: string;
  home?: {
    ok?: boolean;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    containsBrand?: boolean;
    nextErrorShell?: boolean;
    error?: string | null;
  } | null;
  generate?: {
    ok?: boolean;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    containsGenerator?: boolean;
    nextErrorShell?: boolean;
    error?: string | null;
  } | null;
  apiAgeGate?: {
    ok?: boolean;
    status?: number;
    code?: string | null;
    reason?: string | null;
    error?: string | null;
  } | null;
  admin?: {
    ok?: boolean;
    status?: number;
    bytes?: number;
    contentType?: string | null;
    protected?: boolean;
    nextErrorShell?: boolean;
    error?: string | null;
  } | null;
  adminApi?: {
    ok?: boolean;
    status?: number;
    code?: string | null;
    error?: string | null;
  } | null;
  error?: { code?: string; message?: string } | null;
}

type EnvLike = Record<string, string | undefined>;

const criticalProviderKeys = [
  "CHAT_PROVIDER",
  "VOICE_PROVIDER",
  "MODERATION_PROVIDER",
  "PAYMENT_PROVIDER",
  "BLOB_PROVIDER",
  "AGE_VERIFICATION_PROVIDER",
] as const;

type CriticalProviderKey = (typeof criticalProviderKeys)[number];

export interface LaunchReadinessCapabilities {
  mainProviderImplementations: Record<CriticalProviderKey, readonly string[]>;
  genImageProviders: readonly string[];
  genVideoProviders: readonly string[];
}

export type LaunchReadinessCapabilityOverride = {
  mainProviderImplementations?: Partial<Record<CriticalProviderKey, readonly string[]>>;
  genImageProviders?: readonly string[];
  genVideoProviders?: readonly string[];
};

export interface LaunchReadinessOptions {
  env?: EnvLike;
  capabilities?: LaunchReadinessCapabilityOverride;
  imagePipelineProbe?: ImagePipelineProbeEvidence | null;
  blobStorageProbe?: BlobStorageProbeEvidence | null;
  safetyGatewayProbe?: SafetyGatewayProbeEvidence | null;
  chatServiceProbe?: ChatServiceProbeEvidence | null;
  chatModelProbe?: ChatModelProbeEvidence | null;
  voiceModelProbe?: VoiceModelProbeEvidence | null;
  paymentProviderProbe?: PaymentProviderProbeEvidence | null;
  ageVerificationProbe?: AgeVerificationProbeEvidence | null;
  productConfigProbe?: ProductConfigProbeEvidence | null;
  webSurfaceProbe?: WebSurfaceProbeEvidence | null;
  now?: Date;
  preflightChecks?: LaunchReadinessCheck[];
}

export interface LaunchReadinessCliOptions {
  envFile?: string;
  help: boolean;
  json: boolean;
}

export const currentLaunchCapabilities: LaunchReadinessCapabilities = {
  mainProviderImplementations: {
    CHAT_PROVIDER: ["mock", "pipeline"],
    VOICE_PROVIDER: ["mock", "pipeline"],
    MODERATION_PROVIDER: ["mock", "safety-gateway"],
    PAYMENT_PROVIDER: ["mock", "btcpay"],
    BLOB_PROVIDER: ["mock", "r2", "s3"],
    AGE_VERIFICATION_PROVIDER: ["mock", "gocam"],
  },
  genImageProviders: ["mock", "pipeline"],
  genVideoProviders: ["mock", "pipeline"],
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
      override?.genImageProviders ?? currentLaunchCapabilities.genImageProviders,
    genVideoProviders:
      override?.genVideoProviders ?? currentLaunchCapabilities.genVideoProviders,
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

function isPublicHttpsUrl(value: string | undefined) {
  if (!value || isPlaceholderValue(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function isProductionBullmqPrefix(value: string | undefined) {
  if (typeof value !== "string" || !hasMinLength(value, 1)) return false;
  return !new Set([
    "idream:development",
    "idream:test",
    "idream:chat",
    "idream:gen",
  ]).has(value);
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

function addCheck(
  checks: LaunchReadinessCheck[],
  check: LaunchReadinessCheck,
) {
  checks.push(check);
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
    spec.url === true
      ? isUrl(value)
      : hasMinLength(value, spec.minLength ?? 1);

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
) {
  for (const key of criticalProviderKeys) {
    const configured = env[key] ?? "mock";
    const providerId = kebab(key);

    addCheck(checks, {
      id: `${providerId}-non-mock`,
      area: "Providers",
      status: configured !== "mock" ? "pass" : "fail",
      message:
        configured !== "mock"
          ? `${key}=${configured} is not mock.`
          : `${key} is still mock.`,
      remediation: `Configure a production ${key} adapter and credentials before launch.`,
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
}

function addChatServiceChecks(checks: LaunchReadinessCheck[], env: EnvLike) {
  const chatModelProvider = env.CHAT_MODEL_PROVIDER ?? env.CHAT_PROVIDER ?? "mock";
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
    status: supportedChatModelProviders.includes(chatModelProvider) ? "pass" : "fail",
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
  const reportPath = env.CHAT_SERVICE_PROBE_REPORT;

  if (!reportPath) {
    problems.push("CHAT_SERVICE_PROBE_REPORT is not set");
  }
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (!sameUrl(probe.serviceUrl, env.CHAT_SERVICE_URL)) {
      problems.push("probe service URL does not match CHAT_SERVICE_URL");
    }
    if (!hasTrimmedText(probe.userId)) {
      problems.push("probe user id is missing");
    }
    if (probe.usedSignedBff !== true) {
      problems.push("probe did not use signed BFF headers");
    }
    if (probe.health?.ok !== true || probe.health.status !== 200) {
      problems.push("healthz did not return HTTP 200 ok");
    }
    if (probe.signedRequest?.ok !== true || probe.signedRequest.status !== 200) {
      problems.push("signed chat request did not return HTTP 200");
    }
    if (probe.unsignedRequest?.status !== 401) {
      problems.push("unsigned chat request was not rejected with HTTP 401");
    }
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "CHAT_SERVICE_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
  }

  addCheck(checks, {
    id: "chat-service-live-probe",
    area: "Chat",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent chat service probe reached healthz and a signed read-only chat endpoint."
        : `Chat service probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : "Run `bun run --filter @idream/main probe:chat-service -- --report .tmp/launch-chat-service-probe.json` against the real chat service, then set CHAT_SERVICE_PROBE_REPORT before check:launch.",
  });
}

function addChatModelProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ChatModelProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const reportPath = env.CHAT_MODEL_PROBE_REPORT;
  const configuredProvider = env.CHAT_MODEL_PROVIDER ?? env.CHAT_PROVIDER ?? "mock";
  const configuredBaseUrl = env.CHAT_MODEL_BASE_URL ?? env.PIPELINE_API_URL;
  const configuredModel = env.CHAT_MODEL_NAME ?? env.PIPELINE_CHAT_MODEL_DEFAULT;

  if (!reportPath) {
    problems.push("CHAT_MODEL_PROBE_REPORT is not set");
  }
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
        problems.push("probe base URL does not match CHAT_MODEL_BASE_URL or PIPELINE_API_URL");
      }
      if (hasMinLength(configuredModel, 1) && probe.model !== configuredModel) {
        problems.push("probe model does not match CHAT_MODEL_NAME or PIPELINE_CHAT_MODEL_DEFAULT");
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
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "CHAT_MODEL_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
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
        : "Run `bun run --filter @idream/main probe:chat -- --report .tmp/launch-chat-probe.json` against the real chat model gateway, then set CHAT_MODEL_PROBE_REPORT before check:launch.",
  });
}

function addVoiceModelProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: VoiceModelProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const reportPath = env.VOICE_MODEL_PROBE_REPORT;
  const configuredProvider = env.VOICE_PROVIDER ?? "mock";
  const configuredBaseUrl = env.PIPELINE_VOICE_API_URL ?? env.PIPELINE_API_URL;
  const configuredModel = env.PIPELINE_VOICE_MODEL_DEFAULT;

  if (!reportPath) {
    problems.push("VOICE_MODEL_PROBE_REPORT is not set");
  }
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
        problems.push("probe base URL does not match PIPELINE_VOICE_API_URL or PIPELINE_API_URL");
      }
      if (hasMinLength(configuredModel, 1) && probe.model !== configuredModel) {
        problems.push("probe model does not match PIPELINE_VOICE_MODEL_DEFAULT");
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
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "VOICE_MODEL_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
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
        : "Run `bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json` against the real voice model gateway, then set VOICE_MODEL_PROBE_REPORT before check:launch.",
  });
}

function addChatModerationChecks(checks: LaunchReadinessCheck[], env: EnvLike) {
  const chatModerationProvider =
    env.CHAT_MODERATION_PROVIDER ?? env.MODERATION_PROVIDER ?? "mock";
  addCheck(checks, {
    id: "chat-moderation-provider",
    area: "Chat",
    status: chatModerationProvider === "safety-gateway" ? "pass" : "fail",
    message: `Chat moderation provider is ${chatModerationProvider}.`,
    remediation:
      "Set CHAT_MODERATION_PROVIDER=safety-gateway or share MODERATION_PROVIDER=safety-gateway with packages/chat.",
  });

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
  const reportPath = env.PAYMENT_PROVIDER_PROBE_REPORT;
  const configuredProvider = env.PAYMENT_PROVIDER ?? "mock";

  if (!reportPath) {
    problems.push("PAYMENT_PROVIDER_PROBE_REPORT is not set");
  }
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
      if (hasMinLength(env.BTCPAY_STORE_ID, 1) && probe.storeId !== env.BTCPAY_STORE_ID) {
        problems.push("probe store id does not match BTCPAY_STORE_ID");
      }
      if (probe.canViewStore !== true) {
        problems.push("probe could not read the BTCPay store");
      }
      if (
        hasMinLength(env.BTCPAY_STORE_ID, 1) &&
        probe.returnedStoreId &&
        probe.returnedStoreId !== env.BTCPAY_STORE_ID
      ) {
        problems.push("BTCPay returned a different store id");
      }
    }
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "PAYMENT_PROVIDER_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
  }

  addCheck(checks, {
    id: "payment-provider-live-probe",
    area: "Billing",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent payment provider probe authenticated and read provider store metadata."
        : `Payment provider probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : "Run `bun run --filter @idream/main probe:payment -- --report .tmp/launch-payment-probe.json` against the real payment provider, then set PAYMENT_PROVIDER_PROBE_REPORT before check:launch.",
  });
}

function addAgeVerificationProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: AgeVerificationProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const reportPath = env.AGE_VERIFICATION_PROBE_REPORT;
  const configuredProvider = env.AGE_VERIFICATION_PROVIDER ?? "mock";

  if (!reportPath) {
    problems.push("AGE_VERIFICATION_PROBE_REPORT is not set");
  }
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
        problems.push("probe service URL does not match AGE_VERIFY_SERVICE_URL");
      }
      if (!hasMinLength(probe.providerVerificationId ?? undefined, 1)) {
        problems.push("probe did not return a provider verification id");
      }
      if (probe.status !== "pending") {
        problems.push(`probe session status is ${probe.status ?? "unknown"}, not pending`);
      }
      if (!isPublicHttpsUrl(probe.url ?? undefined)) {
        problems.push("probe verification URL is missing or not public HTTPS");
      }
    }
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "AGE_VERIFICATION_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
  }

  addCheck(checks, {
    id: "age-verification-live-probe",
    area: "Compliance",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent age verification probe created a provider verification session."
        : `Age verification probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : "Run `bun run --filter @idream/main probe:age -- --report .tmp/launch-age-probe.json` against the real age gateway, then set AGE_VERIFICATION_PROBE_REPORT before check:launch.",
  });
}

function addImagePipelineChecks(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  capabilities: LaunchReadinessCapabilities,
  probe: ImagePipelineProbeEvidence | null,
  now: Date,
) {
  const configured = env.GEN_IMAGE_PROVIDER ?? env.IMAGE_PROVIDER ?? "mock";
  const supported = capabilities.genImageProviders.includes(configured);

  addCheck(checks, {
    id: "gen-image-provider",
    area: "Generation",
    status: configured === "pipeline" && supported ? "pass" : "fail",
    message:
      configured === "pipeline" && supported
        ? "Image generation worker is configured for the pipeline provider."
        : `Image generation worker is configured as ${configured}.`,
    remediation:
      configured === "pipeline" && supported
        ? undefined
        : "Set GEN_IMAGE_PROVIDER=pipeline and run the image pipeline probe against the real service.",
  });

  addRequiredCheck(checks, env, {
    id: "pipeline-api-url",
    area: "Generation",
    key: "PIPELINE_API_URL",
    label: "Pipeline API URL",
    url: true,
    remediation: "Set PIPELINE_API_URL to the internal ComfyUI/Z-Image gateway.",
  });
  addRequiredCheck(checks, env, {
    id: "pipeline-api-token",
    area: "Generation",
    key: "PIPELINE_API_TOKEN",
    label: "Pipeline API token",
    minLength: 16,
    remediation: "Set PIPELINE_API_TOKEN so product services authenticate to the pipeline.",
  });

  const model = env.PIPELINE_IMAGE_MODEL_DEFAULT;
  addCheck(checks, {
    id: "pipeline-image-model",
    area: "Generation",
    status: hasMinLength(model, 1) ? "pass" : "warn",
    message: hasMinLength(model, 1)
      ? "Default image model is documented for the pipeline."
      : "Default image model is not set in product env.",
    remediation: hasMinLength(model, 1)
      ? undefined
      : "Set PIPELINE_IMAGE_MODEL_DEFAULT or document the default model in the pipeline service.",
  });

  addImagePipelineProbeCheck(checks, env, probe, now);
}

function addVideoPipelineChecks(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  capabilities: LaunchReadinessCapabilities,
  productConfigProbe: ProductConfigProbeEvidence | null,
) {
  const configured = env.GEN_VIDEO_PROVIDER ?? env.VIDEO_PROVIDER;
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
      status: videoFeatureDisabled ? "pass" : videoFeatureEnabled ? "fail" : "warn",
      message: videoFeatureDisabled
        ? "Video generation is disabled in product config; a production video provider is not required for launch."
        : videoFeatureEnabled
          ? "Video generation is enabled in product config but the video worker is not configured for a production provider."
          : "Video generation worker is not configured for a production provider; video must remain disabled.",
      remediation:
        videoFeatureDisabled
          ? undefined
          : "Keep the video_gen feature flag off, or set GEN_VIDEO_PROVIDER=pipeline with a tested video gateway before enabling video generation.",
    });
    return;
  }

  const supported = capabilities.genVideoProviders.includes(configured);
  addCheck(checks, {
    id: "gen-video-provider",
    area: "Generation",
    status: configured === "pipeline" && supported ? "pass" : "fail",
    message:
      configured === "pipeline" && supported
        ? "Video generation worker is configured for the pipeline provider."
        : `Video generation worker is configured as ${configured}.`,
    remediation:
      configured === "pipeline" && supported
        ? undefined
        : "Use GEN_VIDEO_PROVIDER=pipeline or keep video generation disabled for launch.",
  });

  if (configured === "pipeline") {
    const model = env.PIPELINE_VIDEO_MODEL_DEFAULT;
    addCheck(checks, {
      id: "pipeline-video-model",
      area: "Generation",
      status: hasMinLength(model, 1) ? "pass" : "warn",
      message: hasMinLength(model, 1)
        ? "Default video model is documented for the pipeline."
        : "Default video model is not set in product env.",
      remediation: hasMinLength(model, 1)
        ? undefined
        : "Set PIPELINE_VIDEO_MODEL_DEFAULT or document the default model in the pipeline service.",
    });
  }
}

function addProductConfigProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ProductConfigProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];

  if (!env.PRODUCT_CONFIG_PROBE_REPORT) {
    problems.push("PRODUCT_CONFIG_PROBE_REPORT is not set");
  }
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if ((probe.activeImageProfiles ?? 0) < 1) {
      problems.push("no active image model profile is configured");
    }
    if ((probe.activeImageCharacterTemplates ?? 0) < 1) {
      problems.push("no active image character prompt template is configured");
    }
    if ((probe.activeImageFreeplayTemplates ?? 0) < 1) {
      problems.push("no active image freeplay prompt template is configured");
    }
    if ((probe.activeImagePricingRules ?? 0) < 1) {
      problems.push("no active image pricing rule is configured");
    }
    if (
      (probe.publicCharacters ?? 0) > 0 &&
      (probe.publicCharactersWithSystemPrompt ?? 0) < 1
    ) {
      problems.push("public characters have no chat system prompts configured");
    }

    if (probe.videoFeatureEnabled === true) {
      if ((probe.activeVideoProfiles ?? 0) < 1) {
        problems.push("video_gen is enabled but no active video model profile is configured");
      }
      if ((probe.activeVideoCharacterTemplates ?? 0) < 1) {
        problems.push("video_gen is enabled but no active video character prompt template is configured");
      }
      if ((probe.activeVideoFreeplayTemplates ?? 0) < 1) {
        problems.push("video_gen is enabled but no active video freeplay prompt template is configured");
      }
      if ((probe.activeVideoPricingRules ?? 0) < 1) {
        problems.push("video_gen is enabled but no active video pricing rule is configured");
      }
    }

    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "PRODUCT_CONFIG_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
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
        : "Run `bun run --filter @idream/main probe:product-config -- --report .tmp/launch-product-config-probe.json`, then set PRODUCT_CONFIG_PROBE_REPORT before check:launch.",
  });
}

function addWebSurfaceProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: WebSurfaceProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const expectedMainUrl = env.MAIN_WEB_URL ?? env.BETTER_AUTH_URL;

  if (!env.WEB_SURFACE_PROBE_REPORT) {
    problems.push("WEB_SURFACE_PROBE_REPORT is not set");
  }
  if (!isUrl(expectedMainUrl)) {
    problems.push("MAIN_WEB_URL or BETTER_AUTH_URL is missing or invalid");
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
      problems.push("probe main URL does not match MAIN_WEB_URL or BETTER_AUTH_URL");
    }
    if (!sameUrl(probe.adminUrl, env.ADMIN_WEB_URL)) {
      problems.push("probe admin URL does not match ADMIN_WEB_URL");
    }
    if (
      probe.home?.ok !== true ||
      probe.home.status !== 200 ||
      probe.home.containsBrand !== true ||
      probe.home.nextErrorShell === true
    ) {
      problems.push("main homepage did not return a healthy branded HTML response");
    }
    if (
      probe.generate?.ok !== true ||
      probe.generate.status !== 200 ||
      probe.generate.containsGenerator !== true ||
      probe.generate.nextErrorShell === true
    ) {
      problems.push("generation page did not return a healthy generator HTML response");
    }
    if (
      probe.apiAgeGate?.ok !== true ||
      probe.apiAgeGate.status !== 403 ||
      probe.apiAgeGate.code !== "forbidden" ||
      probe.apiAgeGate.reason !== "age_gate_required"
    ) {
      problems.push("unauthenticated character API did not fail closed on the age gate");
    }
    if (
      probe.admin?.ok !== true ||
      probe.admin.status !== 200 ||
      probe.admin.protected !== true ||
      probe.admin.nextErrorShell === true
    ) {
      problems.push("admin surface did not return the protected unauthenticated state");
    }
    if (
      probe.adminApi?.ok !== true ||
      probe.adminApi.status !== 401 ||
      probe.adminApi.code !== "unauthorized"
    ) {
      problems.push("unauthenticated admin API did not fail closed");
    }

    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "WEB_SURFACE_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
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
        : "Run `bun run --filter @idream/main probe:web-surface -- --report .tmp/launch-web-surface-probe.json` against the deployed main/admin web surfaces, then set WEB_SURFACE_PROBE_REPORT before check:launch.",
  });
}

function addImagePipelineProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: ImagePipelineProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const reportPath = env.PIPELINE_IMAGE_PROBE_REPORT;

  if (!reportPath) {
    problems.push("PIPELINE_IMAGE_PROBE_REPORT is not set");
  }
  if (!probe) {
    problems.push("no probe report was loaded");
  } else if (probe.loadError) {
    problems.push(probe.loadError);
  } else {
    if (probe.ok !== true) problems.push("probe did not complete successfully");
    if (probe.provider !== "pipeline") {
      problems.push(`probe provider is ${probe.provider ?? "unknown"}, not pipeline`);
    }
    if (!sameUrl(probe.pipelineUrl, env.PIPELINE_API_URL)) {
      problems.push("probe pipeline URL does not match PIPELINE_API_URL");
    }
    if (
      hasMinLength(env.PIPELINE_IMAGE_MODEL_DEFAULT, 1) &&
      probe.model !== env.PIPELINE_IMAGE_MODEL_DEFAULT
    ) {
      problems.push("probe model does not match PIPELINE_IMAGE_MODEL_DEFAULT");
    }
    if (probe.finalize?.kind !== "generation.completed") {
      problems.push("probe finalizer payload is not generation.completed");
    }
    if ((probe.finalize?.assets ?? 0) < 1) {
      problems.push("probe produced no assets");
    }
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "PIPELINE_IMAGE_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
  }

  addCheck(checks, {
    id: "pipeline-image-live-probe",
    area: "Generation",
    status: problems.length === 0 ? "pass" : "fail",
    message:
      problems.length === 0
        ? "Recent image pipeline probe completed and produced at least one asset."
        : `Image pipeline probe evidence is missing or invalid: ${problems.join("; ")}.`,
    remediation:
      problems.length === 0
        ? undefined
        : "Run `bun run --filter @idream/gen probe:image -- --report .tmp/launch-image-probe.json` against the real pipeline, then set PIPELINE_IMAGE_PROBE_REPORT to that report before check:launch.",
  });
}

function addBlobStorageProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: BlobStorageProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const reportPath = env.BLOB_STORAGE_PROBE_REPORT;
  const configuredProvider = env.BLOB_PROVIDER ?? "mock";

  if (!reportPath) {
    problems.push("BLOB_STORAGE_PROBE_REPORT is not set");
  }
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
      if (hasMinLength(env.BLOB_BUCKET, 1) && probe.bucket !== env.BLOB_BUCKET) {
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
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "BLOB_STORAGE_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
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
        : "Run `bun run --filter @idream/main probe:blob -- --report .tmp/launch-blob-probe.json` against the real object store, then set BLOB_STORAGE_PROBE_REPORT before check:launch.",
  });
}

function addSafetyGatewayProbeCheck(
  checks: LaunchReadinessCheck[],
  env: EnvLike,
  probe: SafetyGatewayProbeEvidence | null,
  now: Date,
) {
  const problems: string[] = [];
  const reportPath = env.SAFETY_GATEWAY_PROBE_REPORT;
  const configuredProvider = env.MODERATION_PROVIDER ?? "mock";

  if (!reportPath) {
    problems.push("SAFETY_GATEWAY_PROBE_REPORT is not set");
  }
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
        problems.push("probe service URL does not match MODERATION_SERVICE_URL");
      }
    }
    if (probe.targetType !== "text") {
      problems.push("probe target type is not text");
    }
    if (probe.status !== "passed") {
      problems.push(`probe decision is ${probe.status ?? "unknown"}, not passed`);
    }
    if (typeof probe.confidence !== "number" || probe.confidence < 0 || probe.confidence > 1) {
      problems.push("probe confidence is missing or outside 0..1");
    }
    const checkedAt = parseProbeDate(probe.checkedAt);
    if (!checkedAt) {
      problems.push("probe checkedAt is missing or invalid");
    } else {
      const maxAgeMs = probeMaxAgeMs(env, "SAFETY_GATEWAY_PROBE_MAX_AGE_MINUTES");
      if (now.getTime() - checkedAt.getTime() > maxAgeMs) {
        problems.push(`probe is older than ${Math.round(maxAgeMs / 60_000)} minutes`);
      }
      if (checkedAt.getTime() - now.getTime() > 60_000) {
        problems.push("probe checkedAt is in the future");
      }
    }
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
        : "Run `bun run --filter @idream/main probe:safety -- --report .tmp/launch-safety-probe.json` against the real safety gateway, then set SAFETY_GATEWAY_PROBE_REPORT before check:launch.",
  });
}

function parseProbeDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hasTrimmedText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function probeMaxAgeMs(env: EnvLike, key: string) {
  const parsed = Number.parseInt(env[key] ?? "1440", 10);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 1440) * 60_000;
}

function sameUrl(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.toString().replace(/\/$/, "") === rightUrl.toString().replace(/\/$/, "");
  } catch {
    return left.replace(/\/$/, "") === right.replace(/\/$/, "");
  }
}

function loadImagePipelineProbeEvidence(env: EnvLike): ImagePipelineProbeEvidence | null {
  const reportPath = env.PIPELINE_IMAGE_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeImagePipelineProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read PIPELINE_IMAGE_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadBlobStorageProbeEvidence(env: EnvLike): BlobStorageProbeEvidence | null {
  const reportPath = env.BLOB_STORAGE_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeBlobStorageProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read BLOB_STORAGE_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadSafetyGatewayProbeEvidence(env: EnvLike): SafetyGatewayProbeEvidence | null {
  const reportPath = env.SAFETY_GATEWAY_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeSafetyGatewayProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read SAFETY_GATEWAY_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadChatServiceProbeEvidence(env: EnvLike): ChatServiceProbeEvidence | null {
  const reportPath = env.CHAT_SERVICE_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeChatServiceProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read CHAT_SERVICE_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadChatModelProbeEvidence(env: EnvLike): ChatModelProbeEvidence | null {
  const reportPath = env.CHAT_MODEL_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeChatModelProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read CHAT_MODEL_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadVoiceModelProbeEvidence(env: EnvLike): VoiceModelProbeEvidence | null {
  const reportPath = env.VOICE_MODEL_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeVoiceModelProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read VOICE_MODEL_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadPaymentProviderProbeEvidence(env: EnvLike): PaymentProviderProbeEvidence | null {
  const reportPath = env.PAYMENT_PROVIDER_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizePaymentProviderProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read PAYMENT_PROVIDER_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadAgeVerificationProbeEvidence(env: EnvLike): AgeVerificationProbeEvidence | null {
  const reportPath = env.AGE_VERIFICATION_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeAgeVerificationProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read AGE_VERIFICATION_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadProductConfigProbeEvidence(env: EnvLike): ProductConfigProbeEvidence | null {
  const reportPath = env.PRODUCT_CONFIG_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeProductConfigProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read PRODUCT_CONFIG_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function loadWebSurfaceProbeEvidence(env: EnvLike): WebSurfaceProbeEvidence | null {
  const reportPath = env.WEB_SURFACE_PROBE_REPORT;
  if (!reportPath) return null;
  try {
    return normalizeWebSurfaceProbeEvidence(
      JSON.parse(readFileSync(resolveWorkspacePath(reportPath), "utf8")),
    );
  } catch (error) {
    return {
      ok: false,
      loadError: `failed to read WEB_SURFACE_PROBE_REPORT: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

export function loadLaunchReadinessEnv(
  envFile: string,
  baseEnv: EnvLike = process.env,
): EnvLike {
  const filePath = resolveWorkspacePath(envFile);
  const parsed = parseDotenv(readFileSync(filePath));
  return {
    ...baseEnv,
    ...parsed,
  };
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

function normalizeImagePipelineProbeEvidence(value: unknown): ImagePipelineProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  const finalize = isRecord(value.finalize)
    ? {
        kind: typeof value.finalize.kind === "string" ? value.finalize.kind : null,
        assets: typeof value.finalize.assets === "number" ? value.finalize.assets : 0,
        error: isRecord(value.finalize.error)
          ? {
              code:
                typeof value.finalize.error.code === "string"
                  ? value.finalize.error.code
                  : undefined,
              message:
                typeof value.finalize.error.message === "string"
                  ? value.finalize.error.message
                  : undefined,
            }
          : null,
      }
    : null;

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    pipelineUrl: typeof value.pipelineUrl === "string" ? value.pipelineUrl : null,
    model: typeof value.model === "string" ? value.model : null,
    orientation: typeof value.orientation === "string" ? value.orientation : undefined,
    count: typeof value.count === "number" ? value.count : undefined,
    generationJobId:
      typeof value.generationJobId === "string" ? value.generationJobId : undefined,
    finalize,
  };
}

function normalizeBlobStorageProbeEvidence(value: unknown): BlobStorageProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  const put = isRecord(value.put)
    ? {
        ok: typeof value.put.ok === "boolean" ? value.put.ok : false,
        size: typeof value.put.size === "number" ? value.put.size : undefined,
        error: normalizeProbeError(value.put.error),
      }
    : null;
  const signedGetUrl = isRecord(value.signedGetUrl)
    ? {
        ok:
          typeof value.signedGetUrl.ok === "boolean"
            ? value.signedGetUrl.ok
            : false,
        host:
          typeof value.signedGetUrl.host === "string"
            ? value.signedGetUrl.host
            : null,
        pathname:
          typeof value.signedGetUrl.pathname === "string"
            ? value.signedGetUrl.pathname
            : null,
        expiresInSeconds:
          typeof value.signedGetUrl.expiresInSeconds === "number"
            ? value.signedGetUrl.expiresInSeconds
            : undefined,
        error: normalizeProbeError(value.signedGetUrl.error),
      }
    : null;
  const readback = isRecord(value.readback)
    ? {
        ok: typeof value.readback.ok === "boolean" ? value.readback.ok : false,
        source:
          typeof value.readback.source === "string" ? value.readback.source : null,
        status:
          typeof value.readback.status === "number" ? value.readback.status : undefined,
        bytes:
          typeof value.readback.bytes === "number" ? value.readback.bytes : undefined,
        matches:
          typeof value.readback.matches === "boolean"
            ? value.readback.matches
            : false,
        sha256:
          typeof value.readback.sha256 === "string" ? value.readback.sha256 : null,
        error:
          typeof value.readback.error === "string" ? value.readback.error : null,
      }
    : null;
  const deleteResult = isRecord(value.delete)
    ? {
        ok: typeof value.delete.ok === "boolean" ? value.delete.ok : false,
        error: normalizeProbeError(value.delete.error),
      }
    : null;

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    endpoint: typeof value.endpoint === "string" ? value.endpoint : null,
    bucket: typeof value.bucket === "string" ? value.bucket : null,
    key: typeof value.key === "string" ? value.key : undefined,
    bytes: typeof value.bytes === "number" ? value.bytes : undefined,
    put,
    signedGetUrl,
    readback,
    delete: deleteResult,
  };
}

function normalizeSafetyGatewayProbeEvidence(value: unknown): SafetyGatewayProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    serviceUrl: typeof value.serviceUrl === "string" ? value.serviceUrl : null,
    targetType: typeof value.targetType === "string" ? value.targetType : null,
    status: typeof value.status === "string" ? value.status : null,
    policyCode: typeof value.policyCode === "string" ? value.policyCode : null,
    confidence:
      typeof value.confidence === "number" ? value.confidence : undefined,
    error: normalizeProbeError(value.error),
  };
}

function normalizeChatServiceProbeEvidence(value: unknown): ChatServiceProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  const health = isRecord(value.health)
    ? {
        ok: typeof value.health.ok === "boolean" ? value.health.ok : false,
        status: typeof value.health.status === "number" ? value.health.status : undefined,
        service:
          typeof value.health.service === "string" ? value.health.service : null,
        error:
          typeof value.health.error === "string" ? value.health.error : null,
      }
    : null;
  const signedRequest = isRecord(value.signedRequest)
    ? {
        ok:
          typeof value.signedRequest.ok === "boolean"
            ? value.signedRequest.ok
            : false,
        status:
          typeof value.signedRequest.status === "number"
            ? value.signedRequest.status
            : undefined,
        sessionsCount:
          typeof value.signedRequest.sessionsCount === "number"
            ? value.signedRequest.sessionsCount
            : undefined,
        error:
          typeof value.signedRequest.error === "string"
            ? value.signedRequest.error
            : null,
      }
    : null;
  const unsignedRequest = isRecord(value.unsignedRequest)
    ? {
        ok:
          typeof value.unsignedRequest.ok === "boolean"
            ? value.unsignedRequest.ok
            : false,
        status:
          typeof value.unsignedRequest.status === "number"
            ? value.unsignedRequest.status
            : undefined,
        error:
          typeof value.unsignedRequest.error === "string"
            ? value.unsignedRequest.error
            : null,
      }
    : null;

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    serviceUrl: typeof value.serviceUrl === "string" ? value.serviceUrl : null,
    userId: typeof value.userId === "string" ? value.userId : null,
    usedSignedBff:
      typeof value.usedSignedBff === "boolean" ? value.usedSignedBff : false,
    health,
    signedRequest,
    unsignedRequest,
    error: normalizeProbeError(value.error),
  };
}

function normalizeChatModelProbeEvidence(value: unknown): ChatModelProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : null,
    model: typeof value.model === "string" ? value.model : null,
    chunks: typeof value.chunks === "number" ? value.chunks : undefined,
    characters:
      typeof value.characters === "number" ? value.characters : undefined,
    assistantPreview:
      typeof value.assistantPreview === "string" ? value.assistantPreview : null,
    done: typeof value.done === "boolean" ? value.done : false,
    error: normalizeProbeError(value.error),
  };
}

function normalizeVoiceModelProbeEvidence(value: unknown): VoiceModelProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : null,
    model: typeof value.model === "string" ? value.model : null,
    voiceId: typeof value.voiceId === "string" ? value.voiceId : null,
    key: typeof value.key === "string" ? value.key : null,
    audioDurationMs:
      typeof value.audioDurationMs === "number" ? value.audioDurationMs : undefined,
    bytes: typeof value.bytes === "number" ? value.bytes : undefined,
    contentType: typeof value.contentType === "string" ? value.contentType : null,
    error: normalizeProbeError(value.error),
  };
}

function normalizePaymentProviderProbeEvidence(value: unknown): PaymentProviderProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : null,
    storeId: typeof value.storeId === "string" ? value.storeId : null,
    canViewStore:
      typeof value.canViewStore === "boolean" ? value.canViewStore : false,
    returnedStoreId:
      typeof value.returnedStoreId === "string" ? value.returnedStoreId : null,
    error: normalizeProbeError(value.error),
  };
}

function normalizeAgeVerificationProbeEvidence(value: unknown): AgeVerificationProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    provider: typeof value.provider === "string" ? value.provider : null,
    serviceUrl: typeof value.serviceUrl === "string" ? value.serviceUrl : null,
    jurisdiction: typeof value.jurisdiction === "string" ? value.jurisdiction : null,
    providerVerificationId:
      typeof value.providerVerificationId === "string"
        ? value.providerVerificationId
        : null,
    status: typeof value.status === "string" ? value.status : null,
    url: typeof value.url === "string" ? value.url : null,
    error: normalizeProbeError(value.error),
  };
}

function normalizeProductConfigProbeEvidence(value: unknown): ProductConfigProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    videoFeatureEnabled:
      typeof value.videoFeatureEnabled === "boolean"
        ? value.videoFeatureEnabled
        : undefined,
    activeImageProfiles:
      typeof value.activeImageProfiles === "number"
        ? value.activeImageProfiles
        : undefined,
    activeImageCharacterTemplates:
      typeof value.activeImageCharacterTemplates === "number"
        ? value.activeImageCharacterTemplates
        : undefined,
    activeImageFreeplayTemplates:
      typeof value.activeImageFreeplayTemplates === "number"
        ? value.activeImageFreeplayTemplates
        : undefined,
    activeImagePricingRules:
      typeof value.activeImagePricingRules === "number"
        ? value.activeImagePricingRules
        : undefined,
    activeVideoProfiles:
      typeof value.activeVideoProfiles === "number"
        ? value.activeVideoProfiles
        : undefined,
    activeVideoCharacterTemplates:
      typeof value.activeVideoCharacterTemplates === "number"
        ? value.activeVideoCharacterTemplates
        : undefined,
    activeVideoFreeplayTemplates:
      typeof value.activeVideoFreeplayTemplates === "number"
        ? value.activeVideoFreeplayTemplates
        : undefined,
    activeVideoPricingRules:
      typeof value.activeVideoPricingRules === "number"
        ? value.activeVideoPricingRules
        : undefined,
    publicCharacters:
      typeof value.publicCharacters === "number" ? value.publicCharacters : undefined,
    publicCharactersWithSystemPrompt:
      typeof value.publicCharactersWithSystemPrompt === "number"
        ? value.publicCharactersWithSystemPrompt
        : undefined,
    error: normalizeProbeError(value.error),
  };
}

function normalizeWebSurfaceProbeEvidence(value: unknown): WebSurfaceProbeEvidence {
  if (!isRecord(value)) {
    return { ok: false, loadError: "probe report is not a JSON object" };
  }

  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    mainUrl: typeof value.mainUrl === "string" ? value.mainUrl : null,
    adminUrl: typeof value.adminUrl === "string" ? value.adminUrl : null,
    home: normalizeWebPageEvidence(value.home, "containsBrand"),
    generate: normalizeWebPageEvidence(value.generate, "containsGenerator"),
    apiAgeGate: normalizeWebApiAgeGateEvidence(value.apiAgeGate),
    admin: normalizeAdminWebEvidence(value.admin),
    adminApi: normalizeAdminApiEvidence(value.adminApi),
    error: normalizeProbeError(value.error),
  };
}

function normalizeWebPageEvidence(
  value: unknown,
  markerKey: "containsBrand" | "containsGenerator",
) {
  if (!isRecord(value)) return null;
  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    status: typeof value.status === "number" ? value.status : undefined,
    bytes: typeof value.bytes === "number" ? value.bytes : undefined,
    contentType:
      typeof value.contentType === "string" ? value.contentType : null,
    [markerKey]:
      typeof value[markerKey] === "boolean"
        ? value[markerKey]
        : undefined,
    nextErrorShell:
      typeof value.nextErrorShell === "boolean"
        ? value.nextErrorShell
        : undefined,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeWebApiAgeGateEvidence(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    status: typeof value.status === "number" ? value.status : undefined,
    code: typeof value.code === "string" ? value.code : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeAdminWebEvidence(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    status: typeof value.status === "number" ? value.status : undefined,
    bytes: typeof value.bytes === "number" ? value.bytes : undefined,
    contentType:
      typeof value.contentType === "string" ? value.contentType : null,
    protected:
      typeof value.protected === "boolean" ? value.protected : undefined,
    nextErrorShell:
      typeof value.nextErrorShell === "boolean"
        ? value.nextErrorShell
        : undefined,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeAdminApiEvidence(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    ok: typeof value.ok === "boolean" ? value.ok : false,
    status: typeof value.status === "number" ? value.status : undefined,
    code: typeof value.code === "string" ? value.code : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeProbeError(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

export function assessLaunchReadiness(
  options: LaunchReadinessOptions = {},
): LaunchReadinessReport {
  const env = options.env ?? process.env;
  const capabilities = mergeCapabilities(options.capabilities);
  const imagePipelineProbe =
    options.imagePipelineProbe !== undefined
      ? options.imagePipelineProbe
      : loadImagePipelineProbeEvidence(env);
  const blobStorageProbe =
    options.blobStorageProbe !== undefined
      ? options.blobStorageProbe
      : loadBlobStorageProbeEvidence(env);
  const safetyGatewayProbe =
    options.safetyGatewayProbe !== undefined
      ? options.safetyGatewayProbe
      : loadSafetyGatewayProbeEvidence(env);
  const chatServiceProbe =
    options.chatServiceProbe !== undefined
      ? options.chatServiceProbe
      : loadChatServiceProbeEvidence(env);
  const chatModelProbe =
    options.chatModelProbe !== undefined
      ? options.chatModelProbe
      : loadChatModelProbeEvidence(env);
  const voiceModelProbe =
    options.voiceModelProbe !== undefined
      ? options.voiceModelProbe
      : loadVoiceModelProbeEvidence(env);
  const paymentProviderProbe =
    options.paymentProviderProbe !== undefined
      ? options.paymentProviderProbe
      : loadPaymentProviderProbeEvidence(env);
  const ageVerificationProbe =
    options.ageVerificationProbe !== undefined
      ? options.ageVerificationProbe
      : loadAgeVerificationProbeEvidence(env);
  const productConfigProbe =
    options.productConfigProbe !== undefined
      ? options.productConfigProbe
      : loadProductConfigProbeEvidence(env);
  const webSurfaceProbe =
    options.webSurfaceProbe !== undefined
      ? options.webSurfaceProbe
      : loadWebSurfaceProbeEvidence(env);
  const now = options.now ?? new Date();
  const checks: LaunchReadinessCheck[] = [...(options.preflightChecks ?? [])];

  addCheck(checks, {
    id: "app-env-production",
    area: "Runtime",
    status: env.APP_ENV === "production" ? "pass" : "fail",
    message:
      env.APP_ENV === "production"
        ? "APP_ENV is production."
        : `APP_ENV is ${env.APP_ENV ?? "unset"}.`,
    remediation: "Run the launch gate with APP_ENV=production.",
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
    remediation: "Generate a unique production BETTER_AUTH_SECRET with at least 32 characters.",
  });

  addRequiredCheck(checks, env, {
    id: "internal-token",
    area: "Security",
    key: "INTERNAL_TOKEN",
    label: "Internal API token",
    minLength: 16,
    remediation: "Set INTERNAL_TOKEN to a production-only secret.",
  });
  addRequiredCheck(checks, env, {
    id: "cron-secret",
    area: "Security",
    key: "CRON_SECRET",
    label: "Cron secret",
    minLength: 16,
    remediation: "Set CRON_SECRET to a production-only secret distinct from INTERNAL_TOKEN.",
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
    remediation: "Use separate random secrets for INTERNAL_TOKEN and CRON_SECRET.",
  });
  addWebSurfaceProbeCheck(checks, env, webSurfaceProbe, now);

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
    status: isProductionBullmqPrefix(env.BULLMQ_PREFIX) ? "pass" : "fail",
    message: isProductionBullmqPrefix(env.BULLMQ_PREFIX)
      ? "BULLMQ_PREFIX is explicitly configured for production."
      : "BULLMQ_PREFIX is missing or still a service-local development default.",
    remediation:
      "Set one shared production BULLMQ_PREFIX, such as idream:prod, for main-web, chat, and gen workers.",
  });

  addProviderChecks(checks, env, capabilities);

  addRequiredCheck(checks, env, {
    id: "chat-service-url",
    area: "Chat",
    key: "CHAT_SERVICE_URL",
    label: "Chat service URL",
    url: true,
    remediation: "Deploy packages/chat and set CHAT_SERVICE_URL.",
  });
  addRequiredCheck(checks, env, {
    id: "chat-bff-signing-secret",
    area: "Chat",
    key: "CHAT_BFF_SIGNING_SECRET",
    label: "Chat BFF signing secret",
    minLength: 32,
    remediation: "Set CHAT_BFF_SIGNING_SECRET to the same shared secret used by packages/chat.",
  });
  addChatServiceChecks(checks, env);
  addChatServiceProbeCheck(checks, env, chatServiceProbe, now);
  addChatModelProbeCheck(checks, env, chatModelProbe, now);
  addChatModerationChecks(checks, env);

  addImagePipelineChecks(checks, env, capabilities, imagePipelineProbe, now);
  addProductConfigProbeCheck(checks, env, productConfigProbe, now);
  addVideoPipelineChecks(checks, env, capabilities, productConfigProbe);
  addVoiceModelProbeCheck(checks, env, voiceModelProbe, now);

  addRequiredCheck(checks, env, {
    id: "moderation-service-url",
    area: "Safety",
    key: "MODERATION_SERVICE_URL",
    label: "Moderation service URL",
    url: true,
    remediation: "Set MODERATION_SERVICE_URL to the production safety gateway.",
  });
  addRequiredCheck(checks, env, {
    id: "moderation-api-key",
    area: "Safety",
    key: "MODERATION_API_KEY",
    label: "Moderation API key",
    minLength: 16,
    remediation: "Set MODERATION_API_KEY to the production safety gateway token.",
  });
  addSafetyGatewayProbeCheck(checks, env, safetyGatewayProbe, now);
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
    remediation: "Configure and verify the production payment webhook secret.",
  });
  addPaymentProviderProbeCheck(checks, env, paymentProviderProbe, now);
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
    remediation: "Set AGE_VERIFY_WEBHOOK_SECRET and configure the gateway to sign callbacks.",
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
  addAgeVerificationProbeCheck(checks, env, ageVerificationProbe, now);

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
  addBlobStorageProbeCheck(checks, env, blobStorageProbe, now);

  addRequiredCheck(checks, env, {
    id: "sentry-dsn",
    area: "Observability",
    key: "SENTRY_DSN",
    label: "Sentry DSN",
    url: true,
    remediation: "Set SENTRY_DSN so production errors are captured.",
  });

  const summary = summarize(checks);
  return {
    ok: summary.fail === 0,
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
    "  --json                    Print the structured report as JSON.",
    "  -h, --help                Show this help.",
  ].join("\n");
}

function isCliEntrypoint() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isCliEntrypoint()) {
  try {
    const cliOptions = parseLaunchReadinessCliArgs(process.argv.slice(2));
    if (cliOptions.help) {
      process.stdout.write(`${formatLaunchReadinessHelp()}\n`);
      process.exitCode = 0;
    } else {
      const preflightChecks: LaunchReadinessCheck[] = [];
      let env: EnvLike = process.env;
      if (cliOptions.envFile) {
        const envFilePath = resolveWorkspacePath(cliOptions.envFile);
        if (existsSync(envFilePath)) {
          env = loadLaunchReadinessEnv(cliOptions.envFile);
        } else {
          preflightChecks.push({
            id: "launch-env-file",
            area: "Runtime",
            status: "fail",
            message: `Launch env file does not exist: ${envFilePath}.`,
            remediation:
              "Create a production launch env file from packages/main/.env.production.example, fill real secrets and provider credentials, then rerun check:launch.",
          });
        }
      }
      const report = assessLaunchReadiness({ env, preflightChecks });
      const output = cliOptions.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatLaunchReadinessReport(report)}\n`;

      process.stdout.write(output);
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Launch readiness failed before checks: ${message}\n`);
    process.exitCode = 2;
  }
}
