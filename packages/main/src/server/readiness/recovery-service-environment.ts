import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { resolveChatFsRoot, resolveChatModelProfile } from "@idream/shared";
import {
  DEFAULT_APP_ENV,
  DEFAULT_REDIS_URL,
  defaultBullmqPrefix,
} from "@idream/shared/env";
import type { RecoveryEnvironment } from "./recovery-rehearsal-producer";

const isolatedRuntimeKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "CI",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

// INTENT: these are recovery-command inputs, not service configuration. They
// remain explicit shell authority even when the three service env snapshots
// are isolated from ambient product credentials and old probe evidence.
const recoveryProcessKeys = [
  "IDREAM_QUIESCED",
  "RECOVERY_DATABASE_URL",
  "RECOVERY_BLOB_ENDPOINT",
  "RECOVERY_BLOB_BUCKET",
  "RECOVERY_BLOB_REGION",
  "RECOVERY_BLOB_ACCESS_KEY_ID",
  "RECOVERY_BLOB_SECRET_ACCESS_KEY",
  "RECOVERY_BLOB_RETENTION_DAYS",
  "PGHOSTADDR",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGDATABASE",
  "PGUSER",
  "PGOPTIONS",
] as const;

function readEnvironmentFile(
  workspaceRoot: string,
  filePath: string,
  required: boolean,
) {
  const resolved = path.resolve(workspaceRoot, filePath);
  if (!existsSync(resolved)) {
    if (required) throw new Error(`Environment file does not exist: ${resolved}`);
    return {};
  }
  return parseDotenv(readFileSync(resolved));
}

function selectedProcessEnvironment(
  processEnv: NodeJS.ProcessEnv,
  keys: readonly string[],
) {
  const selected: Record<string, string | undefined> = {};
  for (const key of keys) {
    if (processEnv[key] !== undefined) selected[key] = processEnv[key];
  }
  return selected;
}

function loadServiceEnvironment(input: {
  readonly workspaceRoot: string;
  readonly defaultFile: string;
  readonly explicitFile: string | null;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly loadDefaultFiles: boolean;
}) {
  if (input.explicitFile) {
    return {
      ...selectedProcessEnvironment(input.processEnv, isolatedRuntimeKeys),
      ...readEnvironmentFile(
        input.workspaceRoot,
        input.explicitFile,
        true,
      ),
    };
  }
  if (!input.loadDefaultFiles) return { ...input.processEnv };
  return {
    ...readEnvironmentFile(
      input.workspaceRoot,
      input.defaultFile,
      false,
    ),
    // INVARIANT: dotenv never replaces a value already supplied by the
    // process. Gate and service startup must therefore share shell precedence.
    ...input.processEnv,
  };
}

// SPEC: recovery and launch inspect each runtime's own dotenv authority.
// Main never gets to invent Chat FS or Gen Blob identity on their behalf.
export function loadRecoveryServiceEnvironment(input: {
  readonly workspaceRoot: string;
  readonly launchEnvFile: string | null;
  readonly adminEnvFile?: string | null;
  readonly chatEnvFile: string | null;
  readonly genEnvFile: string | null;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly loadDefaultFiles?: boolean;
}): RecoveryEnvironment {
  const defaults = input.loadDefaultFiles !== false;
  const main = loadServiceEnvironment({
    workspaceRoot: input.workspaceRoot,
    defaultFile: "packages/main/.env",
    explicitFile: input.launchEnvFile,
    processEnv: input.processEnv,
    loadDefaultFiles: defaults,
  });
  const admin = input.adminEnvFile === undefined
    ? null
    : loadServiceEnvironment({
        workspaceRoot: input.workspaceRoot,
        defaultFile: "packages/admin/.env",
        explicitFile: input.adminEnvFile,
        processEnv: input.processEnv,
        loadDefaultFiles: defaults,
      });
  const chat = loadServiceEnvironment({
    workspaceRoot: input.workspaceRoot,
    defaultFile: "packages/chat/.env",
    explicitFile: input.chatEnvFile,
    processEnv: input.processEnv,
    loadDefaultFiles: defaults,
  });
  const chatModel = resolveChatModelProfile(chat);
  const gen = loadServiceEnvironment({
    workspaceRoot: input.workspaceRoot,
    defaultFile: "packages/gen/.env",
    explicitFile: input.genEnvFile,
    processEnv: input.processEnv,
    loadDefaultFiles: defaults,
  });
  const chatRoot = chat.CHAT_FS_ROOT?.trim();
  const mainAppEnv = main.APP_ENV ?? DEFAULT_APP_ENV;
  const adminAppEnv = admin?.APP_ENV ?? DEFAULT_APP_ENV;
  const chatAppEnv = chat.APP_ENV ?? DEFAULT_APP_ENV;
  const genAppEnv = gen.APP_ENV ?? DEFAULT_APP_ENV;
  const mainSourceRevision =
    main.IDREAM_SOURCE_REVISION ?? main.SENTRY_RELEASE;
  const adminSourceRevision =
    admin?.IDREAM_SOURCE_REVISION ?? admin?.SENTRY_RELEASE;
  const chatSourceRevision =
    chat.IDREAM_SOURCE_REVISION ?? chat.SENTRY_RELEASE;
  const genSourceRevision = gen.IDREAM_SOURCE_REVISION ?? gen.SENTRY_RELEASE;
  return {
    ...main,
    ...selectedProcessEnvironment(input.processEnv, recoveryProcessKeys),
    // The recovery process may be fenced as production while the service
    // authorities it inspects intentionally use another explicit namespace.
    IDREAM_RECOVERY_APP_ENV: input.processEnv.APP_ENV,
    ...(admin
      ? {
          IDREAM_ADMIN_APP_ENV: adminAppEnv,
          IDREAM_ADMIN_INTERNAL_TOKEN: admin.INTERNAL_TOKEN,
          IDREAM_ADMIN_BFF_SIGNING_SECRET:
            admin.ADMIN_BFF_SIGNING_SECRET,
          IDREAM_ADMIN_SOURCE_REVISION: adminSourceRevision,
        }
      : {}),
    CHAT_DATABASE_URL: chat.CHAT_DATABASE_URL,
    CHAT_PROJECTOR_DATABASE_URL: chat.CHAT_PROJECTOR_DATABASE_URL,
    CHAT_REDIS_URL:
      chat.CHAT_REDIS_URL ?? chat.REDIS_URL ?? DEFAULT_REDIS_URL,
    IDREAM_CHAT_APP_ENV: chatAppEnv,
    IDREAM_CHAT_BULLMQ_PREFIX:
      chat.BULLMQ_PREFIX ?? defaultBullmqPrefix(chatAppEnv),
    IDREAM_CHAT_INTERNAL_TOKEN: chat.INTERNAL_TOKEN,
    IDREAM_CHAT_BFF_SIGNING_SECRET: chat.CHAT_BFF_SIGNING_SECRET,
    IDREAM_CHAT_SOURCE_REVISION: chatSourceRevision,
    CHAT_MODEL_PROVIDER: chatModel.provider,
    CHAT_MODEL_BASE_URL: chatModel.baseUrl,
    CHAT_MODEL_NAME: chatModel.model,
    CHAT_MODEL_API_KEY: chatModel.apiKey,
    CHAT_MODERATION_PROVIDER:
      chat.CHAT_MODERATION_PROVIDER ?? chat.MODERATION_PROVIDER ?? "mock",
    CHAT_MODERATION_SERVICE_URL:
      chat.CHAT_MODERATION_SERVICE_URL ?? chat.MODERATION_SERVICE_URL,
    CHAT_MODERATION_API_KEY:
      chat.CHAT_MODERATION_API_KEY ?? chat.MODERATION_API_KEY,
    CHAT_MODERATION_TIMEOUT_MS:
      chat.CHAT_MODERATION_TIMEOUT_MS ?? chat.MODERATION_TIMEOUT_MS,
    CHAT_FS_ROOT: chatRoot
      ? resolveChatFsRoot(
          chatRoot,
          path.join(input.workspaceRoot, "packages/chat"),
        )
      : undefined,
    GEN_BLOB_PROVIDER: gen.GEN_BLOB_PROVIDER ?? gen.BLOB_PROVIDER,
    IDREAM_GEN_BLOB_ENDPOINT: gen.BLOB_ENDPOINT,
    IDREAM_GEN_BLOB_BUCKET: gen.BLOB_BUCKET,
    IDREAM_GEN_BLOB_ROOT: gen.BLOB_ROOT,
    IDREAM_MAIN_REDIS_URL: main.REDIS_URL ?? DEFAULT_REDIS_URL,
    IDREAM_MAIN_BULLMQ_PREFIX:
      main.BULLMQ_PREFIX ?? defaultBullmqPrefix(mainAppEnv),
    IDREAM_MAIN_SOURCE_REVISION: mainSourceRevision,
    IDREAM_GEN_REDIS_URL:
      gen.GEN_REDIS_URL ?? gen.REDIS_URL ?? DEFAULT_REDIS_URL,
    IDREAM_GEN_APP_ENV: genAppEnv,
    IDREAM_GEN_INTERNAL_TOKEN: gen.INTERNAL_TOKEN,
    IDREAM_GEN_SOURCE_REVISION: genSourceRevision,
    IDREAM_GEN_BULLMQ_PREFIX:
      gen.BULLMQ_PREFIX ?? defaultBullmqPrefix(genAppEnv),
    GEN_IMAGE_PROVIDER: gen.GEN_IMAGE_PROVIDER ?? "mock",
    GEN_VIDEO_PROVIDER: gen.GEN_VIDEO_PROVIDER ?? "mock",
    // Main and Gen intentionally share legacy variable names in their own
    // processes. Sanitized aliases preserve both authorities in one launch
    // inspection without allowing Gen to replace Main's chat pipeline config.
    IDREAM_GEN_PIPELINE_API_URL: gen.PIPELINE_API_URL ?? "",
    IDREAM_GEN_PIPELINE_API_TOKEN: gen.PIPELINE_API_TOKEN ?? "",
    IDREAM_GEN_COMFYUI_API_URL: gen.COMFYUI_API_URL ?? "",
    IDREAM_GEN_DRAWTHINGS_CLI: gen.DRAWTHINGS_CLI ?? "",
    IDREAM_GEN_PIPELINE_IMAGE_MODEL_DEFAULT:
      gen.PIPELINE_IMAGE_MODEL_DEFAULT ?? "",
    // Ownership's existing executable consumes these canonical Gen names.
    GEN_REDIS_URL: gen.GEN_REDIS_URL ?? gen.REDIS_URL ?? DEFAULT_REDIS_URL,
  };
}
