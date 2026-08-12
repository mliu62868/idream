import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/nextjs";
import {
  runSentryRuntimeCanary,
  runSentryRuntimeCanaryCli,
} from "@idream/shared/observability/sentry-canary";

export { runSentryRuntimeCanary as runSentryCanary };

if (
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void runSentryRuntimeCanaryCli({
    sdk: Sentry,
    service: "main",
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Sentry canary failed"}\n`,
    );
    process.exitCode = 1;
  });
}
