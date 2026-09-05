import { describe, expect, it, vi } from "vitest";
import { initializeSentry, sentryRuntimeOptions } from "./sentry";

describe("Sentry runtime initialization", () => {
  it("initializes only for production with a DSN and tags the owning service", () => {
    expect(
      sentryRuntimeOptions({ appEnv: "development", dsn: "https://public@sentry.invalid/1", service: "chat" }),
    ).toBeNull();
    expect(
      sentryRuntimeOptions({ appEnv: "production", dsn: "", service: "chat" }),
    ).toBeNull();

    expect(
      sentryRuntimeOptions({
        appEnv: "production",
        dsn: "https://public@sentry.invalid/1",
        release: "idream@abc123",
        service: "chat",
      }),
    ).toEqual({
      dsn: "https://public@sentry.invalid/1",
      enabled: true,
      environment: "production",
      initialScope: { tags: { service: "chat" } },
      release: "idream@abc123",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });

  it("fails closed without exposing the DSN through an initialization error", () => {
    const init = vi.fn(() => {
      throw new Error("sdk rejected https://secret@sentry.invalid/1");
    });

    expect(
      initializeSentry(
        { init },
        {
          appEnv: "production",
          dsn: "https://secret@sentry.invalid/1",
          service: "gen",
        },
      ),
    ).toBe(false);
    expect(init).toHaveBeenCalledOnce();
  });
});
