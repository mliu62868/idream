import type { ImageModel } from "../types";

export class MockImageModel implements ImageModel {
  async generate(input: Parameters<ImageModel["generate"]>[0]) {
    const count = Math.max(1, Math.min(input.count, 4));
    const seed = input.seed ?? "mock";

    return {
      ok: true as const,
      data: {
        assets: Array.from({ length: count }, (_, index) => ({
          key: `mock/images/${seed}-${index + 1}.png`,
          width: 1024,
          height: 1024,
        })),
      },
    };
  }
}
