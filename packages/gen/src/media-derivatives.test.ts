// SPEC: display derivatives against real sharp and ffmpeg bytes. The provider and
// the blob store are in-memory; every byte they carry is really encoded and decoded.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  generationTerminalRecordSchema,
  type GenerationTerminalRecordIngest,
  type ImageGeneratePayload,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { processImageGenerate, processVideoGenerate, type PipelineDeps } from "./pipeline";
import type { GenProviders } from "./providers";

const IMAGE_PREFIX = "gen/job_img/attempts/attempt_img/";
const VIDEO_PREFIX = "gen/job_vid/attempts/attempt_vid/";

function memoryBlob() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const blob: GenProviders["blob"] = {
    putPrivate: vi.fn(),
    signGetUrl: vi.fn(),
    putPrivateIfAbsent: vi.fn(async (input: { key: string; body: Uint8Array; contentType: string }) => {
      const created = !objects.has(input.key);
      if (created) objects.set(input.key, { body: input.body, contentType: input.contentType });
      return { ok: true as const, data: { key: input.key, size: input.body.byteLength, created } };
    }),
    delete: vi.fn(async (input: { key: string }) => {
      objects.delete(input.key);
      return { ok: true as const, data: { deleted: true as const } };
    }),
    getPrivate: vi.fn(async (input: { key: string }) => {
      const object = objects.get(input.key);
      return object
        ? { ok: true as const, data: { body: object.body, contentType: object.contentType } }
        : { ok: false as const, error: { code: "not_found", message: "not found", retryable: false } };
    }),
  } as unknown as GenProviders["blob"];
  return { blob, objects };
}

function imagePayload(overrides: Partial<ImageGeneratePayload> = {}): ImageGeneratePayload {
  return {
    version: 1, kind: "image", requestId: "req_img", generationJobId: "job_img", attemptId: "attempt_img", attemptNo: 1,
    userId: "user", characterId: null, prompt: "a lake", negativePrompt: null, controls: {}, presetIds: [], orientation: "portrait", count: 1,
    seed: "seed", model: "mock-image", provider: "mock", outputPrefix: IMAGE_PREFIX, ...overrides,
  } as ImageGeneratePayload;
}

function videoPayload(): VideoGeneratePayload {
  return {
    version: 1, kind: "video", requestId: "req_vid", generationJobId: "job_vid", attemptId: "attempt_vid", attemptNo: 1,
    userId: "user", characterId: null, prompt: "a lake", negativePrompt: null, controls: {}, seconds: 1,
    seed: "seed", model: "mock-video", provider: "mock", outputPrefix: VIDEO_PREFIX,
  } as VideoGeneratePayload;
}

function providers(over: Partial<GenProviders>): GenProviders {
  const retryCapabilities = { deterministicIdempotencyKey: true, retryableFailureCodes: [] };
  return {
    moderation: { check: vi.fn(async () => ({ ok: true as const, data: { status: "passed" as const, confidence: 0.5 } })) },
    image: { retryCapabilities, generate: vi.fn() },
    video: { retryCapabilities, generate: vi.fn() },
    ...over,
  } as unknown as GenProviders;
}

function deps(over: Partial<PipelineDeps>): PipelineDeps & { acknowledgeTerminalRecord: ReturnType<typeof vi.fn> } {
  return {
    acknowledgeTerminalRecord: vi.fn(async (_: GenerationTerminalRecordIngest) => {}),
    recordTransportExecution: vi.fn(async () => {}),
    readSourceSnapshot: async () => { throw new Error("unused"); },
    ...over,
  } as PipelineDeps & { acknowledgeTerminalRecord: ReturnType<typeof vi.fn> };
}

function recordOf(run: { acknowledgeTerminalRecord: ReturnType<typeof vi.fn> }) {
  const ingest = run.acknowledgeTerminalRecord.mock.calls.at(-1)![0] as GenerationTerminalRecordIngest;
  return ingest.terminalRecord;
}

// Noise is what makes a PNG large, the way a generated image is.
async function noisyPng(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3);
  let state = 12345;
  for (let index = 0; index < raw.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    raw[index] = index % 3 === 0 ? (state >> 16) & 0xff : Math.round((255 * index) / raw.length);
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

function realMp4WithRedFirstSecond() {
  const directory = mkdtempSync(join(tmpdir(), `idream-derivative-test-${randomUUID()}`));
  const path = join(directory, "clip.mp4");
  try {
    // Red for 0.2s, then blue: only the first decoded frame can be red. Ten seconds of
    // later blue would make a "grab from the middle" poster fail this test.
    execFileSync("ffmpeg", ["-nostdin", "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:s=832x1024:r=24:d=0.2",
      "-f", "lavfi", "-i", "color=c=blue:s=832x1024:r=24:d=0.8",
      "-filter_complex", "[0][1]concat=n=2:v=1[v]", "-map", "[v]",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
    return new Uint8Array(readFileSync(path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("image derivatives", () => {
  it("writes a 640px WebP beside the original and leaves the original byte-identical", async () => {
    const png = await noisyPng(832, 1024);
    const { blob, objects } = memoryBlob();
    const run = deps({ providers: providers({ blob, image: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
      ok: true as const, data: { assets: [{ body: png, width: 832, height: 1024, contentType: "image/png" }] },
    })) } as unknown as GenProviders["image"] }) });
    await processImageGenerate(imagePayload(), run);

    const original = objects.get(`${IMAGE_PREFIX}image-1.png`)!;
    expect(createHash("sha256").update(original.body).digest("hex")).toBe(createHash("sha256").update(png).digest("hex"));

    const derivative = objects.get(`${IMAGE_PREFIX}image-1.preview.webp`)!;
    expect(derivative.contentType).toBe("image/webp");
    const decoded = await sharp(derivative.body).metadata();
    expect(decoded).toMatchObject({ format: "webp", width: 520, height: 640 });
    expect(derivative.body.byteLength).toBeLessThan(png.byteLength / 4);

    const record = recordOf(run);
    expect(record).toMatchObject({ outcome: "succeeded", assets: [{
      key: `${IMAGE_PREFIX}image-1.png`, width: 832, height: 1024,
      derivative: { status: "ready", key: `${IMAGE_PREFIX}image-1.preview.webp`, contentType: "image/webp",
        width: 520, height: 640, sizeBytes: derivative.body.byteLength },
    }] });
    // The persisted record must round-trip with its derivative, or Main's checksum
    // would see a stripped record and quarantine a paid delivery.
    expect(generationTerminalRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it("never upscales a source smaller than the preview", async () => {
    const png = await noisyPng(48, 64);
    const { blob, objects } = memoryBlob();
    const run = deps({ providers: providers({ blob, image: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
      ok: true as const, data: { assets: [{ body: png, width: 48, height: 64, contentType: "image/png" }] },
    })) } as unknown as GenProviders["image"] }) });
    await processImageGenerate(imagePayload(), run);
    expect(await sharp(objects.get(`${IMAGE_PREFIX}image-1.preview.webp`)!.body).metadata()).toMatchObject({ width: 48, height: 64 });
  });

  it("delivers the paid image and records the failure when the derivative cannot be stored", async () => {
    const png = await noisyPng(64, 64);
    const { blob, objects } = memoryBlob();
    const put = blob.putPrivateIfAbsent;
    blob.putPrivateIfAbsent = vi.fn(async (input) => {
      if (input.key.endsWith(".preview.webp")) {
        await put(input); // The store wrote it; the acknowledgement was lost.
        throw new Error("lost write acknowledgement");
      }
      return put(input);
    });
    const run = deps({ providers: providers({ blob, image: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
      ok: true as const, data: { assets: [{ body: png, width: 64, height: 64, contentType: "image/png" }] },
    })) } as unknown as GenProviders["image"] }) });
    await processImageGenerate(imagePayload(), run);
    expect(recordOf(run)).toMatchObject({ outcome: "succeeded", assets: [{
      key: `${IMAGE_PREFIX}image-1.png`,
      derivative: { status: "failed", code: "derivative_persist_failed", message: "lost write acknowledgement" },
    }] });
    expect(objects.has(`${IMAGE_PREFIX}image-1.png`)).toBe(true);
    expect(objects.has(`${IMAGE_PREFIX}image-1.preview.webp`)).toBe(false);
  });

  it("rolls back and reports a derivative it wrote when a later asset fails", async () => {
    const png = await noisyPng(64, 64);
    const { blob, objects } = memoryBlob();
    const put = blob.putPrivateIfAbsent;
    blob.putPrivateIfAbsent = vi.fn(async (input) => {
      if (input.key.endsWith("image-2.png")) throw new Error("store disconnected");
      return put(input);
    });
    const remove = blob.delete;
    blob.delete = vi.fn(async (input) => {
      // Only the first asset's original deletes; its derivative must then survive
      // as durable cleanup intent, or Main could never remove it.
      if (input.key.endsWith("image-1.preview.webp")) return { ok: false as const, error: { code: "blob_delete_failed", message: "unavailable", retryable: true } };
      return remove(input);
    });
    const run = deps({ providers: providers({ blob, image: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
      ok: true as const, data: { assets: [
        { body: png, width: 64, height: 64, contentType: "image/png" },
        { body: png, width: 64, height: 64, contentType: "image/png" },
      ] },
    })) } as unknown as GenProviders["image"] }) });
    await processImageGenerate(imagePayload({ count: 2 }), run);
    expect(recordOf(run)).toMatchObject({ outcome: "failed", cleanupKeys: [`${IMAGE_PREFIX}image-1.preview.webp`] });
    expect(objects.has(`${IMAGE_PREFIX}image-1.png`)).toBe(false);
  });

  it("does not disturb a localized edit's preservation proof", async () => {
    const png = await noisyPng(64, 64);
    const resultSha256 = createHash("sha256").update(png).digest("hex");
    const evidence = { resultSha256, changedProtectedPixels: 0 };
    const maskBody = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer());
    const { blob, objects } = memoryBlob();
    const run = deps({ providers: providers({ blob, image: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
      ok: true as const, data: { assets: [{ body: png, width: 64, height: 64, contentType: "image/png", preservation: { maskBody, evidence } }] },
    })) } as unknown as GenProviders["image"] }) });
    await processImageGenerate(imagePayload({ controls: { localizedEdit: { version: "sam3-rgb-composite-1" } } }), run);
    const record = recordOf(run);
    expect(record).toMatchObject({ outcome: "succeeded", assets: [{
      quality: { preservation: { resultSha256, changedProtectedPixels: 0 } },
      derivative: { status: "ready" },
    }] });
    expect(createHash("sha256").update(objects.get(`${IMAGE_PREFIX}image-1.png`)!.body).digest("hex")).toBe(resultSha256);
  });

  it("omits the field for a non-canonical key, so the record hashes as it did before derivatives", async () => {
    const png = await noisyPng(64, 64);
    const { blob, objects } = memoryBlob();
    const run = deps({ providers: providers({ blob, image: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
      ok: true as const, data: { assets: [{ body: png, width: 64, height: 64, contentType: "image/png" }] },
    })) } as unknown as GenProviders["image"] }) });
    await processImageGenerate(imagePayload({ outputPrefix: "gen/job_img/" }), run);
    const record = recordOf(run);
    expect(record.outcome === "succeeded" && record.assets[0]).not.toHaveProperty("derivative");
    expect([...objects.keys()].filter((key) => key.endsWith(".webp"))).toEqual([]);
  });
});

describe("video posters", () => {
  const verifiedMedia = { width: 832, height: 1024, durationSeconds: 1, framesPerSecond: 24, frameCount: 24, hasAudio: false };

  it("uses the first decoded frame of a real MP4, outside the device lease", async () => {
    const video = realMp4WithRedFirstSecond();
    const { blob, objects } = memoryBlob();
    let leaseHeld = false;
    const leaseHeldAtPut: boolean[] = [];
    const put = blob.putPrivateIfAbsent;
    blob.putPrivateIfAbsent = vi.fn(async (input) => {
      if (input.key.startsWith(VIDEO_PREFIX)) leaseHeldAtPut.push(leaseHeld);
      return put(input);
    });
    const run = deps({
      probeVideoMedia: vi.fn(async () => verifiedMedia),
      providers: providers({ blob, video: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => {
        // A real backend holds the accelerator lease only for the span of generate().
        leaseHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 1));
        leaseHeld = false;
        return { ok: true as const, data: { asset: { body: video, seconds: 1, contentType: "video/mp4" } } };
      }) } as unknown as GenProviders["video"] }),
    });
    await processVideoGenerate(videoPayload(), run);

    expect(createHash("sha256").update(objects.get(`${VIDEO_PREFIX}video.mp4`)!.body).digest("hex"))
      .toBe(createHash("sha256").update(video).digest("hex"));
    expect(leaseHeldAtPut).toEqual([false, false]);

    const poster = objects.get(`${VIDEO_PREFIX}video.preview.webp`)!;
    expect(poster.contentType).toBe("image/webp");
    expect(await sharp(poster.body).metadata()).toMatchObject({ format: "webp", width: 520, height: 640 });
    const { data } = await sharp(poster.body).resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // red
    expect(data[2]).toBeLessThan(60); // not blue

    expect(recordOf(run)).toMatchObject({ outcome: "succeeded", assets: [{
      key: `${VIDEO_PREFIX}video.mp4`, derivative: { status: "ready", key: `${VIDEO_PREFIX}video.preview.webp`, width: 520, height: 640 },
    }] });
  });

  it("delivers the paid video and records the failure when no poster can be extracted", async () => {
    const { blob, objects } = memoryBlob();
    const run = deps({
      probeVideoMedia: vi.fn(async () => verifiedMedia),
      extractVideoPoster: vi.fn(async () => { throw new Error("ffmpeg: not found"); }),
      providers: providers({ blob, video: { retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: [] }, generate: vi.fn(async () => ({
        ok: true as const, data: { asset: { body: Buffer.from("....ftypisom0000"), seconds: 1, contentType: "video/mp4" } },
      })) } as unknown as GenProviders["video"] }),
    });
    await processVideoGenerate(videoPayload(), run);
    expect(recordOf(run)).toMatchObject({ outcome: "succeeded", assets: [{
      key: `${VIDEO_PREFIX}video.mp4`,
      derivative: { status: "failed", code: "derivative_render_failed", message: "ffmpeg: not found" },
    }] });
    expect(objects.has(`${VIDEO_PREFIX}video.preview.webp`)).toBe(false);
  });
});
