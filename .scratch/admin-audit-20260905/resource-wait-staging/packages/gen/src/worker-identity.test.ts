import { describe, expect, it } from "vitest";
import { imageWorkerIdentity, videoWorkerIdentity } from "./worker-identity";
import { queueWorkerRuntimeOptions } from "./queue";

describe("Generation worker ownership identity", () => {
  it("binds a production worker to release run, PM2 slot and actual PID", () => {
    expect(
      imageWorkerIdentity({
        appEnv: "production",
        pid: 4123,
        runId: "release-abc123",
        slot: "1",
      }),
    ).toBe("idream.gen-image.v1.release-abc123.1.4123");
    expect(
      videoWorkerIdentity({
        appEnv: "production",
        pid: 5123,
        runId: "release-abc123",
        slot: "0",
      }),
    ).toBe("idream.gen-video.v1.release-abc123.0.5123");
  });

  it("fails closed when production ownership cannot be named", () => {
    expect(() =>
      imageWorkerIdentity({ appEnv: "production", pid: 4123, slot: "0" }),
    ).toThrow(/GEN_IMAGE_WORKER_RUN_ID is required/);
    expect(() =>
      imageWorkerIdentity({
        appEnv: "production",
        pid: 4123,
        runId: "bad.run",
        slot: "0",
      }),
    ).toThrow(/letters, digits/);
    expect(() =>
      imageWorkerIdentity({
        appEnv: "production",
        pid: 4123,
        runId: "release-abc123",
      }),
    ).toThrow(/NODE_APP_INSTANCE is required/);
    expect(() =>
      imageWorkerIdentity({
        appEnv: "production",
        pid: 4123,
        runId: "release-abc123",
        slot: "01",
      }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      videoWorkerIdentity({ appEnv: "production", pid: 5123, slot: "0" }),
    ).toThrow(/GEN_VIDEO_WORKER_RUN_ID is required/);
  });

  it("passes the exact identity into BullMQ Worker options", () => {
    expect(
      queueWorkerRuntimeOptions({
        concurrency: 3,
        workerName: "idream.gen-image.v1.release.0.4123",
      }),
    ).toEqual({
      concurrency: 3,
      name: "idream.gen-image.v1.release.0.4123",
    });
  });
});
