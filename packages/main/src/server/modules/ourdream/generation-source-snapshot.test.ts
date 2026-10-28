import { createRequire } from "node:module";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { withGenerationSnapshotSlot } from "./generation-source-snapshot";
import { assertGenerationSourceImageAuthority } from "./generation-job-authority";
import { providers } from "@/server/providers";

it("bounds concurrent verification and releases slots after success or failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withGenerationSnapshotSlot(async () => { await gate; });
  const second = withGenerationSnapshotSlot(async () => { await gate; throw new Error("fixture failure"); });
  await expect(withGenerationSnapshotSlot(async () => {})).rejects.toMatchObject({ status: 503 });
  release();
  await first;
  await expect(second).rejects.toThrow("fixture failure");
  await expect(withGenerationSnapshotSlot(async () => "ready")).resolves.toBe("ready");
});

it("holds both slots until delayed native Sharp callbacks finish, even after the time limit", async () => {
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#567890" } }).png().toBuffer();
  const native = createRequire(import.meta.url)("sharp/lib/sharp") as { pipeline: (options: unknown, callback: (...args: unknown[]) => void) => void };
  const pipeline = native.pipeline.bind(native);
  let callbacksReady = 0, signalReady!: () => void;
  const ready = new Promise<void>(resolve => { signalReady = resolve; });
  vi.spyOn(native, "pipeline").mockImplementation((options, callback) => {
    pipeline(options, (...args) => {
      if (++callbacksReady === 2) signalReady();
      // Exercise the real native pipeline, but hold its callback past the
      // budget to simulate native work returning late to JavaScript.
      setTimeout(() => callback(...args), 10_300);
    });
  });
  vi.spyOn(providers.blob, "getPrivate").mockResolvedValue({ ok: true, data: { body: bytes, contentType: "image/png" } });
  const db = { mediaAsset: { findFirst: async () => ({ id: "source", storageKey: "source.png", url: "/source.png", metadata: {} }) } };
  const operation = () => withGenerationSnapshotSlot(() => assertGenerationSourceImageAuthority(db as never, { sourceImageAssetId: "source", userId: "user", characterId: null, verifyImagePixels: true }));
  let settled = 0;
  const first = operation().finally(() => { settled++; });
  const second = operation().finally(() => { settled++; });
  // Install rejection handlers immediately while the test waits.
  const results = Promise.allSettled([first, second]);
  try {
    await ready;
    await new Promise(resolve => setTimeout(resolve, 10_050));
    expect(settled).toBe(0);
    await expect(withGenerationSnapshotSlot(async () => {})).rejects.toMatchObject({ status: 503 });
    const completed = await results;
    expect(completed).toHaveLength(2);
    for (const result of completed) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 503 });
    }
    await expect(withGenerationSnapshotSlot(async () => "ready")).resolves.toBe("ready");
  } finally { vi.restoreAllMocks(); }
}, 20_000);
