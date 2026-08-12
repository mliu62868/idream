import * as Sentry from "@sentry/nextjs";
import { initializeSentry } from "@idream/shared/observability/sentry";

initializeSentry(Sentry, {
  appEnv: process.env.APP_ENV,
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  service: "admin",
});
