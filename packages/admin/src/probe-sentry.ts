import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { runSentryRuntimeCanaryCli } from "@idream/shared/observability/sentry-canary";

void runSentryRuntimeCanaryCli({ sdk: Sentry, service: "admin" }).catch(
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Sentry canary failed"}\n`,
    );
    process.exitCode = 1;
  },
);
