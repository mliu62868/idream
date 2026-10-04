import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyUIBackend } from "./comfyui";
import { workflowDescriptorSchema } from "./workflow";

const run = promisify(execFile);
const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "sound-test", modelId: "sound-test", backendKind: "comfyui", version: 1,
  comfyWorkflow: { id: "55555555-5555-4555-8555-555555555555", name: "Sound test" },
  capabilities: ["video"], apiPrompt: { "1": { class_type: "SaveVideo", inputs: {} } }, inputs: [],
});
if (descriptor.backendKind !== "comfyui") throw new Error("Expected a ComfyUI fixture");
const testWorkflow = descriptor.comfyWorkflow;

async function fixture(directory: string, volume: string | null, audioSource = "sine=frequency=440:sample_rate=48000") {
  const file = join(directory, "source.mp4");
  const args = ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x96:r=24"];
  if (volume !== null) args.push("-f", "lavfi", "-i", audioSource, "-af", `volume=${volume}`);
  args.push("-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (volume !== null) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
  await run("ffmpeg", [...args, file]);
  return new Uint8Array(await readFile(file));
}

async function deliver(bytes: Uint8Array) {
  const responses = [
    new Response(JSON.stringify({ prompt_id: "audio-p1" })),
    new Response(JSON.stringify({ "audio-p1": { status: { completed: true }, outputs: { "1": { images: [{ filename: "result.mp4", subfolder: "", type: "output" }] } } } })),
    new Response(bytes),
  ];
  const fetchMock = vi.fn(async () => responses.shift()!);
  vi.stubGlobal("fetch", fetchMock);
  const backend = new ComfyUIBackend({ apiUrl: "http://fixture", workflowSync: async () => ({ id: testWorkflow.id, name: testWorkflow.name }) });
  const handle = await backend.submit({ descriptor, slots: {}, timeoutMs: 10_000 });
  const result = await backend.poll(handle);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  return result.assets[0];
}

async function levels(path: string) {
  const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-i", path, "-vn", "-af", "volumedetect,ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 4_000_000 });
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  return { mean: Number(stderr.match(/mean_volume: ([-\d.]+)/)?.[1]), loudness: Number(summary.match(/I:\s+([-\d.]+)/)?.[1]), peak: Number(summary.match(/Peak:\s+([-\d.]+)/)?.[1]) };
}

async function videoPackets(path: string) {
  const { stdout } = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "pipe:1"], { encoding: "buffer" });
  return stdout;
}

describe("native video soundtrack delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["-35dB", "0dB", "20dB"])("delivers audible sound without clipping or changing video packets (%s)", async volume => {
    const directory = await mkdtemp(join(tmpdir(), "idream-video-sound-test-"));
    try {
      const source = await fixture(directory, volume);
      const asset = await deliver(source);
      const file = join(directory, "delivered.mp4");
      await writeFile(file, asset.body);
      expect(asset.verifiedVideo).toMatchObject({ width: 64, height: 96, frameCount: 72, framesPerSecond: 24, hasAudio: true });
      expect(asset.verifiedVideo?.durationSeconds).toBeCloseTo(3, 1);
      const measured = await levels(file);
      expect(measured.mean).toBeGreaterThan(-35);
      expect(measured.loudness).toBeGreaterThan(-19);
      expect(measured.loudness).toBeLessThan(-17);
      expect(measured.peak).toBeLessThanOrEqual(-1.5);
      expect(await videoPackets(file)).toEqual(await videoPackets(join(directory, "source.mp4")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("normalizes quiet audio with brief transients without clipping or changing video packets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "idream-video-sound-test-"));
    try {
      const source = await fixture(directory, "0dB", "aevalsrc=sin(2*PI*440*t)*(0.001+0.8*between(t\\,1\\,1.004)):s=48000:d=3");
      const asset = await deliver(source);
      const file = join(directory, "delivered.mp4");
      await writeFile(file, asset.body);
      expect(asset.verifiedVideo).toMatchObject({ width: 64, height: 96, frameCount: 72, framesPerSecond: 24, hasAudio: true });
      expect(asset.verifiedVideo?.durationSeconds).toBeCloseTo(3, 1);
      const measured = await levels(file);
      expect(measured.mean).toBeGreaterThan(-35);
      expect(measured.loudness).toBeGreaterThan(-19);
      expect(measured.loudness).toBeLessThan(-17);
      expect(measured.peak).toBeLessThanOrEqual(-1.5);
      expect(await videoPackets(file)).toEqual(await videoPackets(join(directory, "source.mp4")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([null, "0"])("preserves absent and digitally silent audio (%s)", async volume => {
    const directory = await mkdtemp(join(tmpdir(), "idream-video-sound-test-"));
    try {
      const source = await fixture(directory, volume);
      const asset = await deliver(source);
      expect(asset.body).toEqual(source);
      expect(asset.verifiedVideo?.hasAudio).toBe(volume !== null);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps the complete video when its native audio ends early", async () => {
    const directory = await mkdtemp(join(tmpdir(), "idream-video-sound-test-"));
    try {
      const source = await fixture(directory, "0dB", "sine=frequency=440:sample_rate=48000:duration=1");
      const asset = await deliver(source);
      const file = join(directory, "delivered.mp4");
      await writeFile(file, asset.body);
      expect(asset.verifiedVideo).toMatchObject({ frameCount: 72, framesPerSecond: 24, hasAudio: true });
      expect(asset.verifiedVideo?.durationSeconds).toBeCloseTo(3, 1);
      expect(await videoPackets(file)).toEqual(await videoPackets(join(directory, "source.mp4")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
