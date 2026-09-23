import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodeVoiceClipMp3 } from "./transcode";

// One second of 24 kHz mono 16-bit silence, the shape both voice gateways emit.
function wavFixture(seconds = 1, rate = 24_000) {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buffer);
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("voice clip MP3 encoding", () => {
  it.skipIf(!hasFfmpeg)("re-encodes gateway WAV into a much smaller MP3", async () => {
    const wav = wavFixture(10);
    const mp3 = await encodeVoiceClipMp3(wav, { ffmpegBin: "ffmpeg" });
    expect(mp3).not.toBeNull();
    const head = Buffer.from(mp3!.subarray(0, 3));
    // ID3 tag or an MPEG frame sync.
    expect(head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)).toBe(true);
    expect(mp3!.byteLength).toBeLessThan(wav.byteLength / 3);
  });

  it("returns null instead of throwing when ffmpeg is unavailable", async () => {
    await expect(encodeVoiceClipMp3(wavFixture(), { ffmpegBin: "/nonexistent/ffmpeg" })).resolves.toBeNull();
  });

  it.skipIf(!hasFfmpeg)("returns null for input that is not audio", async () => {
    await expect(encodeVoiceClipMp3(new TextEncoder().encode("not audio"), { ffmpegBin: "ffmpeg" })).resolves.toBeNull();
  });
});
