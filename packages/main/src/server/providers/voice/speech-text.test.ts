import { describe, expect, it } from "vitest";
import { VOICE_MAX_INPUT_CHARS, voiceSpeechText, voiceSynthesisTimeoutMs } from "./speech-text";

describe("voiceSpeechText", () => {
  it("leaves narration out of what is spoken", () => {
    expect(voiceSpeechText("*smiles softly* Hello there. *leans in* Come closer.")).toBe("Hello there. Come closer.");
    expect(voiceSpeechText("I missed you *she whispers*, more than I said.")).toBe("I missed you, more than I said.");
  });
  it("keeps emphasised words and drops their markers", () => {
    expect(voiceSpeechText("I **really** mean it.")).toBe("I really mean it.");
  });
  it("still says something when a reply is only action", () => {
    expect(voiceSpeechText("*nods slowly*")).toBe("nods slowly");
  });
  it("removes an unmatched marker without losing the words after it", () => {
    expect(voiceSpeechText("Five * six is thirty.")).toBe("Five six is thirty.");
  });
  it("returns text with no marker exactly as given, so earlier requests keep their identity", () => {
    const reply = "  Two  spaces\n stay , untouched.  ";
    expect(voiceSpeechText(reply)).toBe(reply.trim());
  });
});

describe("voiceSynthesisTimeoutMs", () => {
  it("keeps the configured budget up to the previous limit, then grows with the text", () => {
    expect(voiceSynthesisTimeoutMs(240_000, 12)).toBe(240_000);
    expect(voiceSynthesisTimeoutMs(240_000, 2_000)).toBe(240_000);
    expect(voiceSynthesisTimeoutMs(240_000, 2_001)).toBe(480_000);
  });
  it("has an upper bound however long the text claims to be", () => {
    const bound = voiceSynthesisTimeoutMs(240_000, VOICE_MAX_INPUT_CHARS);
    expect(bound).toBe(1_440_000);
    expect(voiceSynthesisTimeoutMs(240_000, VOICE_MAX_INPUT_CHARS * 50)).toBe(bound);
  });
});
