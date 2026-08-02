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
import { syncComfyUiWorkflow } from "./comfyui-workflow";
import { assignWorkflowReferenceSlots, bindComfySlots } from "./workflow";
import type { WorkflowDescriptor } from "./workflow";
import {
  probeVideoMedia,
  type VideoMediaProbe,
} from "./video-media-probe";
import {
  BackendInvocationError,
  type BackendHandle,
  type BackendHealth,
  type BackendResult,
  type Capabilities,
  type GenBackend,
  type ResolvedGenJob,
} from "./types";

type JsonRecord = Record<string, unknown>;
type ComfyDescriptor = Extract<WorkflowDescriptor, { backendKind: "comfyui" }>;
type ReferenceImage = NonNullable<ResolvedGenJob["referenceImages"]>[number];
type UploadedImage = { name: string; subfolder: string; type: string };
type WorkflowSync = (input: {
  apiUrl: string;
  descriptor: ComfyDescriptor;
  timeoutMs: number;
}) => Promise<JsonRecord>;

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
  outputKind: "image" | "video";
}

export class ComfyUIBackend implements GenBackend {
  readonly id = "comfyui";
  readonly kind = "comfyui" as const;

  private readonly apiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly workflowSync: WorkflowSync;
  private readonly videoMediaProbe: VideoMediaProbe;
  private readonly workflowGraphs = new Map<string, Promise<JsonRecord>>();
  private readonly pending = new Map<string, PendingJob>();

  constructor(opts: {
    apiUrl: string;
    pollIntervalMs?: number;
    workflowSync?: WorkflowSync;
    videoMediaProbe?: VideoMediaProbe;
  }) {
    this.apiUrl = trimTrailingSlash(opts.apiUrl);
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.workflowSync = opts.workflowSync ?? syncComfyUiWorkflow;
    this.videoMediaProbe = opts.videoMediaProbe ?? probeVideoMedia;
  }

  capabilities(): Capabilities {
    return {
      textToImage: true,
      img2img: true,
      referenceImages: true,
      stableSeed: true,
      edit: false,
    };
  }

  async submit(job: ResolvedGenJob): Promise<BackendHandle> {
    if (job.descriptor.backendKind !== "comfyui") {
      throw new Error(
        `comfyui: workflow ${job.descriptor.workflowKey} targets ${job.descriptor.backendKind}`,
      );
    }
    const descriptor = job.descriptor;
    const workflow = await this.getWorkflowGraph(descriptor, job.timeoutMs);
    const slots = await this.bindReferenceImageSlots(job);
    const prompt = bindComfySlots(descriptor, slots);
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
          extra_data: {
            extra_pnginfo: {
              workflow,
            },
            idream_workflow: {
              key: descriptor.workflowKey,
              model_id: descriptor.modelId,
              version: descriptor.version,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new BackendInvocationError(
          "timeout",
          `ComfyUI /prompt timed out after ${job.timeoutMs}ms`,
          "post_submit",
          "ambiguous",
        );
      }
      throw new BackendInvocationError(
        "backend_error",
        error instanceof Error ? error.message : String(error),
        "post_submit",
        "ambiguous",
      );
    } finally {
      clearTimeout(timeout);
    }
    const json = (await response.json().catch(() => ({}))) as JsonRecord;
    if (!response.ok) {
      throw new BackendInvocationError(
        "backend_error",
        `ComfyUI /prompt HTTP ${response.status}`,
        "pre_submit",
        "definitive",
      );
    }
    const promptId = stringField(json, "prompt_id");
    if (!promptId) {
      logger.warn({ workflowKey: job.descriptor.workflowKey, response: json }, "ComfyUI rejected prompt");
      const explicitlyRejected =
        json.error !== undefined ||
        Object.keys(jsonRecord(json.node_errors)).length > 0;
      throw new BackendInvocationError(
        "backend_error",
        `ComfyUI did not return prompt_id: ${JSON.stringify(json)}`,
        explicitlyRejected ? "pre_submit" : "post_submit",
        explicitlyRejected ? "definitive" : "ambiguous",
      );
    }
    this.pending.set(promptId, {
      timeoutMs: job.timeoutMs,
      slots: job.slots,
      outputKind: descriptor.capabilities.includes("video")
        ? "video"
        : "image",
    });
    return { id: promptId };
  }

  private getWorkflowGraph(descriptor: ComfyDescriptor, timeoutMs: number): Promise<JsonRecord> {
    const existing = this.workflowGraphs.get(descriptor.comfyWorkflow.id);
    if (existing) return existing;
    const syncing = this.workflowSync({ apiUrl: this.apiUrl, descriptor, timeoutMs });
    this.workflowGraphs.set(descriptor.comfyWorkflow.id, syncing);
    void syncing.catch(() => this.workflowGraphs.delete(descriptor.comfyWorkflow.id));
    return syncing;
  }

  async poll(handle: BackendHandle): Promise<BackendResult> {
    const pending = this.pending.get(handle.id);
    const timeoutMs = pending?.timeoutMs ?? 600_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await this.waitForOutput(handle.id, timeoutMs, controller.signal);
      const bytes = await this.fetchComfyOutput(output, controller.signal);
      const outputKind = pending?.outputKind ?? outputKindFromFilename(output.filename);
      let verifiedVideo;
      if (outputKind === "video") {
        try {
          verifiedVideo = await this.videoMediaProbe(bytes);
        } catch (error) {
          throw new BackendInvocationError(
            "backend_error",
            `Generated video verification failed for ${handle.id}: ${error instanceof Error ? error.message : String(error)}`,
            "post_submit",
            "definitive",
          );
        }
      } else {
        assertGeneratedImageSanity(Buffer.from(bytes), handle.id);
      }
      const dimensions = verifiedVideo ?? pngDimensions(bytes) ?? {
        width: numberSlot(pending?.slots, "width") ?? 0,
        height: numberSlot(pending?.slots, "height") ?? 0,
      };
      return {
        assets: [
          {
            body: bytes,
            width: dimensions.width,
            height: dimensions.height,
            contentType:
              outputKind === "video" ? "video/mp4" : "image/png",
            ...(verifiedVideo ? { verifiedVideo } : {}),
          },
        ],
      };
    } catch (error) {
      if (error instanceof BackendInvocationError) throw error;
      throw new BackendInvocationError(
        error instanceof Error &&
            (error.name === "AbortError" || /timed out/i.test(error.message))
          ? "timeout"
          : "backend_error",
        error instanceof Error ? error.message : String(error),
        "post_submit",
        "ambiguous",
      );
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

  // SPEC: image-type descriptor slots (e.g. LoadImage nodes) take a ComfyUI-side
  // filename, not raw bytes. Bind references by their declared semantic role;
  // array order is never authority because source and identity may intentionally
  // point at the same physical asset.
  // INTENT: the descriptor/reference cardinality and role mapping must be exact.
  // Missing, extra, or ambiguous references fail before any prompt is submitted.
  private async bindReferenceImageSlots(job: ResolvedGenJob): Promise<ResolvedGenJob["slots"]> {
    if (job.descriptor.backendKind !== "comfyui") {
      throw new Error(
        `comfyui: workflow ${job.descriptor.workflowKey} targets ${job.descriptor.backendKind}`,
      );
    }
    const descriptor = job.descriptor;
    const imageSlots = descriptor.inputs.filter((slot) => slot.type === "image");
    const referenceImages = job.referenceImages ?? [];
    const slotAuthority = assignWorkflowReferenceSlots(
      descriptor,
      referenceImages.map((reference) => reference.role),
    );
    if (
      !slotAuthority.ok &&
      slotAuthority.reason === "reference_cardinality_mismatch"
    ) {
      const cardinality = slotAuthority.minReferences === slotAuthority.maxReferences
        ? String(slotAuthority.maxReferences)
        : `${slotAuthority.minReferences}-${slotAuthority.maxReferences}`;
      throw new Error(
        `workflow ${descriptor.workflowKey} requires ${cardinality} semantic image references but received ${referenceImages.length}`,
      );
    }
    if (!slotAuthority.ok) {
      throw new Error(
        `workflow ${descriptor.workflowKey} cannot assign reference roles ${referenceImages.map((reference) => reference.role).join(",")} to its semantic image slots`,
      );
    }
    if (imageSlots.length === 0) return job.slots;
    const assignments = new Map<string, ReferenceImage>(
      slotAuthority.assignments.map((assignment) => [
        assignment.slotKey,
        referenceImages[assignment.referenceIndex]!,
      ]),
    );
    const uploaded: ResolvedGenJob["slots"] = {};
    for (let i = 0; i < imageSlots.length; i++) {
      const reference = assignments.get(imageSlots[i].key);
      if (!reference && imageSlots[i].required === false) continue;
      if (!reference) {
        throw new Error(
          `workflow ${descriptor.workflowKey} image slot ${imageSlots[i].key} was not bound`,
        );
      }
      const bytes = await this.referenceImageBytes(reference, job.timeoutMs);
      const image = await this.uploadImage(
        bytes,
        `${job.requestId ?? "ref"}-${i}.png`,
        reference.contentType,
        job.timeoutMs,
      );
      uploaded[imageSlots[i].key] = image.subfolder ? `${image.subfolder}/${image.name}` : image.name;
    }
    return { ...job.slots, ...uploaded };
  }

  private async referenceImageBytes(reference: ReferenceImage, timeoutMs: number): Promise<Uint8Array> {
    if (reference.b64Json) return new Uint8Array(Buffer.from(reference.b64Json, "base64"));
    if (reference.url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(reference.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`failed to fetch reference image ${reference.assetId}: HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`fetching reference image ${reference.assetId} timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    // storageKey-only references carry no bytes we can resolve from inside the
    // backend — the caller (pipeline) is expected to inline b64Json or a fetchable
    // url before reaching here.
    throw new Error(
      `reference image ${reference.assetId} has no b64Json or url — ComfyUIBackend cannot resolve storageKey-only references`,
    );
  }

  private async uploadImage(
    bytes: Uint8Array,
    filename: string,
    contentType: string | undefined,
    timeoutMs: number,
  ): Promise<UploadedImage> {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: contentType ?? "image/png" }), filename);
    form.append("overwrite", "true");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/upload/image`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`ComfyUI /upload/image timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`ComfyUI /upload/image HTTP ${response.status}`);
    const json = (await response.json().catch(() => null)) as JsonRecord | null;
    const name = json ? stringField(json, "name") : undefined;
    if (!json || !name) throw new Error(`ComfyUI /upload/image returned malformed response: ${JSON.stringify(json)}`);
    return { name, subfolder: stringField(json, "subfolder") ?? "", type: stringField(json, "type") ?? "input" };
  }

  private async waitForOutput(
    promptId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ComfyImageOutput> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (signal.aborted) break;
      const response = await fetch(`${this.apiUrl}/history/${encodeURIComponent(promptId)}`, { signal });
      const history = (await response.json().catch(() => ({}))) as JsonRecord;
      if (!response.ok) {
        throw new BackendInvocationError(
          "backend_error",
          `ComfyUI /history HTTP ${response.status}`,
          "post_submit",
          "ambiguous",
        );
      }
      const item = jsonRecord(history[promptId]);
      const status = jsonRecord(item.status);
      if (status.status_str === "error") {
        throw new BackendInvocationError(
          "backend_error",
          `ComfyUI prompt failed: ${JSON.stringify(status.messages ?? status)}`,
          "post_submit",
          "definitive",
        );
      }
      if (status.completed === true) {
        const output = firstImageOutput(item);
        if (!output) {
          throw new BackendInvocationError(
            "backend_error",
            `ComfyUI prompt ${promptId} completed without media output`,
            "post_submit",
            "definitive",
          );
        }
        return output;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new BackendInvocationError(
      "timeout",
      `ComfyUI prompt timed out after ${timeoutMs}ms: ${promptId}`,
      "post_submit",
      "ambiguous",
    );
  }

  private async fetchComfyOutput(image: ComfyImageOutput, signal: AbortSignal): Promise<Uint8Array> {
    const url = new URL(`${this.apiUrl}/view`);
    url.searchParams.set("filename", image.filename);
    url.searchParams.set("subfolder", image.subfolder);
    url.searchParams.set("type", image.type);
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new BackendInvocationError(
        "backend_error",
        `ComfyUI /view HTTP ${response.status}`,
        "post_submit",
        "ambiguous",
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function outputKindFromFilename(filename: string): "image" | "video" {
  return filename.toLowerCase().endsWith(".mp4") ? "video" : "image";
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
