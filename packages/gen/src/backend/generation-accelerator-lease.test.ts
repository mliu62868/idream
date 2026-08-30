import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withGenerationAcceleratorLease } from "./generation-accelerator-lease";

describe("generation accelerator lease", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("serializes image and video work across process-shaped callers", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "mps.lock");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withGenerationAcceleratorLease(
      "video",
      async () => {
        events.push("video:start");
        await blocker;
        events.push("video:end");
      },
      { lockPath, pollMs: 5, staleMs: 1_000 },
    );
    while (!events.includes("video:start")) await new Promise((resolve) => setTimeout(resolve, 1));

    const second = withGenerationAcceleratorLease(
      "image",
      async () => {
        events.push("image:start");
      },
      { lockPath, pollMs: 5, staleMs: 1_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["video:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["video:start", "video:end", "image:start"]);
  });

  it("reclaims a stale lock left by a dead worker", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "mps.lock");
    await writeFile(lockPath, JSON.stringify({
      pid: 999_999,
      token: "dead",
      kind: "video",
      acquiredAtMs: 0,
    }));

    await expect(withGenerationAcceleratorLease(
      "image",
      async () => "acquired",
      { lockPath, pollMs: 5, staleMs: 1 },
    )).resolves.toBe("acquired");
  });
});
