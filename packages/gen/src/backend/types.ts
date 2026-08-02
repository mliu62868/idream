// SPEC: GenBackend 契约 — 生图后端统一接口。上层(pipeline)只认这层契约，
// 不关心具体后端如何提交/轮询/取图。
// INTENT: submit/poll 分离以支持异步长耗时生成；health 用于就绪探针。
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import type { SlotValues, WorkflowBackendKind, WorkflowDescriptor } from "./workflow";
import type { VerifiedVideoMedia } from "./video-media-probe";

export interface Capabilities {
  textToImage: boolean;
  img2img: boolean;
  referenceImages: boolean;
  stableSeed: boolean;
  edit: boolean;
}

export interface ResolvedGenJob {
  descriptor: WorkflowDescriptor;
  slots: SlotValues;
  referenceImages?: NonNullable<ImageGeneratePayload["referenceImages"]>;
  requestId?: string;
  timeoutMs: number;
}

export interface BackendAsset {
  body: Uint8Array;
  width: number;
  height: number;
  contentType: string;
  verifiedVideo?: VerifiedVideoMedia;
}
export interface BackendResult { assets: BackendAsset[] }
export type BackendHandle = { id: string };
export interface BackendHealth { ok: boolean; detail?: string }

export type BackendInvocationPhase = "pre_submit" | "post_submit";
export type BackendInvocationOutcome = "definitive" | "ambiguous";

// SPEC: Backend adapters preserve whether a provider request was definitely
// rejected or may already be running. Callers use this fact to decide failed
// versus unknown; string matching on timeout messages is not authority.
export class BackendInvocationError extends Error {
  constructor(
    readonly code: "backend_error" | "timeout",
    message: string,
    readonly phase: BackendInvocationPhase,
    readonly outcome: BackendInvocationOutcome,
  ) {
    super(message);
    this.name = "BackendInvocationError";
  }
}

export interface GenBackend {
  readonly id: string;
  readonly kind: WorkflowBackendKind;
  capabilities(): Capabilities;
  submit(job: ResolvedGenJob): Promise<BackendHandle>;
  poll(handle: BackendHandle): Promise<BackendResult>;
  health(): Promise<BackendHealth>;
}
