import { describe, expect, it, vi } from "vitest";
import {
  createVideoMediaProbe,
  type VideoMediaCommandRunner,
} from "./video-media-probe";

const VERIFIED_METADATA = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 768,
      height: 1152,
      avg_frame_rate: "25/1",
      duration: "4.040000",
      nb_read_frames: "101",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      duration: "4.000000",
    },
  ],
  format: { duration: "4.040000" },
});

describe("createVideoMediaProbe", () => {
  it("returns the decoded stream envelope only after a full ffmpeg decode", async () => {
    const runner = vi.fn<VideoMediaCommandRunner>(async (command) =>
      command === "probe-bin" ? VERIFIED_METADATA : ""
    );
    const probe = createVideoMediaProbe({
      runner,
      ffprobePath: "probe-bin",
      ffmpegPath: "decode-bin",
      timeoutMs: 1_234,
    });

    await expect(probe(new Uint8Array([1, 2, 3]))).resolves.toEqual({
      width: 768,
      height: 1152,
      durationSeconds: 4.04,
      framesPerSecond: 25,
      hasAudio: true,
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]?.[0]).toBe("probe-bin");
    expect(runner.mock.calls[0]?.[1]).toContain("-count_frames");
    expect(runner.mock.calls[0]?.[2]).toEqual({ timeoutMs: 1_234 });
    expect(runner.mock.calls[1]?.[0]).toBe("decode-bin");
    expect(runner.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "-xerror",
      "-map",
      "0:v:0",
      "0:a:0?",
    ]));
  });

  it("fails closed when ffprobe is unavailable", async () => {
    const runner = vi.fn<VideoMediaCommandRunner>(async () => {
      const error = new Error("spawn ffprobe ENOENT");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    });
    const probe = createVideoMediaProbe({ runner });

    await expect(probe(new Uint8Array([1]))).rejects.toThrow(
      "ffprobe could not verify generated video: spawn ffprobe ENOENT",
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects a parseable container when ffmpeg cannot fully decode it", async () => {
    const runner = vi.fn<VideoMediaCommandRunner>(async (command) => {
      if (command === "ffprobe") return VERIFIED_METADATA;
      throw new Error("Invalid data found when processing input");
    });
    const probe = createVideoMediaProbe({ runner });

    await expect(probe(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "ffmpeg could not fully decode generated video: Invalid data found when processing input",
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
