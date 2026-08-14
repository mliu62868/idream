import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecoveryServiceEnvironment } from "./recovery-service-environment";

describe("recovery service environment", () => {
  it("does not inherit ambient product credentials or probe evidence into explicit service files", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "idream-service-env-"));
    try {
      const main = path.join(workspaceRoot, "main.env");
      const chat = path.join(workspaceRoot, "chat.env");
      const gen = path.join(workspaceRoot, "gen.env");
      writeFileSync(main, "APP_ENV=production\n");
      writeFileSync(chat, "CHAT_MODEL_PROVIDER=openai\n");
      writeFileSync(gen, "GEN_IMAGE_PROVIDER=pipeline\n");

      const env = loadRecoveryServiceEnvironment({
        workspaceRoot,
        launchEnvFile: main,
        chatEnvFile: chat,
        genEnvFile: gen,
        processEnv: {
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
          DATABASE_URL: "postgresql://ambient:secret@wrong.internal/idream",
          PAYMENT_PROVIDER_PROBE_REPORT: ".tmp/stale-payment-probe.json",
          CHAT_MODEL_API_KEY: "ambient-chat-key",
          PIPELINE_API_TOKEN: "ambient-gen-key",
          RECOVERY_DATABASE_URL:
            "postgresql://postgres:secret@db.internal/idream",
          IDREAM_QUIESCED: "1",
        },
        loadDefaultFiles: false,
      });

      expect(env).toMatchObject({
        APP_ENV: "production",
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
        RECOVERY_DATABASE_URL:
          "postgresql://postgres:secret@db.internal/idream",
        IDREAM_QUIESCED: "1",
      });
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.PAYMENT_PROVIDER_PROBE_REPORT).toBeUndefined();
      expect(env.CHAT_MODEL_API_KEY).toBe("");
      expect(env.IDREAM_GEN_PIPELINE_API_TOKEN).toBe("");
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("lets shell values override default package dotenv values like the service runtimes", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "idream-service-env-"));
    try {
      for (const packageName of ["main", "chat", "gen"]) {
        mkdirSync(path.join(workspaceRoot, "packages", packageName), {
          recursive: true,
        });
      }
      writeFileSync(
        path.join(workspaceRoot, "packages/main/.env"),
        "APP_ENV=development\nDATABASE_URL=postgresql://file@db.internal/idream\n",
      );
      writeFileSync(
        path.join(workspaceRoot, "packages/chat/.env"),
        "CHAT_MODEL_PROVIDER=mock\n",
      );
      writeFileSync(
        path.join(workspaceRoot, "packages/gen/.env"),
        "GEN_IMAGE_PROVIDER=mock\n",
      );

      const env = loadRecoveryServiceEnvironment({
        workspaceRoot,
        launchEnvFile: null,
        chatEnvFile: null,
        genEnvFile: null,
        processEnv: {
          NODE_ENV: "production",
          APP_ENV: "production",
          DATABASE_URL: "postgresql://shell@db.internal/idream",
          CHAT_MODEL_PROVIDER: "openai",
          GEN_IMAGE_PROVIDER: "pipeline",
        },
      });

      expect(env).toMatchObject({
        APP_ENV: "production",
        DATABASE_URL: "postgresql://shell@db.internal/idream",
        CHAT_MODEL_PROVIDER: "openai",
        GEN_IMAGE_PROVIDER: "pipeline",
      });
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("binds Main, Chat, and Gen authority files without treating Main as every runtime", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "idream-service-env-"));
    try {
      const main = path.join(workspaceRoot, "main.env");
      const admin = path.join(workspaceRoot, "admin.env");
      const chat = path.join(workspaceRoot, "chat.env");
      const gen = path.join(workspaceRoot, "gen.env");
      writeFileSync(main, [
        "APP_ENV=development",
        "INTERNAL_TOKEN=main-internal-token",
        "CHAT_BFF_SIGNING_SECRET=main-chat-bff-secret",
        "SENTRY_RELEASE=idream@main-revision",
        "DATABASE_URL=postgresql://main:pass@db.internal/idream",
        "REDIS_URL=redis://main-redis.internal:6379/3",
        "BULLMQ_PREFIX=idream:development",
        "CHAT_FS_ROOT=/wrong/main/chat",
        "BLOB_PROVIDER=s3",
        "BLOB_ENDPOINT=https://live.example.com",
        "BLOB_BUCKET=live",
        "PIPELINE_API_URL=https://main-chat.example.com/v1",
        "PIPELINE_API_TOKEN=main-pipeline-token",
        "COMFYUI_API_URL=https://wrong-main-comfy.example.com",
        "PIPELINE_IMAGE_MODEL_DEFAULT=wrong-main-image-model",
        "",
      ].join("\n"));
      writeFileSync(admin, [
        "APP_ENV=development",
        "INTERNAL_TOKEN=admin-internal-token",
        "ADMIN_BFF_SIGNING_SECRET=admin-bff-secret",
        "SENTRY_RELEASE=idream@admin-revision",
        "",
      ].join("\n"));
      writeFileSync(chat, [
        "APP_ENV=development",
        "INTERNAL_TOKEN=chat-internal-token",
        "BULLMQ_PREFIX=idream:chat",
        "CHAT_BFF_SIGNING_SECRET=chat-bff-secret",
        "SENTRY_RELEASE=idream@chat-revision",
        "CHAT_DATABASE_URL=postgresql://chat_service:pass@db.internal/idream",
        "CHAT_PROJECTOR_DATABASE_URL=postgresql://chat_projector:pass@db.internal/idream",
        "CHAT_FS_ROOT=/srv/chat/runtime",
        "CHAT_REDIS_URL=redis://chat-redis.internal:6379/5",
        "CHAT_MODEL_PROVIDER=openai",
        "CHAT_MODEL_BASE_URL=https://chat-model.example.com/v1",
        "CHAT_MODEL_NAME=chat-runtime-model",
        "CHAT_MODEL_API_KEY=chat-runtime-key",
        "CHAT_MODERATION_PROVIDER=safety-gateway",
        "CHAT_MODERATION_SERVICE_URL=https://chat-moderation.example.com",
        "CHAT_MODERATION_API_KEY=chat-moderation-key",
        "CHAT_MODERATION_TIMEOUT_MS=4321",
        "",
      ].join("\n"));
      writeFileSync(gen, [
        "APP_ENV=development",
        "INTERNAL_TOKEN=gen-internal-token",
        "SENTRY_RELEASE=idream@gen-revision",
        "GEN_REDIS_URL=redis://main-redis.internal:6379/3",
        "BULLMQ_PREFIX=idream:development",
        "BLOB_PROVIDER=s3",
        "BLOB_ENDPOINT=https://gen-live.example.com",
        "BLOB_BUCKET=gen-live",
        "GEN_IMAGE_PROVIDER=pipeline",
        "GEN_VIDEO_PROVIDER=backend",
        "PIPELINE_API_URL=https://gen-image.example.com/v1",
        "PIPELINE_API_TOKEN=gen-pipeline-token",
        "COMFYUI_API_URL=https://gen-comfy.example.com",
        "DRAWTHINGS_CLI=/opt/gen/draw-things-cli",
        "PIPELINE_IMAGE_MODEL_DEFAULT=gen-image-model",
        "",
      ].join("\n"));

      const env = loadRecoveryServiceEnvironment({
        workspaceRoot,
        launchEnvFile: main,
        adminEnvFile: admin,
        chatEnvFile: chat,
        genEnvFile: gen,
        processEnv: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
        loadDefaultFiles: false,
      });

      expect(env).toMatchObject({
        DATABASE_URL: "postgresql://main:pass@db.internal/idream",
        CHAT_DATABASE_URL:
          "postgresql://chat_service:pass@db.internal/idream",
        CHAT_PROJECTOR_DATABASE_URL:
          "postgresql://chat_projector:pass@db.internal/idream",
        CHAT_FS_ROOT: "/srv/chat/runtime",
        BLOB_ENDPOINT: "https://live.example.com",
        IDREAM_GEN_BLOB_ENDPOINT: "https://gen-live.example.com",
        IDREAM_GEN_BLOB_BUCKET: "gen-live",
        IDREAM_MAIN_REDIS_URL: "redis://main-redis.internal:6379/3",
        IDREAM_MAIN_BULLMQ_PREFIX: "idream:development",
        IDREAM_MAIN_SOURCE_REVISION: "idream@main-revision",
        IDREAM_ADMIN_APP_ENV: "development",
        IDREAM_ADMIN_INTERNAL_TOKEN: "admin-internal-token",
        IDREAM_ADMIN_BFF_SIGNING_SECRET: "admin-bff-secret",
        IDREAM_ADMIN_SOURCE_REVISION: "idream@admin-revision",
        IDREAM_CHAT_APP_ENV: "development",
        IDREAM_CHAT_BULLMQ_PREFIX: "idream:chat",
        IDREAM_CHAT_INTERNAL_TOKEN: "chat-internal-token",
        IDREAM_CHAT_BFF_SIGNING_SECRET: "chat-bff-secret",
        IDREAM_CHAT_SOURCE_REVISION: "idream@chat-revision",
        IDREAM_GEN_APP_ENV: "development",
        IDREAM_GEN_INTERNAL_TOKEN: "gen-internal-token",
        IDREAM_GEN_SOURCE_REVISION: "idream@gen-revision",
        IDREAM_GEN_REDIS_URL: "redis://main-redis.internal:6379/3",
        IDREAM_GEN_BULLMQ_PREFIX: "idream:development",
        CHAT_REDIS_URL: "redis://chat-redis.internal:6379/5",
        CHAT_MODEL_PROVIDER: "openai",
        CHAT_MODEL_BASE_URL: "https://chat-model.example.com/v1",
        CHAT_MODEL_NAME: "chat-runtime-model",
        CHAT_MODEL_API_KEY: "chat-runtime-key",
        CHAT_MODERATION_PROVIDER: "safety-gateway",
        CHAT_MODERATION_SERVICE_URL: "https://chat-moderation.example.com",
        CHAT_MODERATION_API_KEY: "chat-moderation-key",
        CHAT_MODERATION_TIMEOUT_MS: "4321",
        GEN_IMAGE_PROVIDER: "pipeline",
        GEN_VIDEO_PROVIDER: "backend",
        PIPELINE_API_URL: "https://main-chat.example.com/v1",
        PIPELINE_API_TOKEN: "main-pipeline-token",
        IDREAM_GEN_PIPELINE_API_URL: "https://gen-image.example.com/v1",
        IDREAM_GEN_PIPELINE_API_TOKEN: "gen-pipeline-token",
        IDREAM_GEN_COMFYUI_API_URL: "https://gen-comfy.example.com",
        IDREAM_GEN_DRAWTHINGS_CLI: "/opt/gen/draw-things-cli",
        IDREAM_GEN_PIPELINE_IMAGE_MODEL_DEFAULT: "gen-image-model",
      });
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("keeps service queue defaults independent from the recovery process APP_ENV override", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "idream-service-env-"));
    try {
      const main = path.join(workspaceRoot, "main.env");
      const gen = path.join(workspaceRoot, "gen.env");
      writeFileSync(main, [
        "APP_ENV=development",
        "DATABASE_URL=postgresql://main:main-pass@db.internal/idream",
        "REDIS_URL=redis://redis.internal:6379/4",
        "",
      ].join("\n"));
      writeFileSync(gen, [
        "APP_ENV=development",
        "GEN_REDIS_URL=redis://redis.internal:6379/4",
        "",
      ].join("\n"));

      const env = loadRecoveryServiceEnvironment({
        workspaceRoot,
        launchEnvFile: main,
        chatEnvFile: null,
        genEnvFile: gen,
        processEnv: {
          NODE_ENV: "test",
          APP_ENV: "production",
          IDREAM_QUIESCED: "1",
          RECOVERY_DATABASE_URL:
            "postgresql://postgres:super-pass@db.internal/idream",
        },
        loadDefaultFiles: false,
      });

      expect(env).toMatchObject({
        APP_ENV: "development",
        DATABASE_URL: "postgresql://main:main-pass@db.internal/idream",
        RECOVERY_DATABASE_URL:
          "postgresql://postgres:super-pass@db.internal/idream",
        IDREAM_MAIN_REDIS_URL: "redis://redis.internal:6379/4",
        IDREAM_MAIN_BULLMQ_PREFIX: "idream:development",
        IDREAM_GEN_REDIS_URL: "redis://redis.internal:6379/4",
        IDREAM_GEN_BULLMQ_PREFIX: "idream:development",
        IDREAM_RECOVERY_APP_ENV: "production",
        IDREAM_QUIESCED: "1",
      });
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("resolves a relative Chat root against the Chat runtime working directory", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "idream-service-env-"));
    try {
      const chat = path.join(workspaceRoot, "chat.env");
      writeFileSync(chat, "CHAT_FS_ROOT=./data/chat\n");
      const env = loadRecoveryServiceEnvironment({
        workspaceRoot,
        launchEnvFile: null,
        chatEnvFile: chat,
        genEnvFile: null,
        processEnv: { NODE_ENV: "test" },
        loadDefaultFiles: false,
      });
      expect(env.CHAT_FS_ROOT).toBe(
        path.join(workspaceRoot, "packages/chat/data/chat"),
      );
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("reports the same effective Chat model defaults as the Chat runtime", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "idream-service-env-"));
    try {
      const chat = path.join(workspaceRoot, "chat.env");
      writeFileSync(chat, "CHAT_MODEL_PROVIDER=openai\n");
      const env = loadRecoveryServiceEnvironment({
        workspaceRoot,
        launchEnvFile: null,
        chatEnvFile: chat,
        genEnvFile: null,
        processEnv: { NODE_ENV: "test" },
        loadDefaultFiles: false,
      });

      expect(env).toMatchObject({
        CHAT_MODEL_PROVIDER: "openai",
        CHAT_MODEL_BASE_URL: "http://127.0.0.1:8061/v1",
        CHAT_MODEL_NAME:
          "Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit",
        CHAT_MODEL_API_KEY: "",
      });
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });
});
