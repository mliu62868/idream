export type SentryService = "main" | "admin" | "chat" | "gen";

export interface SentryRuntimeInput {
  readonly appEnv: string | undefined;
  readonly dsn: string | undefined;
  readonly release?: string | undefined;
  readonly service: SentryService;
}

export interface SentryRuntimeOptions {
  readonly dsn: string;
  readonly enabled: true;
  readonly environment: "production";
  readonly initialScope: {
    readonly tags: {
      readonly service: SentryService;
    };
  };
  readonly release?: string;
  readonly sendDefaultPii: false;
  readonly tracesSampleRate: 0;
}

export interface SentrySdk {
  init(options: SentryRuntimeOptions): void;
}

// SPEC: every runtime uses the same fail-closed activation rule. A production
// build alone is not authority to emit telemetry; APP_ENV and a DSN must both
// opt the deployed process in.
export function sentryRuntimeOptions(
  input: SentryRuntimeInput,
): SentryRuntimeOptions | null {
  const dsn = input.dsn?.trim();
  if (input.appEnv !== "production" || !dsn) return null;

  return {
    dsn,
    enabled: true,
    environment: "production",
    initialScope: { tags: { service: input.service } },
    ...(input.release?.trim() ? { release: input.release.trim() } : {}),
    sendDefaultPii: false,
    tracesSampleRate: 0,
  };
}

// INTENT: SDK initialization must never print the DSN when a malformed runtime
// configuration is rejected. Readiness and the canary report expose status;
// this boundary only returns whether initialization succeeded.
export function initializeSentry(
  sdk: SentrySdk,
  input: SentryRuntimeInput,
): boolean {
  const options = sentryRuntimeOptions(input);
  if (!options) return false;
  try {
    sdk.init(options);
    return true;
  } catch {
    return false;
  }
}
