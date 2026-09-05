from pathlib import Path
root=Path('.scratch/admin-audit-20260905/resource-wait-staging/packages')
def edit(file,old,new,count=1):
 p=root/file;s=p.read_text();assert s.count(old)>=count,(file,old);p.write_text(s.replace(old,new,count))
edit(Path('shared/src/contracts/durable.ts'),'  status: z.enum(["running", "failed", "unknown"]),','  status: z.enum(["running", "failed", "unknown"]),\n  phase: z.literal("resource_wait").optional(),')
edit(Path('shared/src/contracts/durable.ts'),'  accounting: generationProviderAccountingSchema.optional(),\n});','''  accounting: generationProviderAccountingSchema.optional(),
}).superRefine((event, context) => {
  if (event.phase === "resource_wait" && (
    event.status !== "running" || event.providerRequestId !== null ||
    event.error !== null || event.accounting !== undefined
  )) {
    context.addIssue({ code: "custom", path: ["phase"], message: "Resource waiting cannot contain provider invocation evidence" });
  }
});''')
p=Path('gen/src/providers.ts')
edit(p,'export interface ImageModel {','''export type GenerationInvocationBoundary = {
  onResourceWait: () => Promise<void>;
  beforeProviderInvocation: () => Promise<void>;
};

export interface ImageModel {''')
edit(p,'  readonly retryCapabilities?: ProviderRetryCapabilities;','  readonly retryCapabilities?: ProviderRetryCapabilities;\n  readonly managesInvocationBoundary?: true;',2)
edit(p,'  generate(input: {\n    prompt: string;','  generate(input: {\n    executionBoundary?: GenerationInvocationBoundary;\n    prompt: string;',2)
edit(p,'(run) => withGenerationAcceleratorLease("image", run)','(run, options) => withGenerationAcceleratorLease("image", run, options)')
edit(p,'(run) => withGenerationAcceleratorLease("video", run)','(run, options) => withGenerationAcceleratorLease("video", run, options)')
p=Path('gen/src/pipeline.ts')
edit(p,'invoke: ({ providerIdempotencyKey }) => imageModel.generate({','invoke: ({ providerIdempotencyKey, executionBoundary }) => imageModel.generate({\n      executionBoundary,')
edit(p,'invoke: ({ providerIdempotencyKey }) => videoModel.generate({','invoke: ({ providerIdempotencyKey, executionBoundary }) => videoModel.generate({\n      executionBoundary,')
for kind in ['image','video']:
 p=Path(f'gen/src/backend/backend-{kind}-model.ts')
 edit(p,'type RunWithAcceleratorLease = <T>(run: () => Promise<T>) => Promise<T>;','type RunWithAcceleratorLease = <T>(run: () => Promise<T>, options?: { onWait?: () => Promise<void> }) => Promise<T>;')
 edit(p,f'export class Backend{kind.title()}Model implements {kind.title()}Model {{',f'export class Backend{kind.title()}Model implements {kind.title()}Model {{\n  readonly managesInvocationBoundary = true;')
 edit(p,'this.runWithAcceleratorLease(async () => {','this.runWithAcceleratorLease(async () => {\n        await input.executionBoundary?.beforeProviderInvocation();')
 end='''        return backend.poll(handle);
      });''' if kind=='video' else '''        }
      });
      return {'''
 new='''        return backend.poll(handle);
      }, { onWait: input.executionBoundary?.onResourceWait });''' if kind=='video' else '''        }
      }, { onWait: input.executionBoundary?.onResourceWait });
      return {'''
 edit(p,end,new)
p=Path('gen/src/env.ts')
edit(p,'  get ACCELERATOR_LOCK_STALE_MS(): number {','''  get ACCELERATOR_WAIT_TIMEOUT_MS(): number {
    // Bound queue residency separately from execution: allow two maximum video
    // execution windows ahead of this worker on the shared image/video device.
    return positiveIntegerEnv("GEN_ACCELERATOR_WAIT_TIMEOUT_MS", 2 * this.VIDEO_TIMEOUT_MS);
  },
  get ACCELERATOR_LOCK_STALE_MS(): number {''')
p=Path('gen/src/backend/generation-accelerator-lease.ts')
edit(p,'  readonly staleMs?: number;','  readonly staleMs?: number;\n  readonly waitTimeoutMs?: number;\n  readonly heartbeatMs?: number;\n  readonly onWait?: () => Promise<void>;')
edit(p,'  await acquire(lockPath, owner, pollMs, staleMs);','''  await acquire(lockPath, owner, pollMs, staleMs, {
    timeoutMs: options.waitTimeoutMs ?? env.ACCELERATOR_WAIT_TIMEOUT_MS,
    heartbeatMs: options.heartbeatMs ?? 30_000,
    onWait: options.onWait,
  });''')
edit(p,'  staleMs: number,\n) {\n  while (true) {','''  staleMs: number,
  wait: { timeoutMs: number; heartbeatMs: number; onWait?: () => Promise<void> },
) {
  const deadline = Date.now() + wait.timeoutMs;
  let nextHeartbeatAt = 0;
  while (true) {
    if (Date.now() >= deadline) throw new Error("Generation accelerator resource wait timed out before provider invocation");''')
edit(p,'JSON.stringify(owner)','JSON.stringify({ ...owner, acquiredAtMs: Date.now() })')
edit(p,'    await delay(pollMs);','''    if (Date.now() >= nextHeartbeatAt) {
      await wait.onWait?.();
      nextHeartbeatAt = Date.now() + wait.heartbeatMs;
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));''')
p=Path('gen/src/transport-execution.ts')
edit(p,'    method: "POST",','    method: "POST",\n    signal: AbortSignal.timeout(10_000),')
p=Path('gen/src/generation-execution.ts')
edit(p,'  ImageModel,','  ImageModel,\n  GenerationInvocationBoundary,')
edit(p,'    providerIdempotencyKey: string;','    providerIdempotencyKey: string;\n    executionBoundary?: GenerationInvocationBoundary;')
s=(root/p).read_text(); start=s.index('    await this.recordTransport("running");\n    const providerReplayIsSafe');end=s.index('\n    if (!result.ok)',start)
s=s[:start]+'''    const providerReplayIsSafe =
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
          await this.recordTransport("running", null, undefined, null, "resource_wait");
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
''' +s[end:];(root/p).write_text(s)
edit(p,'    providerRequestId: string | null = null,\n  ): Promise<void> {','    providerRequestId: string | null = null,\n    phase?: "resource_wait",\n  ): Promise<void> {')
edit(p,'      providerRequestId,\n      status,','      providerRequestId,\n      status,\n      ...(phase ? { phase } : {}),')
# Stage Main endpoint alongside the isolated Shared contract.
p=Path('main/src/server/ai/generation-transport-execution.ts');(root/p).parent.mkdir(parents=True,exist_ok=True);(root/p).write_text(Path('packages/main/src/server/ai/generation-transport-execution.ts').read_text())
edit(p,'    let disposition: "persisted" | "duplicate" = "persisted";','''    if (input.phase === "resource_wait") {
      if (existing) throw Errors.conflict("Resource waiting cannot follow provider entry for the same transport");
      const event = await recordGenerationAttemptEvent(tx, {
        eventId: `${input.attemptId}:resource-wait:${input.transportAttemptNo}:${input.occurredAt}`,
        attemptId: input.attemptId,
        eventType: "generation.resource.waiting.v1",
        occurredAt: new Date(input.occurredAt),
        payload: transportEventPayload(input),
      });
      // Resource liveness is durable, but startedAt and TransportExecution remain
      // absent until the worker owns the device and rechecks provider authority.
      return { disposition: event.disposition };
    }
    let disposition: "persisted" | "duplicate" = "persisted";''')
