import { describe, expect, it, vi } from "vitest";
import { prepareComfyUiRunnerMemory, waitForComfyUiAcceleratorIdle, waitForComfyUiRunnerReady } from "./comfyui-memory-transition";

const endpoints = {
  image: "http://127.0.0.1:8189/",
  video: "http://127.0.0.1:8188",
  "video-h3": "http://127.0.0.1:8190",
} as const;

function successfulFetch() {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

describe("ComfyUI runner readiness", () => {
  const refused = () => Object.assign(new TypeError("Unable to connect."), { code: "ConnectionRefused" });

  it("proceeds immediately when the target runner answers, checking no other runner", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ queue_running: [], queue_pending: [] })) as unknown as typeof fetch;
    const onWait = vi.fn(async () => {});
    await waitForComfyUiRunnerReady("video-h3", { endpoints, fetchImpl, onWait });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8190/queue", expect.any(Object));
    expect(onWait).not.toHaveBeenCalled();
  });

  it("waits through a restart and reports the wait to Main", async () => {
    let reads = 0;
    const fetchImpl = vi.fn(async () => {
      if (reads++ < 2) throw refused();
      return Response.json({ queue_running: [], queue_pending: [] });
    }) as unknown as typeof fetch;
    const onWait = vi.fn(async () => {});
    await waitForComfyUiRunnerReady("image", { endpoints, fetchImpl, onWait, pollMs: 1, waitTimeoutMs: 1_000, heartbeatMs: 0 });
    expect(reads).toBe(3);
    expect(onWait).toHaveBeenCalledTimes(2);
  });

  it("treats a runner too busy to answer in time as not ready yet", async () => {
    let reads = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (reads++ > 0) return Response.json({ queue_running: [], queue_pending: [] });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;
    await waitForComfyUiRunnerReady("image", { endpoints, fetchImpl, pollMs: 1, timeoutMs: 1, waitTimeoutMs: 1_000 });
    expect(reads).toBe(2);
  });

  it("fails before the invocation boundary when the runner stays down", async () => {
    const fetchImpl = vi.fn(async () => { throw refused(); }) as unknown as typeof fetch;
    await expect(waitForComfyUiRunnerReady("video", { endpoints, fetchImpl, pollMs: 1, waitTimeoutMs: 5 }))
      .rejects.toThrow("ComfyUI video runner did not answer within 5ms");
  });

  it("stops waiting when Main withdraws the attempt", async () => {
    const fetchImpl = vi.fn(async () => { throw refused(); }) as unknown as typeof fetch;
    const onWait = vi.fn(async () => { throw new Error("Main authority cancelled"); });
    await expect(waitForComfyUiRunnerReady("video", { endpoints, fetchImpl, onWait, pollMs: 1, waitTimeoutMs: 1_000 }))
      .rejects.toThrow("Main authority cancelled");
  });

  it("does not hide an unexpected transport failure as a restart", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("unknown certificate verification error"); }) as unknown as typeof fetch;
    await expect(waitForComfyUiRunnerReady("image", { endpoints, fetchImpl, waitTimeoutMs: 1_000 }))
      .rejects.toThrow("unknown certificate verification error");
  });
});

describe("ComfyUI memory transition", () => {
  it("waits for native prompts that survived a worker timeout before permitting another runner", async () => {
    let videoReads = 0;
    const onWait = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const running = String(input).includes("8188") && videoReads++ === 0;
      return Response.json({ queue_running: running ? [[1, "old-native-prompt"]] : [], queue_pending: [] });
    }) as unknown as typeof fetch;

    await waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl, onWait, pollMs: 1, waitTimeoutMs: 50 });

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(videoReads).toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8188/queue", expect.any(Object));
  });

  it("does not mistake an unreadable native queue for an idle accelerator", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl })).rejects.toThrow(/queue.*503/);
  });

  it("bounds orphaned native prompt waiting and keeps Main cancellation authoritative", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ queue_running: [[1, "still-running"]], queue_pending: [] })) as unknown as typeof fetch;
    await expect(waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl, pollMs: 1, waitTimeoutMs: 10 })).rejects.toThrow(/wait timed out/);
    const onWait = vi.fn(async () => { throw new Error("Main authority cancelled"); });
    await expect(waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl, pollMs: 1, waitTimeoutMs: 50, onWait })).rejects.toThrow("Main authority cancelled");
  });

  it("can ignore a positively disconnected runner but rejects malformed queue evidence", async () => {
    const refused = vi.fn(async () => { throw new Error("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) }); }) as unknown as typeof fetch;
    await expect(waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl: refused })).resolves.toBeUndefined();
    const malformed = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    await expect(waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl: malformed })).rejects.toThrow(/malformed/);
  });

  it("recognizes Bun's connection-refused code for a stopped runner", async () => {
    const refused = vi.fn(async () => {
      throw Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
    }) as unknown as typeof fetch;
    await expect(waitForComfyUiAcceleratorIdle({ endpoints, fetchImpl: refused })).resolves.toBeUndefined();
  });

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
