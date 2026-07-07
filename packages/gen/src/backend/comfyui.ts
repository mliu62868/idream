// SPEC: ComfyUIBackend — GenBackend impl talking to ComfyUI's native HTTP API
// (POST /prompt, GET /history/{id}, GET /view, GET /system_stats).
// INTENT: Ported from comfyui-openai-image-server.ts (submitPrompt/waitForImage/
// fetchComfyImage), stripped of the OpenAI-route wrapper. Workflow binding now goes
// through bindComfySlots(descriptor, slots) instead of the hardcoded buildPrompt.
// INVARIANTS: submit() never blocks on completion — it only enqueues and returns the
// ComfyUI prompt_id, bounded by job.timeoutMs via AbortController. poll() drives the
// wait loop with its own AbortController + job.timeoutMs. health() is a readiness
// probe, bounded by a fixed HEALTH_TIMEOUT_MS regardless of job timeout config.
import { randomUUID } from "node:crypto";
import { assertGeneratedImageSanity } from "../generated-image-sanity";
import { logger } from "../logger";
import { bindComfySlots } from "./workflow";
import type { BackendHandle, BackendHealth, BackendResult, Capabilities, GenBackend, ResolvedGenJob } from "./types";

type JsonRecord = Record<string, unknown>;

// health() is a readiness probe (launch checks, monitoring), not a generation
// request — bound it to a short fixed timeout instead of the (much larger) per-job
// timeoutMs so a stuck ComfyUI process fails the probe quickly.
const HEALTH_TIMEOUT_MS = 5_000;

type ComfyImageOutput = {
  filename: string;
  subfolder: string;
  type: string;
};

// SPEC: pending jobs keyed by prompt_id carry the timeout budget + slot values so
// poll() can honor the original submit()'s timeoutMs and recover width/height.
interface PendingJob {
  timeoutMs: number;
  slots: ResolvedGenJob["slots"];
}

export class ComfyUIBackend implements GenBackend {
  readonly id = "comfyui";
  readonly kind = "comfyui" as const;

  private readonly apiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly pending = new Map<string, PendingJob>();

  constructor(opts: { apiUrl: string; pollIntervalMs?: number }) {
    this.apiUrl = trimTrailingSlash(opts.apiUrl);
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  }

  capabilities(): Capabilities {
    return {
      textToImage: true,
      img2img: true,
      referenceImages: false,
      stableSeed: true,
      edit: false,
    };
  }

  async submit(job: ResolvedGenJob): Promise<BackendHandle> {
    const prompt = bindComfySlots(job.descriptor, job.slots);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), job.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          client_id: `idream-comfyui-backend-${randomUUID()}`,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`ComfyUI /prompt timed out after ${job.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const json = (await response.json().catch(() => ({}))) as JsonRecord;
    if (!response.ok) throw new Error(`ComfyUI /prompt HTTP ${response.status}`);
    const promptId = stringField(json, "prompt_id");
    if (!promptId) {
      logger.warn({ workflowKey: job.descriptor.workflowKey, response: json }, "ComfyUI rejected prompt");
      throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(json)}`);
    }
    this.pending.set(promptId, { timeoutMs: job.timeoutMs, slots: job.slots });
    return { id: promptId };
  }

  async poll(handle: BackendHandle): Promise<BackendResult> {
    const pending = this.pending.get(handle.id);
    const timeoutMs = pending?.timeoutMs ?? 600_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const image = await this.waitForImage(handle.id, timeoutMs, controller.signal);
      const bytes = await this.fetchComfyImage(image, controller.signal);
      assertGeneratedImageSanity(Buffer.from(bytes), handle.id);
      const dimensions = pngDimensions(bytes) ?? {
        width: numberSlot(pending?.slots, "width") ?? 0,
        height: numberSlot(pending?.slots, "height") ?? 0,
      };
      return {
        assets: [
          {
            body: bytes,
            width: dimensions.width,
            height: dimensions.height,
            contentType: "image/png",
          },
        ],
      };
    } finally {
      clearTimeout(timeout);
      this.pending.delete(handle.id);
    }
  }

  async health(): Promise<BackendHealth> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.apiUrl}/system_stats`, { signal: controller.signal });
      if (!response.ok) return { ok: false, detail: `ComfyUI /system_stats HTTP ${response.status}` };
      return { ok: true };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        detail: aborted
          ? `ComfyUI /system_stats timed out after ${HEALTH_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForImage(
    promptId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ComfyImageOutput> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (signal.aborted) break;
      const response = await fetch(`${this.apiUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      const history = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) throw new Error(`ComfyUI /history HTTP ${response.status}`);
      const item = jsonRecord(history[promptId]);
      const status = jsonRecord(item.status);
      if (status.status_str === "error") {
        throw new Error(`ComfyUI prompt failed: ${JSON.stringify(status.messages ?? status)}`);
      }
      if (status.completed === true) {
        const image = firstImageOutput(item);
        if (!image) throw new Error(`ComfyUI prompt ${promptId} completed without image output`);
        return image;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`ComfyUI prompt timed out after ${timeoutMs}ms: ${promptId}`);
  }

  private async fetchComfyImage(image: ComfyImageOutput, signal: AbortSignal): Promise<Uint8Array> {
    const url = new URL(`${this.apiUrl}/view`);
    url.searchParams.set("filename", image.filename);
    url.searchParams.set("subfolder", image.subfolder);
    url.searchParams.set("type", image.type);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`ComfyUI /view HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

function firstImageOutput(historyItem: JsonRecord): ComfyImageOutput | null {
  const outputs = jsonRecord(historyItem.outputs);
  for (const rawOutput of Object.values(outputs)) {
    const output = jsonRecord(rawOutput);
    const images = Array.isArray(output.images) ? output.images : [];
    for (const rawImage of images) {
      const image = jsonRecord(rawImage);
      const filename = stringField(image, "filename");
      const subfolder = stringField(image, "subfolder") ?? "";
      const type = stringField(image, "type") ?? "output";
      if (filename) return { filename, subfolder, type };
    }
  }
  return null;
}

// SPEC: fall back to the PNG IHDR chunk for width/height when the job's slots don't
// carry explicit dimensions (mirrors comfyui-openai-image-server's behavior of
// trusting the requested size, but this backend has no size input by default).
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function numberSlot(slots: ResolvedGenJob["slots"] | undefined, key: string): number | undefined {
  const value = slots?.[key];
  return typeof value === "number" ? value : undefined;
}

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringField(value: JsonRecord, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
