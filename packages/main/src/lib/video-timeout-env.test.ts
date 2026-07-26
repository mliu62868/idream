import { afterEach, describe, expect, it, vi } from "vitest";

const originalVideoStaleTimeout = process.env.VIDEO_JOB_STALE_TIMEOUT_MS;

afterEach(() => {
  vi.resetModules();
  if (originalVideoStaleTimeout === undefined) {
    delete process.env.VIDEO_JOB_STALE_TIMEOUT_MS;
  } else {
    process.env.VIDEO_JOB_STALE_TIMEOUT_MS = originalVideoStaleTimeout;
  }
});

describe("video timeout environment", () => {
  it("fails fast when the video stale timeout is not a positive integer", async () => {
    process.env.VIDEO_JOB_STALE_TIMEOUT_MS = "not-a-timeout";
    vi.resetModules();

    await expect(import("@/server/lib/env")).rejects.toThrow(
      "VIDEO_JOB_STALE_TIMEOUT_MS",
    );
  });
});
