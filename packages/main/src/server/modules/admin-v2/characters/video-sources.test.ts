import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCharacterVideoSourceForm } from "./video-sources";

function uploadRequest(file: File, purpose = "character_video_library") {
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("video", file, file.name);
  return new Request("http://localhost/api/v2/admin/characters/character-1/video-sources", {
    method: "POST",
    body: form,
  });
}

describe("Character video library upload form", () => {
  let validVideo: Uint8Array<ArrayBuffer>;
  beforeAll(() => {
    validVideo = new Uint8Array(execFileSync("ffmpeg", [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x96:rate=10",
      "-t", "0.5", "-c:v", "libvpx-vp9", "-f", "webm", "pipe:1",
    ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }));
  });

  it("accepts a completely decoded video and records its actual envelope", async () => {
    const file = new File([validVideo], "night-scene.webm", {
      type: "video/webm",
    });

    await expect(parseCharacterVideoSourceForm(uploadRequest(file))).resolves.toMatchObject({
      purpose: "character_video_library",
      video: {
        filename: "night-scene.webm",
        contentType: "video/webm",
        extension: ".webm",
        verifiedMedia: { width: 96, height: 96, frameCount: 5, hasAudio: false },
      },
    });
  });

  it("rejects arbitrary bytes even when the MIME type and file extension claim video", async () => {
    const file = new File([new Uint8Array(2_048)], "broken.mp4", { type: "video/mp4" });
    await expect(parseCharacterVideoSourceForm(uploadRequest(file)))
      .rejects.toMatchObject({ status: 400, code: "bad_request" });
  });

  it("uses the real WebM container when the upload incorrectly claims MP4", async () => {
    const file = new File([validVideo], "incorrectly-labeled.mp4", { type: "video/mp4" });
    await expect(parseCharacterVideoSourceForm(uploadRequest(file))).resolves.toMatchObject({
      video: { contentType: "video/webm", extension: ".webm", filename: "incorrectly-labeled.webm", verifiedMedia: { frameCount: 5 } },
    });
  });

  it("rejects truncated content even if its header is still present", async () => {
    const file = new File([validVideo.slice(0, Math.floor(validVideo.length / 2))], "cut.webm", { type: "video/webm" });
    await expect(parseCharacterVideoSourceForm(uploadRequest(file)))
      .rejects.toMatchObject({ status: 400, code: "bad_request" });
  });

  it("classifies an invalid multipart purpose as a client error", async () => {
    const file = new File([new Uint8Array(1_024)], "portrait.mp4", { type: "video/mp4" });
    await expect(parseCharacterVideoSourceForm(uploadRequest(file, "invalid-purpose")))
      .rejects.toMatchObject({ status: 400, code: "bad_request" });
  });

  it("rejects non-video files", async () => {
    const file = new File([new Uint8Array(1_024)], "portrait.png", {
      type: "image/png",
    });

    await expect(parseCharacterVideoSourceForm(uploadRequest(file))).rejects.toMatchObject({
      status: 400,
      message: "Video must be MP4 or WebM",
    });
  });
});
