// SPEC: One image/video generation attempt has one transport identity and one
// durable terminal record. Any retry that would invoke the provider again is
// allowed only when the model explicitly guarantees deterministic idempotency.
// INTENT: Keep lifecycle authority here; modality adapters invoke providers and
// normalize persisted artifacts without knowing ACK/retry/transport mechanics.
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
  ProviderFailure,
  ProviderInvocationMetadata,
  ProviderResult,
  VideoModel,
} from "./providers";
import {
  loadPersistedTerminalRecord,
  persistTerminalRecord,
  reserveGenerationInvocation,
} from "./terminal-record";

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

export class GenerationExecution {
  readonly #identity;

  constructor(private readonly options: GenerationExecutionOptions) {
    const attemptId = options.payload.attemptId;
    this.#identity = {
      attemptId,
      attemptNo: options.payload.attemptNo,
      transportAttemptNo: (options.attemptsMade ?? 0) + 1,
      idempotencyKey: `generation:${attemptId}:provider`,
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

  async execute<TProviderOutput>(
    adapter: GenerationAdapter<TProviderOutput>,
  ): Promise<void> {
    await this.recordTransport("running");
    const providerReplayIsSafe =
      adapter.model.retryCapabilities?.deterministicIdempotencyKey === true;
    if (!providerReplayIsSafe) {
      const reservation = await reserveGenerationInvocation(
        this.options.blob,
        this.invocationGuard(),
      );
      if (!reservation.created) {
        if (
          reservation.guard.transportAttemptNo >=
          this.#identity.transportAttemptNo
        ) {
          throw new Error(
            `provider invocation is already reserved for ${this.#identity.attemptId}`,
          );
        }
        await this.fail(
          "ambiguous_incomplete_provider_invocation",
          "A prior non-replayable provider invocation did not leave terminal evidence",
          { outcome: "unknown", retryability: "not_retryable" },
          { providerInvoked: true, providerReplayIsSafe: false },
        );
        return;
      }
    }
    const invocationStartedAt = performance.now();
    const result = await adapter.invoke({
      providerIdempotencyKey: this.#identity.idempotencyKey,
    });
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
          accounting: invocationAccounting(result.invocation, invocationLatencyMs),
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
    status: "running" | "failed" | "unknown",
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
) {
  const pricingVersion = invocation?.pricingVersion?.trim() || null;
  const providerCost = invocation?.costMicros;
  const costMicros =
    pricingVersion !== null &&
    Number.isSafeInteger(providerCost) &&
    (providerCost ?? -1) >= 0
      ? providerCost ?? null
      : null;
  return {
    usage: { ...(invocation?.usage ?? fallbackUsage) },
    latencyMs: Math.max(0, Math.round(latencyMs)),
    costMicros,
    pricingVersion,
  };
}
