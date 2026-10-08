import { describe, expect, it } from "vitest";
import { REDGRAFT_VIDEO_DEFAULTS, redgraftVideoEnvelope, videoSequenceRequestSchema } from "./video-sequence";

describe("bounded RedGraft sequence contract", () => {
  it("resolves every allowed duration, ratio and resolution to physical dimensions and frame counts", () => {
    for (const seconds of [3, 5]) for (const orientation of ["7:12", "2:3", "1:1"]) for (const quality of ["preview", "standard"]) {
      const result = redgraftVideoEnvelope({ seconds, orientation, quality });
      expect(result.width).toBe(orientation === "7:12" ? (quality === "preview" ? 448 : 896) : (quality === "preview" ? 512 : 768));
      expect(result.height).toBe(orientation === "7:12" ? result.width * 12 / 7 : orientation === "1:1" ? result.width : result.width * 1.5);
      expect(result.width % 64).toBe(0);
      expect(result.height % 64).toBe(0);
      expect(result.frameCount).toBe(seconds * 24 + 1);
      expect(result.expectedDurationSeconds).toBe(result.frameCount / 24);
    }
    expect(() => redgraftVideoEnvelope({ seconds: 10, orientation: "1:1", quality: "standard" })).toThrow();
  });
  it("defaults new scene requests to the exact 448x768 portrait without rejecting historical ratios", () => {
    const request = videoSequenceRequestSchema.parse({ characterId: "c", scenes: [{ prompt: "A calm wave" }] });
    expect(request).toMatchObject(REDGRAFT_VIDEO_DEFAULTS);
    expect(redgraftVideoEnvelope({ seconds: 5, orientation: request.orientation, quality: request.quality })).toMatchObject({ width: 448, height: 768, frameCount: 121 });
    expect(videoSequenceRequestSchema.parse({ ...request, orientation: "2:3", quality: "standard" })).toMatchObject({ orientation: "2:3", quality: "standard" });
  });
  it("rejects empty or excessive scenes, missing narration, and an unqualified script", () => {
    const scene = { prompt: "A calm wave", seconds: 3 };
    expect(videoSequenceRequestSchema.safeParse({ characterId: "c", scenes: [] }).success).toBe(false);
    expect(videoSequenceRequestSchema.safeParse({ characterId: "c", scenes: Array(4).fill(scene) }).success).toBe(false);
    expect(videoSequenceRequestSchema.safeParse({ characterId: "c", scenes: [scene], audio: "narration" }).success).toBe(false);
    expect(videoSequenceRequestSchema.safeParse({ characterId: "c", scenes: [{ ...scene, narration: "你好" }], audio: "narration" }).success).toBe(false);
    expect(videoSequenceRequestSchema.parse({ characterId: "c", scenes: [{ ...scene, narration: "Hello, let's begin." }], audio: "narration" }).scenes[0]?.narration).toBe("Hello, let's begin.");
  });
});
