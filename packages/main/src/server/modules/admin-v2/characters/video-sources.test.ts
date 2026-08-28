import { describe, expect, it } from "vitest";
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
  it("accepts an MP4 without adding review metadata", async () => {
    const file = new File([new Uint8Array(1_024)], "night-scene.mp4", {
      type: "video/mp4",
    });

    await expect(parseCharacterVideoSourceForm(uploadRequest(file))).resolves.toMatchObject({
      purpose: "character_video_library",
      video: {
        filename: "night-scene.mp4",
        contentType: "video/mp4",
        extension: ".mp4",
      },
    });
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
