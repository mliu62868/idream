import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./CharacterVoicePanel.tsx", import.meta.url),
  "utf8",
);

describe("CharacterVoicePanel Fish Audio controls", () => {
  it("keeps voice identity separate from configurable performance direction", () => {
    expect(source).toContain("VoiceDeliveryEditor");
    expect(source).toContain("Voice style and advanced settings");
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

  it("keeps one candidate task visible and moves secondary configuration into disclosures", () => {
    expect(source).toContain('data-testid="voice-control-room"');
    expect(source).toContain('data-testid="voice-candidate-primary-action"');
    expect(source).toContain('id="voice-candidate-builder"');
    expect(source).toContain('data-testid="live-voice-configuration"');
    expect(source).toContain('data-testid="system-voice-defaults"');
    expect(source).toContain("Current voice and runtime");
    expect(source).toContain("System voice defaults");
    expect(source).toContain('{t("Live voice")}');
    expect(source).toContain('aria-label={t("Active cloned voice preview")}');
    expect(source).toContain("previewCatalogVoice(data.voice.effectiveVoiceId");
    expect(source).not.toContain('{t("Next action")}');
  });

  it("uses a localized file picker instead of browser-native English copy", () => {
    expect(source).toContain('className="sr-only"');
    expect(source).toContain('htmlFor="character-voice-reference"');
    expect(source).toContain('t("Choose audio")');
    expect(source).toContain('file?.name ?? t("No audio selected")');
    expect(source).not.toContain("file:mr-3");
  });
});
