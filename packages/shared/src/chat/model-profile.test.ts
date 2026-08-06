import { describe, expect, it } from "vitest";
import {
  resolveChatMemoryExtractProfile,
  resolveChatModelProfile,
} from "./model-profile.js";

describe("chat model profile", () => {
  it("resolves provider, tier model and all timeout budgets once", () => {
    const profile = resolveChatModelProfile({
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_NAME: "base",
      CHAT_MODEL_DELUXE: "deluxe",
      CHAT_MODEL_TIMEOUT_MS: "41000",
      CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS: "52000",
      CHAT_MODEL_IDLE_TIMEOUT_MS: "9000",
      CHAT_MODEL_COMPLETE_TIMEOUT_MS: "17000",
    }, "deluxe");

    expect(profile).toMatchObject({
      provider: "openai",
      model: "deluxe",
      firstTokenTimeoutMs: 52_000,
      idleTimeoutMs: 9_000,
      completionTimeoutMs: 17_000,
      supportsTools: true,
    });
  });

  it("derives the extraction profile from the same chat endpoint", () => {
    expect(resolveChatMemoryExtractProfile({
      CHAT_MODEL_BASE_URL: "http://model.test/v1",
      CHAT_MODEL_API_KEY: "key",
    })).toMatchObject({
      baseUrl: "http://model.test/v1",
      apiKey: "key",
    });
  });
});
