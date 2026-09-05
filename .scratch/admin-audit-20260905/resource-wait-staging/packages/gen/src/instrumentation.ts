import "dotenv/config";
import * as Sentry from "@sentry/node";
import { initializeSentry } from "@idream/shared/observability/sentry";
import { env } from "./env";

initializeSentry(Sentry, {
  appEnv: env.APP_ENV,
  dsn: env.SENTRY_DSN,
  release: env.SENTRY_RELEASE,
  service: "gen",
});

export function captureGenerationRuntimeFailure(input: {
  readonly boundary: "source-recovery" | "worker";
  readonly error: unknown;
  readonly jobId?: string | undefined;
  readonly mode: "image" | "video";
}) {
  return Sentry.captureException(input.error, {
    tags: {
      boundary: `${input.mode}-${input.boundary}`,
      ...(input.jobId ? { jobId: input.jobId } : {}),
    },
  });
}
