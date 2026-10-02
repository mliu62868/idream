import { beforeAll, describe, expect, it, vi } from "vitest";
import { videoFixture, narrationFixture } from "@/server/test/video-fixtures";
import { composeVideoScenes } from "./video-composition";

vi.mock("@/server/lib/env", () => ({ env: { VOICE_FFMPEG_BIN: "ffmpeg", VIDEO_FFPROBE_BIN: "ffprobe" } }));
let red: Uint8Array, blue: Uint8Array;
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

  it("fails closed on incompatible dimensions, missing sound, or an absent narration", async () => {
    await expect(composeVideoScenes({ scenes: [{ video: red }, { video: await videoFixture({ width: 96, height: 64 }) }], audio: "generated" })).rejects.toThrow("different dimensions");
    await expect(composeVideoScenes({ scenes: [{ video: await videoFixture({ audio: false }) }], audio: "generated" })).rejects.toThrow("soundtrack is missing");
    await expect(composeVideoScenes({ scenes: [{ video: red }], audio: "narration" })).rejects.toThrow("Narration bytes are missing");
    await expect(composeVideoScenes({ scenes: [{ video: await videoFixture({ fps: 30 }) }], audio: "silent" })).rejects.toThrow("24fps");
  });
});
