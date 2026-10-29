import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/server/providers", () => ({ providers: { blob: {} } }));
vi.mock("@/server/lib/env", () => ({ env: { VIDEO_FFPROBE_BIN: "ffprobe", VOICE_FFMPEG_BIN: "ffmpeg" } }));
import { inspectLibraryMedia } from "./media-bytes";

describe("chat library observation bytes", () => {
  it("hashes original bytes while decoding and producing a separate observation thumbnail", async () => {
    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#b80f21" } }).png().toBuffer();
    const inspected = await inspectLibraryMedia(png, "image");
    expect(inspected).toMatchObject({ kind: "image", contentType: "image/png", width: 96, height: 64,
      durationSeconds: null, hasAudio: null, contentHash: createHash("sha256").update(png).digest("hex") });
    expect(inspected.bytes).toEqual(png);
    expect((await sharp(inspected.thumbnail).metadata()).format).toBe("jpeg");
    await expect(inspectLibraryMedia(png.subarray(0, 40), "image")).rejects.toThrow(/fully decoded/);
  });

  it("observes time-ordered video frames after full decode, including the ending", async () => {
    const bytes = await readFile(new URL("../../../e2e/fixtures/collection-playback.mp4", import.meta.url));
    const inspected = await inspectLibraryMedia(bytes, "video");
    expect(inspected).toMatchObject({ kind: "video", contentType: "video/mp4", durationSeconds: 3, hasAudio: false });
    expect(inspected.frames).toHaveLength(6);
    expect(inspected.frames[0]?.atSeconds).toBe(0);
    expect(inspected.frames.at(-1)?.atSeconds).toBeGreaterThan(2.9);
    expect(inspected.frames.every((frame, index, frames) => index === 0 || frame.atSeconds! > frames[index - 1]!.atSeconds!)).toBe(true);
    await expect(inspectLibraryMedia(bytes.subarray(0, 512), "video")).rejects.toThrow(/fully decoded/);
  }, 30_000);
});
