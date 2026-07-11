// SPEC: DrawThingsBackend runs the official draw-things-cli as a one-shot
// generation process and exposes it through the existing GenBackend seam.
// INTENT: Keep Draw Things process/model/temp-file knowledge out of queue and
// ImageModel callers. submit() completes generation and caches one result; poll()
// consumes it, matching the synchronous SdcppBackend adapter shape.
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveExecutable } from "@idream/shared";
import { assertGeneratedImageSanity } from "../generated-image-sanity";
import { logger } from "../logger";
import {
  cleanupGenerationReferenceImages,
  materializeGenerationReferenceImages,
  type GenerationReferenceImage,
  type MaterializedGenerationReferenceImage,
} from "../generation-reference-images";
import { bindWorkflowArgs } from "./workflow";
import type {
  BackendHandle,
  BackendHealth,
  BackendResult,
  Capabilities,
  GenBackend,
  ResolvedGenJob,
} from "./types";

const DEFAULT_STRENGTH = 0.62;
const MAX_LOG_CHARS = 16_000;

export class DrawThingsBackend implements GenBackend {
  readonly id = "drawthings";
  readonly kind = "drawthings" as const;

  private readonly cli: string;
  private readonly modelsDir?: string;
  private readonly outputDir: string;
  private readonly offline: boolean;
  private readonly results = new Map<string, BackendResult>();
  private generationTail: Promise<void> = Promise.resolve();

  constructor(opts: {
    cli: string;
    modelsDir?: string;
    outputDir?: string;
    offline?: boolean;
  }) {
    this.cli = opts.cli;
    this.modelsDir = opts.modelsDir;
    this.outputDir = opts.outputDir ?? path.resolve(process.cwd(), ".tmp/drawthings-backend");
    this.offline = opts.offline ?? true;
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
    const previous = this.generationTail;
    let release = () => {};
    this.generationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.submitOnce(job);
    } finally {
      release();
    }
  }

  private async submitOnce(job: ResolvedGenJob): Promise<BackendHandle> {
    if (job.descriptor.backendKind !== "drawthings") {
      throw new Error(
        `drawthings: workflow ${job.descriptor.workflowKey} targets ${job.descriptor.backendKind}`,
      );
    }

    const references = drawThingsReferences(job.referenceImages);
    if (references.some((image) => image.role !== "source_image") || references.length > 1) {
      throw new Error("drawthings: version 1 accepts at most one source_image reference");
    }

    const id = randomUUID();
    await mkdir(this.outputDir, { recursive: true });
    const outputPath = path.join(this.outputDir, `${id}.png`);
    const referenceDir = path.join(this.outputDir, "references", id);
    let materialized: MaterializedGenerationReferenceImage[] = [];
    try {
      materialized = await materializeGenerationReferenceImages({
        images: references,
        dir: referenceDir,
        timeoutMs: job.timeoutMs,
      });
      const args = this.commandArgs(job, job.descriptor, outputPath, materialized[0]);
      await this.runCli(args, job.timeoutMs);
      const image = await readFile(outputPath);
      assertGeneratedImageSanity(image, `drawthings ${job.descriptor.workflowKey} ${id}`);
      const dimensions = pngDimensions(image) ?? {
        width: numberSlot(job.slots, "width") ?? 0,
        height: numberSlot(job.slots, "height") ?? 0,
      };
      this.results.set(id, {
        assets: [
          {
            body: new Uint8Array(image),
            width: dimensions.width,
            height: dimensions.height,
            contentType: "image/png",
          },
        ],
      });
      return { id };
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
      await cleanupGenerationReferenceImages(materialized);
      await rm(referenceDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async poll(handle: BackendHandle): Promise<BackendResult> {
    const result = this.results.get(handle.id);
    if (!result) throw new Error(`drawthings: no cached result for handle ${handle.id}`);
    this.results.delete(handle.id);
    return result;
  }

  async health(): Promise<BackendHealth> {
    try {
      await resolveExecutable(this.cli);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private commandArgs(
    job: ResolvedGenJob,
    descriptor: Extract<ResolvedGenJob["descriptor"], { backendKind: "drawthings" }>,
    outputPath: string,
    sourceImage: MaterializedGenerationReferenceImage | undefined,
  ) {
    return [
      "generate",
      "--model",
      descriptor.drawThings.model,
      ...(this.modelsDir ? ["--models-dir", this.modelsDir] : []),
      ...bindWorkflowArgs(descriptor, job.slots),
      ...(sourceImage
        ? ["--image", sourceImage.path, "--strength", String(strengthSlot(job.slots))]
        : []),
      ...(this.offline ? ["--no-download-missing", "--offline"] : []),
      "--output",
      outputPath,
    ];
  }

  private runCli(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const child = spawn(this.cli, args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });
      let stderr = "";
      let stdout = "";
      let settled = false;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        if (error instanceof Error && error.name === "AbortError") {
          finish(new Error(`draw-things-cli timed out after ${timeoutMs}ms`));
          return;
        }
        finish(error instanceof Error ? error : new Error(String(error)));
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code === 0) {
          finish();
          return;
        }
        logger.warn({ cli: this.cli, args, code, stderr, stdout }, "draw-things-cli exited non-zero");
        finish(
          new Error(`draw-things-cli exited with ${code ?? "unknown"}\n${stderr || stdout}`.trim()),
        );
      });
    });
  }
}

function drawThingsReferences(images: ResolvedGenJob["referenceImages"]): GenerationReferenceImage[] {
  return (images ?? []).map((image) => ({
    role: image.role,
    ...(image.assetId ? { assetId: image.assetId } : {}),
    ...(image.weight !== undefined ? { weight: image.weight } : {}),
    ...(image.b64Json ? { b64Json: image.b64Json } : {}),
    ...(image.url ? { url: image.url } : {}),
    ...(image.contentType ? { contentType: image.contentType } : {}),
  }));
}

function strengthSlot(slots: ResolvedGenJob["slots"]) {
  const value = numberSlot(slots, "strength") ?? DEFAULT_STRENGTH;
  return Math.min(0.95, Math.max(0.05, value));
}

function numberSlot(slots: ResolvedGenJob["slots"], key: string): number | undefined {
  const value = slots[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function appendBounded(current: string, next: string) {
  const combined = current + next;
  return combined.length > MAX_LOG_CHARS ? combined.slice(-MAX_LOG_CHARS) : combined;
}
