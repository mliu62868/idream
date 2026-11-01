import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { IMAGE_RECOLOR_ALGORITHM, recolorRgba } from "@idream/shared/media/image-recolor";
import type { BackendHandle, BackendResult, Capabilities, GenBackend, ResolvedGenJob } from "./types";

/** One local pixel operation, exposed through the existing one-shot backend contract. */
export class LocalImageBackend implements GenBackend {
  readonly id = "local-image";
  readonly kind = "local-image" as const;
  private readonly results = new Map<string, BackendResult>();

  capabilities(): Capabilities {
    return { textToImage: false, img2img: true, referenceImages: true, stableSeed: false, edit: true };
  }

  async submit(job: ResolvedGenJob): Promise<BackendHandle> {
    const edit = job.localRecolor;
    if (job.descriptor.backendKind !== this.kind || job.descriptor.localImage.operation !== "recolor" || !edit ||
        edit.width * edit.height !== edit.mask.length) throw new Error("Local recolor requires a validated confirmed region");
    const started = performance.now();
    const pixels = recolorRgba({ pixels: edit.sourceRgba, mask: edit.mask, color: edit.color });
    const body = await sharp(pixels, { raw: { width: edit.width, height: edit.height, channels: 4 } }).png().toBuffer();
    const id = randomUUID();
    this.results.set(id, {
      assets: [{ body, width: edit.width, height: edit.height, contentType: "image/png" }],
      invocation: { providerRequestId: null, costMicros: 0, pricingVersion: "local-image-no-provider-fee-1",
        usage: { executionId: id, executionKind: "local_pixel_operation", algorithm: IMAGE_RECOLOR_ALGORITHM,
          operation: "recolor", operations: 1, modelInvocations: 0, externalRequests: 0,
          totalPixels: edit.mask.length, selectedPixels: edit.mask.reduce((count, value) => count + Number(value === 255), 0),
          cpuElapsedMs: performance.now() - started, infrastructureCostMicros: null } },
    });
    return { id };
  }

  async poll(handle: BackendHandle): Promise<BackendResult> {
    const result = this.results.get(handle.id);
    if (!result) throw new Error("Local image execution result is unavailable");
    this.results.delete(handle.id);
    return result;
  }

  async health() { return { ok: true, detail: "In-process CPU image operations; no model or external endpoint" }; }
}
