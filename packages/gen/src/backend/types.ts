// SPEC: GenBackend 契约 — 生图后端统一接口。上层(pipeline)只认这层契约，
// 不关心具体后端如何提交/轮询/取图。
// INTENT: submit/poll 分离以支持异步长耗时生成；health 用于就绪探针。
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import type { SlotValues, WorkflowBackendKind, WorkflowDescriptor } from "./workflow";

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
}
export interface BackendResult { assets: BackendAsset[] }
export type BackendHandle = { id: string };
export interface BackendHealth { ok: boolean; detail?: string }

export interface GenBackend {
  readonly id: string;
  readonly kind: WorkflowBackendKind;
  capabilities(): Capabilities;
  submit(job: ResolvedGenJob): Promise<BackendHandle>;
  poll(handle: BackendHandle): Promise<BackendResult>;
  health(): Promise<BackendHealth>;
}
