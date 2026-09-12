// SPEC: One image/video generation attempt has one transport identity and one
// durable terminal record. Any retry that would invoke the provider again is
// allowed only when the model explicitly guarantees deterministic idempotency.
// INTENT: Keep lifecycle authority here; modality adapters invoke providers and
// normalize persisted artifacts without knowing ACK/retry/transport mechanics.
//
// SPEC: `runGeneration` is the entry point. A modality supplies only what
// differs — which configured adapter it must match, how to prepare its inputs,
// which model to invoke, and how to normalize what comes back.
//
// INTENT: the order used to be the caller's problem, and both callers had to get
// four unwritten rules right: a resumed terminal record means return immediately;
// anything thrown while preparing must go through `failPreparation` (which reads
// the invocation guard to decide unknown vs preparation_failed); blocked
// moderation goes through `block("input")`; nothing may touch the provider before
// `execute`. None of that was in this file's header — it could only be recovered
// by reading the image path and the video path and diffing them. They were
// diffable: normalised for the image/video literals, the two preambles differed
// by three lines. Now the sequence exists once, and a modality cannot express a
// wrong order because it never states one.
import { generationProviderIdempotencyKey } from "@idream/shared/contracts";
import type {
  GenerationTerminalRecord,
  GenerationTerminalRecordIngest,
  GenerationTransportExecutionEvent,
  ImageGeneratePayload,
  VideoGeneratePayload,
} from "@idream/shared/contracts";
import type {
  BlobStore,
  ImageModel,
  GenerationInvocationBoundary,
  ProviderFailure,
  ProviderInvocationMetadata,
  ModerationProvider,
  ProviderResult,
  VideoModel,
} from "./providers";
import { hydratedImageReferenceInputs } from "./reference-images";
import { workerAdapterForRecordedProvider } from "./provider-vocabulary";
import {
  loadPersistedTerminalRecord,
  loadGenerationInvocationGuard,
  persistTerminalRecord,
  reserveGenerationInvocation,
} from "./terminal-record";
import { env } from "./env";

type GenerationPayload = ImageGeneratePayload | VideoGeneratePayload;
type GenerationModel = ImageModel | VideoModel;
type SucceededTerminalRecord = Extract<
  GenerationTerminalRecord,
  { outcome: "succeeded" }
>;
type TerminalRetryability = Extract<
  GenerationTerminalRecord,
  { outcome: "failed" | "unknown" }
>["error"]["retryability"];

export type GenerationExecutionPorts = {
  // This ACK means the independent terminal relay durably accepted the row;
  // it is deliberately not an HTTP ACK from Main's business projection.
  acknowledgeTerminalRecord: (
    input: GenerationTerminalRecordIngest,
  ) => Promise<void>;
  recordTransportExecution: (
    input: GenerationTransportExecutionEvent,
  ) => Promise<void>;
};

type GenerationExecutionOptions = GenerationExecutionPorts & {
  payload: GenerationPayload;
  provider: string;
  blob: BlobStore;
  attemptsMade?: number;
  maxAttempts?: number;
};

type TerminalEvidence = {
  readonly providerRequestId?: string | null;
  readonly accounting?: ReturnType<typeof invocationAccounting>;
  readonly providerInvoked?: boolean;
  readonly providerReplayIsSafe?: boolean;
};

type NormalizedGeneration = {
  assets: SucceededTerminalRecord["assets"];
  usage: Readonly<Record<string, unknown>>;
};

type GenerationAdapter<TProviderOutput> = {
  model: GenerationModel;
  invoke: (input: {
    providerIdempotencyKey: string;
    executionBoundary?: GenerationInvocationBoundary;
  }) => Promise<ProviderResult<TProviderOutput>>;
  normalizeArtifacts: (
    output: TProviderOutput,
  ) => Promise<NormalizedGeneration>;
};

export class GenerationArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryBeforeFinalAttempt: boolean,
  ) {
    super(message);
    this.name = "GenerationArtifactError";
  }
}

// INTENT: not exported. Every one of its methods has to be called in a fixed
// order, and both call sites used to know that order. `runGeneration` below is
// now the only thing that can construct one, so the order is a property of this
// file rather than a rule the next caller has to rediscover from the diff
// between the image path and the video path.
class GenerationExecution {
  readonly #identity;

  constructor(private readonly options: GenerationExecutionOptions) {
    const attemptId = options.payload.attemptId;
    this.#identity = {
      attemptId,
      attemptNo: options.payload.attemptNo,
      transportAttemptNo: (options.attemptsMade ?? 0) + 1,
      idempotencyKey: generationProviderIdempotencyKey(attemptId),
    };
  }

  async resumeTerminalRecord(): Promise<boolean> {
    const persisted = await loadPersistedTerminalRecord(
      this.options.blob,
      this.#identity.attemptId,
    );
    if (!persisted) return false;
    const record = persisted.terminalRecord;
    if (
      record.attemptId !== this.#identity.attemptId ||
      record.generationJobId !== this.options.payload.generationJobId ||
      record.requestId !== this.options.payload.requestId ||
      record.mode !== this.options.payload.kind
    ) {
      throw new Error(
        `terminal record identity mismatch for ${this.#identity.attemptId}`,
      );
    }
    await this.options.acknowledgeTerminalRecord(persisted);
    return true;
  }

  async fail(
    code: string,
    message: string,
    terminal: {
      outcome?: "failed" | "unknown";
      retryability?: TerminalRetryability;
    } = {},
    evidence: TerminalEvidence = {},
  ): Promise<void> {
    await this.persistAndAcknowledge({
      ...this.terminalRecordBase(evidence),
      outcome: terminal.outcome ?? "failed",
      error: {
        code,
        message,
        retryability: terminal.retryability ?? "retryable",
      },
    }, evidence.providerReplayIsSafe);
  }

  async block(
    policyCode: string,
    message: string,
    layer: "input" | "output" | "provider",
    evidence: TerminalEvidence = {},
  ): Promise<void> {
    await this.persistAndAcknowledge({
      ...this.terminalRecordBase(evidence),
      outcome: "blocked",
      block: { policyCode, message, layer },
    }, evidence.providerReplayIsSafe);
  }

  async failPreparation(error: unknown): Promise<void> {
    if (!this.isFinalAttempt()) throw error;
    // A preparation error on a later transport must not erase a prior call,
    // including one made by a provider with deterministic replay support.
    const guard = await loadGenerationInvocationGuard(this.options.blob, this.#identity.attemptId);
    if (guard) {
      const expected = this.invocationGuard();
      if (
        guard.attemptId !== expected.attemptId || guard.attemptNo !== expected.attemptNo ||
        guard.requestId !== expected.requestId || guard.generationJobId !== expected.generationJobId ||
        guard.providerIdempotencyKey !== expected.providerIdempotencyKey ||
        guard.mode !== expected.mode || guard.provider !== expected.provider || guard.model !== expected.model ||
        guard.transportAttemptNo >= expected.transportAttemptNo
      ) throw new Error(`provider invocation cannot be excluded for ${expected.attemptId}`);
      await this.fail(
        "ambiguous_incomplete_provider_invocation",
        "A prior provider invocation did not leave terminal evidence before retry preparation failed",
        { outcome: "unknown", retryability: "not_retryable" },
        { providerInvoked: true, providerReplayIsSafe: false },
      );
      return;
    }
    await this.fail(
      "preparation_failed",
      error instanceof Error ? error.message : "Generation input preparation failed",
      { retryability: "retryable" },
      { providerInvoked: false },
    );
  }

  async execute<TProviderOutput>(
    adapter: GenerationAdapter<TProviderOutput>,
  ): Promise<void> {
    const providerReplayIsSafe =
      adapter.model.retryCapabilities?.deterministicIdempotencyKey === true;
    let invocationStartedAt: number | undefined;
    let boundaryError: unknown;
    let terminalSettled = false;
    const beforeProviderInvocation = async () => {
      try {
        if (invocationStartedAt !== undefined) throw new Error("Provider invocation boundary entered twice");
        // INVARIANT: waiting for a device creates neither provider authority nor
        // an invocation guard. Recheck Main after acquiring it, before submission.
        await this.recordTransport("running");
        const reservation = await reserveGenerationInvocation(this.options.blob, this.invocationGuard());
        if (!providerReplayIsSafe && !reservation.created) {
          if (reservation.guard.transportAttemptNo >= this.#identity.transportAttemptNo) {
            throw new Error(`provider invocation is already reserved for ${this.#identity.attemptId}`);
          }
          await this.fail(
            "ambiguous_incomplete_provider_invocation",
            "A prior non-replayable provider invocation did not leave terminal evidence",
            { outcome: "unknown", retryability: "not_retryable" },
            { providerInvoked: true, providerReplayIsSafe: false },
          );
          terminalSettled = true;
          throw new Error("Prior provider invocation requires reconciliation");
        }
        invocationStartedAt = performance.now();
      } catch (error) {
        boundaryError = error;
        throw error;
      }
    };
    const executionBoundary: GenerationInvocationBoundary = {
      beforeProviderInvocation,
      onResourceWait: async () => {
        try {
          await this.recordTransport("waiting");
        } catch (error) {
          boundaryError = error;
          throw error;
        }
      },
    };
    if (!adapter.model.managesInvocationBoundary) {
      try { await beforeProviderInvocation(); } catch (error) {
        if (terminalSettled) return;
        throw error;
      }
    }
    const result = await adapter.invoke({
      providerIdempotencyKey: this.#identity.idempotencyKey,
      ...(adapter.model.managesInvocationBoundary ? { executionBoundary } : {}),
    });
    if (terminalSettled) return;
    // Backend adapters classify ordinary errors, but cannot turn a rejected Main
    // authority check into provider failure or overwrite existing terminal facts.
    if (boundaryError !== undefined) throw boundaryError;
    if (invocationStartedAt === undefined) {
      if (result.ok) throw new Error("Backend returned success without provider invocation authority");
      await this.failPreparation(new Error(result.error.message));
      return;
    }
    const invocationLatencyMs = performance.now() - invocationStartedAt;

    if (!result.ok) {
      await this.handleProviderFailure(
        adapter.model,
        result.error,
        result.invocation,
        invocationLatencyMs,
      );
      return;
    }

    let normalized: NormalizedGeneration;
    const artifactPersistenceStartedAt = performance.now();
    try {
      normalized = await adapter.normalizeArtifacts(result.data);
    } catch (error) {
      const artifactError = error instanceof GenerationArtifactError
        ? error
        : new GenerationArtifactError(
            "asset_persist_failed",
            error instanceof Error
              ? error.message
              : "Generated asset persistence failed",
            true,
          );
      // INVARIANT: provider success followed by a blob failure must not duplicate
      // an expensive non-idempotent generation on the next BullMQ attempt.
      if (
        artifactError.retryBeforeFinalAttempt &&
        providerReplayIsSafe &&
        !this.isFinalAttempt()
      ) {
        throw artifactError;
      }
      await this.fail(
        artifactError.code,
        artifactError.message,
        {
          retryability:
            artifactError.retryBeforeFinalAttempt && !providerReplayIsSafe
              ? "not_retryable"
              : "retryable",
        },
        {
          providerRequestId: result.invocation?.providerRequestId ?? null,
          accounting: invocationAccounting(result.invocation, invocationLatencyMs, {}, performance.now() - artifactPersistenceStartedAt),
          providerInvoked: true,
          providerReplayIsSafe,
        },
      );
      return;
    }

    const accounting = invocationAccounting(
      result.invocation,
      invocationLatencyMs,
      normalized.usage,
      performance.now() - artifactPersistenceStartedAt,
    );
    await this.persistAndAcknowledge({
      ...this.terminalRecordBase({
        providerRequestId: result.invocation?.providerRequestId ?? null,
        accounting,
        providerInvoked: true,
      }),
      outcome: "succeeded",
      assets: normalized.assets,
      usage: normalized.usage,
    }, providerReplayIsSafe);
  }

  private async handleProviderFailure(
    model: GenerationModel,
    error: ProviderFailure,
    invocation: ProviderInvocationMetadata | undefined,
    invocationLatencyMs: number,
  ): Promise<void> {
    const safeRetry = canAutomaticallyRetry(model, error);
    const ambiguous =
      error.outcome === "ambiguous" ||
      (
        error.retryable &&
        !safeRetry &&
        ["timeout", "internal"].includes(error.code)
      );
    const accounting = invocationAccounting(invocation, invocationLatencyMs);
    if (error.code === "content_blocked") {
      // INTENT: A provider policy decision completed the transport normally.
      // Main projects the durable blocked terminal record to transport
      // succeeded; writing failed here would create a failed -> succeeded race.
      await this.block(error.code, error.message, "provider", {
        providerRequestId: invocation?.providerRequestId ?? null,
        accounting,
        providerInvoked: true,
        providerReplayIsSafe:
          model.retryCapabilities?.deterministicIdempotencyKey === true,
      });
      return;
    }
    if (safeRetry && !this.isFinalAttempt()) {
      await this.recordTransport(
        "failed",
        error,
        accounting,
        invocation?.providerRequestId ?? null,
      );
      throw new Error(error.message);
    }
    const evidence = {
      providerRequestId: invocation?.providerRequestId ?? null,
      accounting,
      providerInvoked: true,
      providerReplayIsSafe:
        model.retryCapabilities?.deterministicIdempotencyKey === true,
    };
    if (ambiguous) {
      await this.fail(
        "ambiguous_non_replayable",
        error.message,
        { outcome: "unknown", retryability: "not_retryable" },
        evidence,
      );
      return;
    }
    await this.fail(
      error.code,
      error.message,
      { retryability: error.retryable ? "retryable" : "not_retryable" },
      evidence,
    );
  }

  private isFinalAttempt(): boolean {
    const attemptsMade = this.options.attemptsMade ?? 0;
    const maxAttempts = this.options.maxAttempts ?? 1;
    return attemptsMade + 1 >= maxAttempts;
  }

  private terminalRecordBase(evidence: TerminalEvidence) {
    const payload = this.options.payload;
    return {
      version: 1 as const,
      attemptId: this.#identity.attemptId,
      attemptNo: this.#identity.attemptNo,
      transportAttemptNo: this.#identity.transportAttemptNo,
      providerIdempotencyKey: this.#identity.idempotencyKey,
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: payload.kind,
      provider: this.options.provider,
      sourceRevision: env.SOURCE_REVISION?.trim() || null,
      providerInvoked: evidence.providerInvoked ?? false,
      model: payload.model,
      providerRequestId: evidence.providerRequestId ?? null,
      completedAt: new Date().toISOString(),
      usage: evidence.accounting?.usage ?? {},
      ...(evidence.accounting ? { accounting: evidence.accounting } : {}),
    };
  }

  private invocationGuard() {
    const payload = this.options.payload;
    return {
      version: 1 as const,
      attemptId: this.#identity.attemptId,
      attemptNo: this.#identity.attemptNo,
      transportAttemptNo: this.#identity.transportAttemptNo,
      providerIdempotencyKey: this.#identity.idempotencyKey,
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: payload.kind,
      provider: this.options.provider,
      model: payload.model ?? null,
      reservedAt: new Date().toISOString(),
    };
  }

  private async persistAndAcknowledge(
    terminalRecord: GenerationTerminalRecord,
    providerReplayIsSafe = true,
  ): Promise<void> {
    let ingest: GenerationTerminalRecordIngest;
    try {
      ingest = await persistTerminalRecord(this.options.blob, terminalRecord);
    } catch (error) {
      const canReplayBeforeFinalAttempt =
        terminalRecord.providerInvoked &&
        providerReplayIsSafe &&
        !this.isFinalAttempt();
      if (!terminalRecord.providerInvoked || canReplayBeforeFinalAttempt) {
        throw error;
      }
      // INVARIANT: once any provider invocation cannot be replayed safely, or
      // the deterministic route has exhausted its Bull attempts, terminal
      // storage failure must complete the Bull job as unknown. Throwing here
      // would either invoke the provider twice or strand the Attempt without a
      // terminal business fact after the final transport attempt.
      try {
        await this.recordTransport(
          "unknown",
          {
            code: "terminal_record_persist_failed",
            message: error instanceof Error
              ? error.message
              : "Generation terminal record persistence failed",
          },
          terminalRecord.accounting,
          terminalRecord.providerRequestId,
        );
      } catch (transportError) {
        throw new AggregateError(
          [error, transportError],
          `could not persist or record terminal evidence for ${terminalRecord.attemptId}`,
        );
      }
      return;
    }
    await this.options.acknowledgeTerminalRecord(ingest);
  }

  private async recordTransport(
    status: "waiting" | "running" | "failed" | "unknown",
    error: { code: string; message: string } | null = null,
    accounting?: ReturnType<typeof invocationAccounting>,
    providerRequestId: string | null = null,
  ): Promise<void> {
    const payload = this.options.payload;
    await this.options.recordTransportExecution({
      version: 1,
      ...this.#identity,
      generationJobId: payload.generationJobId,
      provider: this.options.provider,
      model: payload.model ?? this.options.provider,
      providerRequestId,
      status,
      occurredAt: new Date().toISOString(),
      error,
      ...(accounting ? { accounting } : {}),
    });
  }
}

function canAutomaticallyRetry(
  model: GenerationModel,
  error: ProviderFailure,
): boolean {
  const capabilities = model.retryCapabilities;
  return (
    error.retryable &&
    capabilities?.deterministicIdempotencyKey === true &&
    capabilities.retryableFailureCodes.includes(error.code)
  );
}

function invocationAccounting(
  invocation: ProviderInvocationMetadata | undefined,
  latencyMs: number,
  fallbackUsage: Readonly<Record<string, unknown>> = {},
  artifactPersistenceMs?: number,
) {
  const pricingVersion = invocation?.pricingVersion?.trim() || null;
  const providerCost = invocation?.costMicros;
  const costMicros =
    pricingVersion !== null &&
    Number.isSafeInteger(providerCost) &&
    (providerCost ?? -1) >= 0
      ? providerCost ?? null
      : null;
  const usage = { ...(invocation?.usage ?? fallbackUsage) };
  if (artifactPersistenceMs !== undefined) {
    const observed = usage.performance;
    usage.performance = {
      ...(typeof observed === "object" && observed !== null && !Array.isArray(observed) ? observed : {}),
      artifactPersistenceMs,
    };
  }
  return {
    usage,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    costMicros,
    pricingVersion,
  };
}

/**
 * What one modality has to say for itself. Everything absent here — resume,
 * moderation, the guard, transport, retry decisions, terminal persistence,
 * relay admission — belongs to `runGeneration` and is not a modality's concern.
 */
export type GenerationModality<TPrepared, TProviderOutput> = {
  readonly mode: "image" | "video";
  /** `GEN_IMAGE_PROVIDER` / `GEN_VIDEO_PROVIDER`, reconciled against the pinned provider. */
  readonly configuredAdapter: string;
  readonly model: GenerationModel;
  /**
   * Runs after moderation passes. Throwing is a supported outcome: it lands on
   * `failPreparation`, which decides unknown vs preparation_failed from the
   * invocation guard. Implementations must not reach the provider.
   */
  readonly prepare: (input: {
    readonly referenceImages: HydratedReferenceImages;
  }) => Promise<TPrepared>;
  readonly invoke: (input: {
    readonly prepared: TPrepared;
    readonly providerIdempotencyKey: string;
    readonly executionBoundary?: GenerationInvocationBoundary;
  }) => Promise<ProviderResult<TProviderOutput>>;
  readonly normalizeArtifacts: (input: {
    readonly prepared: TPrepared;
    readonly output: TProviderOutput;
  }) => Promise<NormalizedGeneration>;
};

type HydratedReferenceImages = Awaited<
  ReturnType<typeof hydratedImageReferenceInputs>
>;

export type GenerationRunPorts = GenerationExecutionPorts & {
  readonly blob: BlobStore;
  readonly moderation: ModerationProvider;
};

/**
 * SPEC: one attempt, start to finish.
 *
 * INVARIANT: the steps below are the whole contract, and a modality states none
 * of them. Callers used to re-express this sequence per mode, which is how the
 * image path grew a reference-hydration guard the video path had in a different
 * place, and how each one separately had to remember that a resumed record ends
 * the attempt.
 */
export async function runGeneration<TPrepared, TProviderOutput>(
  payload: GenerationPayload,
  modality: GenerationModality<TPrepared, TProviderOutput>,
  ports: GenerationRunPorts & { readonly attemptsMade?: number; readonly maxAttempts?: number },
): Promise<void> {
  const execution = new GenerationExecution({
    payload,
    provider: payload.provider,
    blob: ports.blob,
    attemptsMade: ports.attemptsMade,
    maxAttempts: ports.maxAttempts,
    acknowledgeTerminalRecord: ports.acknowledgeTerminalRecord,
    recordTransportExecution: ports.recordTransportExecution,
  });

  // A record that survived a relay interruption is replayed as-is; the provider
  // is never asked again for an attempt that already has a terminal outcome.
  if (await execution.resumeTerminalRecord()) return;

  let prepared: TPrepared;
  let blockedPolicyCode: string | undefined;
  try {
    assertRecordedProviderMatchesConfiguredAdapter(
      payload.provider,
      modality.configuredAdapter,
      modality.mode,
    );
    const moderation = await ports.moderation.check({
      targetType: "text",
      content: `${payload.prompt} ${payload.negativePrompt ?? ""}`,
    });
    if (!moderation.ok) {
      throw new Error(
        `Input moderation failed (${moderation.error.code}): ${moderation.error.message}`,
      );
    }
    if (moderation.data.status === "blocked") {
      blockedPolicyCode = moderation.data.policyCode ?? "PROHIBITED_OTHER";
      prepared = undefined as TPrepared;
    } else {
      prepared = await modality.prepare({
        referenceImages: await hydratedImageReferenceInputs(
          payload.referenceImages,
          ports.blob,
        ),
      });
    }
  } catch (error) {
    await execution.failPreparation(error);
    return;
  }

  if (blockedPolicyCode !== undefined) {
    await execution.block(
      blockedPolicyCode,
      "Input moderation blocked the generation request",
      "input",
    );
    return;
  }

  await execution.execute({
    model: modality.model,
    invoke: ({ providerIdempotencyKey, executionBoundary }) =>
      modality.invoke({ prepared, providerIdempotencyKey, executionBoundary }),
    normalizeArtifacts: (output) =>
      modality.normalizeArtifacts({ prepared, output }),
  });
}

// SPEC: deployment self-check, NOT backend selection. `payload.provider` is
// Main's `GenerationModelProfile.runner` copied onto the Attempt — an accounting
// field that ends up verbatim in the terminal record. It never chooses an
// execution body: the backend is decided by
// `registry.resolveForModel(payload.model).descriptor.backendKind`, admitted by
// the workflowKey@workflowVersion pin (backend/registry.ts validateWorkflowPin).
// INTENT: this only asserts the worker's own GEN_*_PROVIDER adapter is the one
// Main assumed when it recorded that runner — i.e. a `mock`-provisioned attempt
// cannot land on a real-backend worker and vice versa. The two vocabularies are
// deliberately many-to-one (Main's runner names ⇒ gen's adapter names), so
// matching here proves nothing about which backend actually runs. It runs before
// moderation, so a misconfigured worker fails before anything costs money.
function assertRecordedProviderMatchesConfiguredAdapter(
  recordedProvider: string,
  configuredAdapter: string,
  mode: "image" | "video",
) {
  const requiredAdapter = workerAdapterForRecordedProvider(recordedProvider);
  if (requiredAdapter !== configuredAdapter) {
    throw new Error(
      `Pinned ${mode} provider ${recordedProvider} requires GEN_${mode.toUpperCase()}_PROVIDER=${requiredAdapter}; configured=${configuredAdapter}`,
    );
  }
}
