import type { VideoModel } from "../types";
import { mockVideoMp4Bytes } from "@idream/shared";

export class MockVideoModel implements VideoModel {
  async generate(input: Parameters<VideoModel["generate"]>[0]) {
    return {
      ok: true as const,
      data: {
        asset: {
          key: `mock/videos/${input.seed ?? "mock"}.mp4`,
          seconds: input.seconds,
          contentType: "video/mp4",
          body: mockVideoMp4Bytes(),
        },
      },
    };
  }
}
