import * as Sentry from "@sentry/nextjs";
import { initializeSentry } from "@idream/shared/observability/sentry";

initializeSentry(Sentry, {
  appEnv: process.env.NEXT_PUBLIC_APP_ENV,
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  service: "main",
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
