import { afterEach, describe, expect, it, vi } from "vitest";

const originalVideoStaleTimeout = process.env.VIDEO_JOB_STALE_TIMEOUT_MS;
const originalVideoTimeout = process.env.GEN_VIDEO_TIMEOUT_MS;

afterEach(() => {
  vi.resetModules();
  if (originalVideoStaleTimeout === undefined) {
    delete process.env.VIDEO_JOB_STALE_TIMEOUT_MS;
  } else {
    process.env.VIDEO_JOB_STALE_TIMEOUT_MS = originalVideoStaleTimeout;
  }
  if (originalVideoTimeout === undefined) {
    delete process.env.GEN_VIDEO_TIMEOUT_MS;
  } else {
    process.env.GEN_VIDEO_TIMEOUT_MS = originalVideoTimeout;
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

  it("requires the stale window to outlive the provider timeout", async () => {
    process.env.GEN_VIDEO_TIMEOUT_MS = "1800000";
    process.env.VIDEO_JOB_STALE_TIMEOUT_MS = "1800000";
    vi.resetModules();

    await expect(import("@/server/lib/env")).rejects.toThrow(
      "VIDEO_JOB_STALE_TIMEOUT_MS must be greater than GEN_VIDEO_TIMEOUT_MS",
    );
  });
});
