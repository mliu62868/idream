import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./CharacterVoicePanel.tsx", import.meta.url),
  "utf8",
);

describe("CharacterVoicePanel Fish Audio controls", () => {
  it("keeps voice identity separate from configurable performance direction", () => {
    expect(source).toContain("VoiceDeliveryEditor");
    expect(source).toContain("Character performance direction");
    expect(source).toContain("System performance direction");
    expect(source).toContain(
      'form.set("delivery", JSON.stringify(cloneDelivery))',
    );
    expect(source).toContain("defaultDraft.delivery");
  });

  it("makes Fish Audio the visible runtime and exposes every performance control", () => {
    expect(source).toContain('t("Fish Audio S2 Pro")');
    expect(source).toContain("MLX");
    expect(source).toContain("Attraction intensity");
    expect(source).toContain("Speaking pace");
    expect(source).toContain("Advanced Fish sampling");
    expect(source).toContain("repetitionPenalty");
    expect(source).not.toContain("Pocket TTS");
  });

  it("preserves candidate review before activation", () => {
    expect(source).toContain(
      "Creating a candidate never changes Character.voiceId",
    );
    expect(source).toContain("Activate reviewed voice");
    expect(source).toContain("expectedActiveProfileId");
    expect(source).toContain("expectedCurrentVoiceId");
    expect(source).toContain('data.voice.runtimeStatus === "ready"');
    expect(source).not.toContain("voice.preset === delivery.preset");
  });

  it("prioritizes the next operator action without hiding global configuration", () => {
    expect(source).toContain('data-testid="voice-control-room"');
    expect(source).toContain('data-testid="voice-candidate-primary-action"');
    expect(source).toContain('id="voice-candidate-builder"');
    expect(source).toContain('data-testid="live-voice-configuration"');
    expect(source).toContain('data-testid="system-voice-defaults"');
    expect(source).toContain("Candidate readiness");
  });
});
