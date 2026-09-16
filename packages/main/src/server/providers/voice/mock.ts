import { type VoiceClipPort } from "../types";

// SPEC: Deterministic stand-in for a real TTS gateway. It returns genuinely
//       playable bytes rather than a placeholder, so on-demand playback works
//       end-to-end in dev/mock once the caller stores them.
// INTENT: a short silent WAV is trivial to synthesize and every browser decodes it.
export class MockVoiceModel implements VoiceClipPort {
  readonly providerKey = "mock" as const;

  async synthesize(input: Parameters<VoiceClipPort["synthesize"]>[0]) {
    const durationMs = Math.max(500, input.text.length * 35);
    return {
      ok: true as const,
      data: {
        body: silentWavBytes(durationMs),
        contentType: "audio/wav",
        durationMs,
        sceneApplied: true,
        sceneAdapter: "mock-scene-1",
      },
    };
  }
}

// Minimal PCM-16 mono WAV of silence, capped at 2s so the placeholder stays small.
function silentWavBytes(durationMs: number): Uint8Array {
  const sampleRate = 8_000;
  const samples = Math.max(1, Math.floor((sampleRate * Math.min(durationMs, 2_000)) / 1_000));
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  // Sample region is left zeroed → silence.
  return new Uint8Array(buffer);
}
