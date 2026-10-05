import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { videoFixture, narrationFixture } from "@/server/test/video-fixtures";
import { composeVideoScenes } from "./video-composition";

vi.mock("@/server/lib/env", () => ({ env: { VOICE_FFMPEG_BIN: "ffmpeg", VIDEO_FFPROBE_BIN: "ffprobe" } }));
let red: Uint8Array, blue: Uint8Array;
const run = promisify(execFile);
beforeAll(async () => { red = await videoFixture({ color: "red" }); blue = await videoFixture({ color: "blue" }); });

describe("real local video packaging", () => {
  it("concatenates actual decodable clips in the accepted dimensions with generated sound", async () => {
    const result = await composeVideoScenes({ scenes: [{ video: red }, { video: blue }], audio: "generated" });
    expect(result.media).toMatchObject({ width: 64, height: 96, framesPerSecond: 24, hasAudio: true, frameCount: 26 });
    expect(result.media.durationSeconds).toBeCloseTo(26 / 24, 1);
    expect(result.sceneDurations).toHaveLength(2);
  });

  it("removes the entire audio stream for silent output", async () => {
    const result = await composeVideoScenes({ scenes: [{ video: red }, { video: blue }], audio: "silent" });
    expect(result.media).toMatchObject({ hasAudio: false, frameCount: 26, width: 64, height: 96 });
  });

  it("keeps a complete longer narration by extending its last frame and pads a shorter line", async () => {
    const result = await composeVideoScenes({ scenes: [{ video: red, narration: await narrationFixture(1.4) }, { video: blue, narration: await narrationFixture(0.2) }], audio: "narration" });
    expect(result.sceneDurations[0]).toBeCloseTo(34 / 24, 3);
    expect(result.sceneDurations[1]).toBeGreaterThanOrEqual(13 / 24);
    expect(result.media).toMatchObject({ width: 64, height: 96, framesPerSecond: 24, hasAudio: true });
    expect(result.media.durationSeconds).toBeGreaterThanOrEqual(1.9);
    expect(result.media.frameCount).toBeGreaterThanOrEqual(47);
  });

  it("delivers all three ordered pictures and each complete narration, including their tails", async () => {
    const green = await videoFixture({ color: "lime" });
    const speechLengths = [1.4, 0.2, 1.1], frequencies = [550, 880, 1320];
    const scenes = await Promise.all([red, green, blue].map(async (video, index) => ({ video, narration: await narrationFixture(speechLengths[index]!, frequencies[index]!) })));
    const result = await composeVideoScenes({ scenes, audio: "narration" });
    const directory = await mkdtemp(join(tmpdir(), "idream-three-scene-check-"));
    try {
      const path = join(directory, "sequence.mp4");
      await writeFile(path, result.bytes);
      const frames = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
      const sound = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-map", "0:a:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
      const expectedFrames = result.sceneDurations.map(seconds => Math.round(seconds * 24));
      expect(result.media.frameCount).toBe(expectedFrames.reduce((a, b) => a + b, 0));
      expect(frames.stdout.length).toBe(result.media.frameCount! * 3);
      let firstFrame = 0, startSeconds = 0;
      for (let scene = 0; scene < 3; scene++) {
        for (const frame of [firstFrame, firstFrame + expectedFrames[scene]! - 1]) {
          const pixel = frames.stdout.subarray(frame * 3, frame * 3 + 3);
          expect(pixel[scene]).toBeGreaterThan(200);
          expect([...pixel].filter((_, channel) => channel !== scene).every(value => value < 35)).toBe(true);
        }
        // Distinct tones identify which complete source was delivered. Check
        // its final 80ms, where clipping or starting the next scene is visible.
        const end = Math.floor((startSeconds + speechLengths[scene]!) * 24000) - 120;
        const begin = end - 1920;
        let crossings = 0, energy = 0;
        for (let sample = begin; sample < end; sample++) {
          const current = sound.stdout.readInt16LE(sample * 2), next = sound.stdout.readInt16LE((sample + 1) * 2);
          if (current <= 0 && next > 0) crossings++;
          energy += current * current;
        }
        expect(crossings / (1920 / 24000)).toBeCloseTo(frequencies[scene]!, -1.5);
        expect(Math.sqrt(energy / 1920)).toBeGreaterThan(1500);
        firstFrame += expectedFrames[scene]!;
        startSeconds += result.sceneDurations[scene]!;
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses the actual picture timeline when narration replaces a longer native soundtrack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "idream-video-timeline-check-"));
    try {
      const source = join(directory, "source.mp4"), extended = join(directory, "long-native-sound.mp4");
      await writeFile(source, red);
      await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", "apad=whole_dur=2", "-c:a", "aac", extended]);
      const result = await composeVideoScenes({ scenes: [{ video: new Uint8Array(await readFile(extended)), narration: await narrationFixture(1.4) }, { video: blue, narration: await narrationFixture(0.2) }, { video: red, narration: await narrationFixture(1.1) }], audio: "narration" });
      expect(result.sceneDurations).toEqual([34 / 24, 13 / 24, 27 / 24]);
      expect(result.media.frameCount).toBe(34 + 13 + 27);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses decoded picture durations when silent packaging removes a longer native soundtrack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "idream-video-silent-timeline-check-"));
    try {
      const source = join(directory, "source.mp4"), extended = join(directory, "long-native-sound.mp4");
      await writeFile(source, red);
      await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", "apad=whole_dur=2", "-c:a", "aac", extended]);
      const result = await composeVideoScenes({ scenes: [{ video: new Uint8Array(await readFile(extended)) }, { video: blue }], audio: "silent" });
      expect(result.media).toMatchObject({ hasAudio: false, frameCount: 26 });
      expect(result.sceneDurations).toEqual([13 / 24, 13 / 24]);
      expect(result.media.durationSeconds).toBeCloseTo(26 / 24, 2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails closed on incompatible dimensions, missing sound, or an absent narration", async () => {
    await expect(composeVideoScenes({ scenes: [{ video: red }, { video: await videoFixture({ width: 96, height: 64 }) }], audio: "generated" })).rejects.toThrow("different dimensions");
    await expect(composeVideoScenes({ scenes: [{ video: await videoFixture({ audio: false }) }], audio: "generated" })).rejects.toThrow("soundtrack is missing");
    await expect(composeVideoScenes({ scenes: [{ video: red }], audio: "narration" })).rejects.toThrow("Narration bytes are missing");
    await expect(composeVideoScenes({ scenes: [{ video: await videoFixture({ fps: 30 }) }], audio: "silent" })).rejects.toThrow("24fps");
  });
});
