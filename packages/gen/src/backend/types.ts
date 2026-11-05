// SPEC: GenBackend 契约 — 生图后端统一接口。上层(pipeline)只认这层契约，
// 不关心具体后端如何提交/轮询/取图。
// INTENT: submit/poll 分离以支持异步长耗时生成；health 用于就绪探针。
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import type { SlotValues, WorkflowBackendKind, WorkflowDescriptor } from "./workflow";
import type { VerifiedVideoMedia } from "./video-media-probe";
import type { ProviderInvocationMetadata } from "../providers";

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
  /** Gen-produced region evidence, separate from Character reference identity. */
  localEditMask?: Uint8Array;
  /** Validated, confirmed CPU operation; never interpreted as a model prompt. */
  localRecolor?: { sourceRgba: Uint8Array; mask: Uint8Array; width: number; height: number; color: string };
  requestId?: string;
  timeoutMs: number;
  /**
   * Deterministic runner prompt id. A backend with `findPriorSubmission` must
   * submit under it, or a later retry cannot find this submission.
   */
  promptId?: string;
}

export interface BackendAsset {
  body: Uint8Array;
  width: number;
  height: number;
  contentType: string;
  verifiedVideo?: VerifiedVideoMedia;
}
export interface BackendPerformance {
  prepareMs: number;
  submitMs: number;
  // Includes provider queueing, execution and polling; do not add executionMs to it.
  waitMs: number;
  downloadMs: number;
  validationMs: number;
  // Provider-local timestamps include model loading. Missing evidence stays null.
  providerExecutionMs: number | null;
  cachedNodeCount: number | null;
}
export interface BackendResult {
  assets: BackendAsset[];
  performance?: BackendPerformance;
  invocation?: ProviderInvocationMetadata;
}
export type BackendHandle = { id: string };
// SPEC: what the runner knows about a submission made by an earlier transport.
// "present" covers finished, failed, queued and running alike: poll() on the
// handle collects the output, reports the failure or waits within its budgets.
export type BackendPriorSubmission =
  | { readonly state: "present"; readonly handle: BackendHandle }
  | { readonly state: "gone"; readonly failure: BackendInvocationError };
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
    // A runner losing or cancelling a prompt says nothing about its input, so a
    // new request can succeed. A prompt ComfyUI itself rejected stays not_retryable.
    private readonly independentOfInput = false,
  ) {
    super(message);
    this.name = "BackendInvocationError";
  }

  /** May the same input reasonably succeed in a fresh request? */
  get retryable(): boolean {
    return this.outcome === "ambiguous" || this.phase === "pre_submit" || this.independentOfInput;
  }
}

export interface GenBackend {
  readonly id: string;
  readonly kind: WorkflowBackendKind;
  capabilities(): Capabilities;
  submit(job: ResolvedGenJob): Promise<BackendHandle>;
  poll(handle: BackendHandle): Promise<BackendResult>;
  health(): Promise<BackendHealth>;
  /**
   * Optional: only a backend whose runner keeps a queryable record of prompts
   * submitted under a client-chosen id implements this. Without it an interrupted
   * invocation stays unknown, because nothing can say what became of it.
   * INVARIANT: never submits. A runner that cannot be reached rejects with an
   * ambiguous BackendInvocationError; silence is not evidence the prompt is gone.
   */
  findPriorSubmission?(input: {
    promptId: string;
    timeoutMs: number;
    outputKind: "image" | "video";
  }): Promise<BackendPriorSubmission>;
}
