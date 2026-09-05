import { describe, expect, it, vi } from "vitest";
import { prepareComfyUiRunnerMemory } from "./comfyui-memory-transition";

const endpoints = {
  image: "http://127.0.0.1:8189/",
  video: "http://127.0.0.1:8188",
  "video-h3": "http://127.0.0.1:8190",
} as const;

function successfulFetch() {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

describe("ComfyUI memory transition", () => {
  it("releases both video runners before an image generation", async () => {
    const fetchImpl = successfulFetch();

    await prepareComfyUiRunnerMemory("image", { endpoints, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8188/free",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8190/free",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("releases the image and H3 runners before RedGraft video", async () => {
    const fetchImpl = successfulFetch();

    await prepareComfyUiRunnerMemory("video", { endpoints, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8189/free",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8190/free",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("releases the image and RedGraft runners before H3 video", async () => {
    const fetchImpl = successfulFetch();

    await prepareComfyUiRunnerMemory("video-h3", { endpoints, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8189/free",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8188/free",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never frees the target endpoint and de-duplicates shared endpoints", async () => {
    const fetchImpl = successfulFetch();

    await prepareComfyUiRunnerMemory("video", {
      endpoints: {
        image: "http://127.0.0.1:8189",
        video: "http://127.0.0.1:8188",
        "video-h3": "http://127.0.0.1:8188/",
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8189/free",
      expect.any(Object),
    );
  });

  it("does not fail generation preparation when an alternative runner is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("8189")) throw new Error("connection refused");
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;

    await expect(
      prepareComfyUiRunnerMemory("video", { endpoints, fetchImpl }),
    ).resolves.toBeUndefined();
  });
});
