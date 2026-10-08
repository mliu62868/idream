import { describe, expect, it } from "vitest";
import { VOICE_INPUT_LANGUAGES, voiceInputCapabilitySchema } from "./voice-input";

const capability = {
  supported: true, available: true, ownerScope: "user:voice-input-test",
  languages: ["en"], maxDurationMs: 60_000, maxUploadBytes: 8_388_608,
  resultTtlMs: 120_000,
};

describe("English voice input product contract", () => {
  it("advertises only English", () => {
    expect(VOICE_INPUT_LANGUAGES).toEqual(["en"]);
    expect(voiceInputCapabilitySchema.parse(capability).languages).toEqual(["en"]);
  });

  it.each([[], ["fr"], ["en", "fr"], ["en", "en"]].map(languages => ({ languages })))(
    "rejects unsupported language declarations $languages", ({ languages }) => {
      expect(voiceInputCapabilitySchema.safeParse({ ...capability, languages }).success).toBe(false);
    },
  );
});
