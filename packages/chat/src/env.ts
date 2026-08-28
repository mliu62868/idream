// SPEC: local AgentRun runtime config. Fail fast on missing required secrets.
// INTENT: One typed accessor; no scattered process.env reads. All config comes
// from packages/chat/.env (see .env.example) — loaded here, non-overriding so
// vitest/pm2-injected vars still win.
// NOTE: cwd-based. Works under `next dev` and a FULL `pm2 start ecosystem.config.js`
// (pm2 sets cwd=packages/chat). `pm2 start --only chat` does NOT apply the per-app
// cwd, so start chat via the full ecosystem (or `bun run pm2:start`), not `--only`.
import "dotenv/config";
import {
  DEFAULT_REDIS_URL,
  mainWebUrlOrigin,
} from "@idream/shared/env";
import { resolveChatFsRoot, resolveChatModelProfile } from "@idream/shared";
import { resolveCompanionRuntimeConfig } from "./companion-runtime-selection.js";

export const env = {
  get APP_ENV() {
    return process.env.APP_ENV;
  },
  get SENTRY_DSN() {
    return process.env.SENTRY_DSN;
  },
  get SENTRY_RELEASE() {
    return process.env.SENTRY_RELEASE;
  },
  get SOURCE_REVISION() {
    return process.env.IDREAM_SOURCE_REVISION ?? process.env.SENTRY_RELEASE;
  },
  get REDIS_URL() {
    return process.env.CHAT_REDIS_URL ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  },
  get CHAT_FS_ROOT() {
    return resolveChatFsRoot(
      process.env.CHAT_FS_ROOT ?? "./data/chat",
      process.cwd(),
    );
  },
  get CHAT_MODEL_PROVIDER() {
    return resolveChatModelProfile(process.env).provider;
  },
  // Admin health labels and probes must resolve the same DSH provider profile
  // that readiness pins; Chat never executes the model through these getters.
  get CHAT_MODEL_BASE_URL() {
    return resolveChatModelProfile(process.env).baseUrl;
  },
  get CHAT_MODEL_NAME() {
    return resolveChatModelProfile(process.env).model;
  },
  // Keep the admin probe bounded below the DSH turn deadline.
  get CHAT_MODEL_TIMEOUT_MS() {
    return resolveChatModelProfile(process.env).idleTimeoutMs;
  },
  get CHAT_MODEL_API_KEY() {
    return resolveChatModelProfile(process.env).apiKey;
  },
  get BFF_SIGNING_SECRET() {
    return process.env.CHAT_BFF_SIGNING_SECRET ?? "";
  },
  // Shared secret for Main → Chat AgentRun admission and cancellation.
  // Empty ⇒ internal endpoints reject all callers (safe default).
  get INTERNAL_TOKEN() {
    return process.env.INTERNAL_TOKEN ?? "";
  },
  get MAIN_INTERNAL_BASE_URL() {
    return mainWebUrlOrigin().replace(/\/$/u, "");
  },
  get PORT() {
    return Number.parseInt(process.env.CHAT_PORT ?? "3100", 10);
  },
  // Read as one validated snapshot before each attempt is recorded.
  get COMPANION_RUNTIME_CONFIG() {
    return resolveCompanionRuntimeConfig(process.env);
  },
} as const;
