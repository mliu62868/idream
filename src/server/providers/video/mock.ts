import type { VideoModel } from "../types";

export class MockVideoModel implements VideoModel {
  async generate(input: Parameters<VideoModel["generate"]>[0]) {
    return {
      ok: true as const,
      data: {
        asset: {
          key: `mock/videos/${input.seed ?? "mock"}.mp4`,
          seconds: input.seconds,
        },
      },
    };
  }
}
