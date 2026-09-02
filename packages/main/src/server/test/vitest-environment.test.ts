import { devNull } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Main Vitest provider isolation", () => {
  it("starts the actual test worker on mock without loading a local identity provider", async () => {
    expect(process.env.VOICE_PROVIDER).toBe("mock");
    expect(process.env.VOICE_IDENTITY_PROVIDER).toBeUndefined();
    expect(process.env.DOTENV_CONFIG_PATH).toBe(devNull);
    const { env } = await import("../lib/env");
    expect(env.VOICE_PROVIDER).toBe("mock");
    expect(env.VOICE_IDENTITY_PROVIDER).toBeUndefined();
  });

  it("configures the mocked Chat transport before modules capture the environment", async () => {
    const { env } = await import("../lib/env");
    expect(env.CHAT_SERVICE_URL).toBe("http://chat.test.invalid");
    expect(env.CHAT_BFF_SIGNING_SECRET).toBe("test-chat-bff-secret-0123456789abcdef");
    expect(env.INTERNAL_TOKEN).toBe("test-internal-token-0123456789");
  });

  it("clears an inherited identity route when resolving the test configuration", async () => {
    vi.stubEnv("VOICE_IDENTITY_PROVIDER", "fish-audio");
    vi.stubEnv("DOTENV_CONFIG_PATH", ".env");
    await import("../../../vitest.config");
    expect(process.env.VOICE_IDENTITY_PROVIDER).toBeUndefined();
    expect(process.env.DOTENV_CONFIG_PATH).toBe(devNull);
    const { env } = await import("../lib/env");
    expect(env.VOICE_IDENTITY_PROVIDER).toBeUndefined();
  });

  it("still lets provider tests explicitly select an identity route", async () => {
    vi.stubEnv("VOICE_IDENTITY_PROVIDER", "fish-audio");
    const { env } = await import("../lib/env");
    expect(env.VOICE_PROVIDER).toBe("mock");
    expect(env.VOICE_IDENTITY_PROVIDER).toBe("fish-audio");
  });
});
