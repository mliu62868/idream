// SPEC: SdcppBackend — GenBackend impl running sd-cli as a synchronous one-shot process
// (ported from sdcpp-openai-image-server.ts's runSdcpp + buildSdcppArgs, stripped of the
// OpenAI-route wrapper). Workflow binding goes through bindSdcppArgs(descriptor, slots)
// instead of the hardcoded buildSdcppArgs, and reference-image argv is reused verbatim
// from sdcpp-reference-images.ts.
// INTENT: sd-cli generates one image per process invocation with no separate submit/poll
// phases (unlike ComfyUI's queue). To keep the GenBackend interface uniform across
// backends, submit() does all the work synchronously (spawn → read PNG → sanity check)
// and stashes the result in an in-memory map keyed by a generated handle id; poll() just
// looks it up. health() checks the sd-cli binary is executable.
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertGeneratedImageSanity } from "../generated-image-sanity";
import { env } from "../env";
import { logger } from "../logger";
import {
  cleanupSdcppReferenceImages,
  materializeSdcppReferenceImages,
  sdcppReferenceArgs,
  type MaterializedSdcppReferenceImage,
  type SdcppReferenceImage,
  type SdcppReferenceMode,
} from "../sdcpp-reference-images";
import { bindSdcppArgs } from "./workflow";
import type {
  BackendHandle,
  BackendHealth,
  BackendResult,
  Capabilities,
  GenBackend,
  ResolvedGenJob,
} from "./types";

const DEFAULT_REFERENCE_MODE: SdcppReferenceMode = "auto";
const DEFAULT_REFERENCE_STRENGTH = 0.62;
// Bound stdout/stderr buffering so a runaway/chatty sd-cli process can't grow
// the error-message string unboundedly while we wait for it to exit.
const MAX_LOG_CHARS = 16_000;

export class SdcppBackend implements GenBackend {
  readonly id = "sdcpp";
  readonly kind = "sdcpp" as const;

  private readonly cli: string;
  private readonly outputDir: string;
  private readonly referenceMode: SdcppReferenceMode;
  private readonly referenceStrength: number;
  // SPEC: submit() runs sd-cli to completion and stores the finished result here;
  // poll() only ever reads from this map. Entries are removed once poll() consumes
  // them so the map doesn't grow unbounded across the process lifetime.
  private readonly results = new Map<string, BackendResult>();

  constructor(opts: {
    cli: string;
    outputDir?: string;
    referenceMode?: SdcppReferenceMode;
    referenceStrength?: number;
  }) {
    this.cli = opts.cli;
    this.outputDir = opts.outputDir ?? path.resolve(process.cwd(), ".tmp/sdcpp-backend");
    this.referenceMode = opts.referenceMode ?? DEFAULT_REFERENCE_MODE;
    this.referenceStrength = opts.referenceStrength ?? DEFAULT_REFERENCE_STRENGTH;
  }

  capabilities(): Capabilities {
    return {
      textToImage: true,
      img2img: false,
      referenceImages: true,
      stableSeed: true,
      edit: false,
    };
  }

  async submit(job: ResolvedGenJob): Promise<BackendHandle> {
    const id = randomUUID();
    await mkdir(this.outputDir, { recursive: true });
    const outputPath = path.join(this.outputDir, `${id}.png`);
    const referenceImages = await materializeSdcppReferenceImages({
      images: toSdcppReferenceImages(job.referenceImages),
      dir: path.join(this.outputDir, "references"),
    });
    try {
      const args = buildArgs(job, outputPath, referenceImages, this.referenceMode, this.referenceStrength);
      await this.runSdcpp(args, job.timeoutMs ?? env.PIPELINE_TIMEOUT_MS);
      const image = await readFile(outputPath);
      assertGeneratedImageSanity(image, `sdcpp ${job.descriptor.workflowKey} ${id}`);
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
      await cleanupSdcppReferenceImages(referenceImages);
    }
  }

  async poll(handle: BackendHandle): Promise<BackendResult> {
    const result = this.results.get(handle.id);
    if (!result) throw new Error(`sdcpp: no cached result for handle ${handle.id}`);
    this.results.delete(handle.id);
    return result;
  }

  async health(): Promise<BackendHealth> {
    try {
      await access(this.cli, fsConstants.X_OK);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private runSdcpp(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const child = spawn(this.cli, args, {
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });
      let stderr = "";
      let stdout = "";
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (error instanceof Error && error.name === "AbortError") {
          reject(new Error(`sd-cli timed out after ${timeoutMs}ms`));
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        logger.warn({ cli: this.cli, args, code, stderr, stdout }, "sd-cli exited non-zero");
        reject(new Error(`sd-cli exited with ${code ?? "unknown"}\n${stderr || stdout}`.trim()));
      });
    });
  }
}

function buildArgs(
  job: ResolvedGenJob,
  outputPath: string,
  referenceImages: MaterializedSdcppReferenceImage[],
  mode: SdcppReferenceMode,
  strength: number,
): string[] {
  return [
    ...bindSdcppArgs(job.descriptor, job.slots),
    "--output",
    outputPath,
    ...sdcppReferenceArgs({ images: referenceImages, mode, strength }),
  ];
}

function toSdcppReferenceImages(images: ResolvedGenJob["referenceImages"]): SdcppReferenceImage[] {
  if (!images) return [];
  return images.map((image) => ({
    role: image.role,
    ...(image.assetId ? { assetId: image.assetId } : {}),
    ...(image.weight !== undefined ? { weight: image.weight } : {}),
    ...(image.b64Json ? { b64Json: image.b64Json } : {}),
    ...(image.url ? { url: image.url } : {}),
    ...(image.contentType ? { contentType: image.contentType } : {}),
  }));
}

// SPEC: fall back to the PNG IHDR chunk for width/height when the job's slots don't
// carry explicit dimensions (mirrors ComfyUIBackend's pngDimensions helper).
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function numberSlot(slots: ResolvedGenJob["slots"], key: string): number | undefined {
  const value = slots[key];
  return typeof value === "number" ? value : undefined;
}

function appendBounded(current: string, next: string) {
  const combined = current + next;
  return combined.length > MAX_LOG_CHARS ? combined.slice(-MAX_LOG_CHARS) : combined;
}
