import "dotenv/config";
import * as Sentry from "@sentry/node";
import { initializeSentry } from "@idream/shared/observability/sentry";
import { env } from "./env";

initializeSentry(Sentry, {
  appEnv: env.APP_ENV,
  dsn: env.SENTRY_DSN,
  release: env.SENTRY_RELEASE,
  service: "chat",
});

export function captureChatRuntimeWarmupFailure(error: unknown) {
  return Sentry.captureException(error, {
    tags: { boundary: "runtime-warmup" },
  });
}
