import { afterEach, describe, expect, it } from "vitest";
import { voiceCallAvailability } from "./voice-call";

describe("voice call capability", () => {
  const originalProvider = process.env.CHAT_VOICE_CALL_PROVIDER;
  const originalTransport = process.env.CHAT_VOICE_CALL_TRANSPORT_URL;
  afterEach(() => {
    if (originalProvider === undefined) delete process.env.CHAT_VOICE_CALL_PROVIDER;
    else process.env.CHAT_VOICE_CALL_PROVIDER = originalProvider;
    if (originalTransport === undefined) delete process.env.CHAT_VOICE_CALL_TRANSPORT_URL;
    else process.env.CHAT_VOICE_CALL_TRANSPORT_URL = originalTransport;
  });
  it("fails closed when no provider or transport is configured", () => {
    delete process.env.CHAT_VOICE_CALL_PROVIDER;
    delete process.env.CHAT_VOICE_CALL_TRANSPORT_URL;
    expect(voiceCallAvailability()).toEqual({ status: "unavailable", reason: "provider_unconfigured" });
  });
  it("does not claim call availability from provider name alone", () => {
    process.env.CHAT_VOICE_CALL_PROVIDER = "self-hosted-stt-tts";
    delete process.env.CHAT_VOICE_CALL_TRANSPORT_URL;
    expect(voiceCallAvailability()).toEqual({ status: "unavailable", reason: "transport_unimplemented" });
  });
});
