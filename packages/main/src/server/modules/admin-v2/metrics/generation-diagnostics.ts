import type { GenerationAttempt, GenerationJob, GenerationTransportExecution, AiUsageFact } from "@prisma/client";

export type DiagnosticJob = Pick<GenerationJob,
  "id" | "mode" | "status" | "sourceType" | "profileId" | "profileVersion" | "model" | "provider" | "createdAt" | "finishedAt" | "completedAt"
> & { readonly dataClass: string };
export type DiagnosticAttempt = Pick<GenerationAttempt,
  "id" | "requestId" | "attemptNo" | "profileKey" | "profileVersion" | "workflowKey" | "workflowVersion" | "provider" | "status" | "createdAt" | "startedAt"
>;
export type DiagnosticTransport = Pick<GenerationTransportExecution,
  "id" | "attemptId" | "transportAttemptNo" | "status" | "latencyMs" | "startedAt" | "finishedAt"
>;
export type DiagnosticUsage = Pick<AiUsageFact, "transportExecutionId" | "provider" | "model" | "usage">;

function measured(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function timingDistribution(values: readonly (number | null)[]) {
  const sorted = values.filter(measured).sort((a, b) => a - b);
  const quantile = (fraction: number) => sorted.length === 0
    ? null : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { samples: sorted.length, missing: values.length - sorted.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95) };
}

function elapsed(start: Date, end: Date | null): number | null {
  const value = end ? end.getTime() - start.getTime() : null;
  return measured(value) ? value : null;
}

function performanceEvidence(usage: DiagnosticUsage | undefined) {
  const value = usage?.usage;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const performance = value.performance;
  return performance && typeof performance === "object" && !Array.isArray(performance) ? performance : null;
}

/** Operational samples only. This does not create eligible facts or Metric Registry values. */
export function summarizeGenerationDiagnostics(input: {
  readonly jobs: readonly DiagnosticJob[];
  readonly attempts: readonly DiagnosticAttempt[];
  readonly transports: readonly DiagnosticTransport[];
  readonly usage: readonly DiagnosticUsage[];
}) {
  const usage = new Map(input.usage.filter((fact) => fact.transportExecutionId !== null).map((fact) => [fact.transportExecutionId, fact]));
  const latestAttempt = new Map<string, DiagnosticAttempt>();
  const attemptsByJob = new Map<string, DiagnosticAttempt[]>();
  const transportsByAttempt = new Map<string, DiagnosticTransport[]>();
  const requestByAttempt = new Map<string, string>();
  for (const attempt of input.attempts) {
    const previous = latestAttempt.get(attempt.requestId);
    if (!previous || attempt.attemptNo > previous.attemptNo) latestAttempt.set(attempt.requestId, attempt);
    const attempts = attemptsByJob.get(attempt.requestId) ?? [];
    attempts.push(attempt);
    attemptsByJob.set(attempt.requestId, attempts);
    requestByAttempt.set(attempt.id, attempt.requestId);
  }
  for (const transport of input.transports) {
    const transports = transportsByAttempt.get(transport.attemptId) ?? [];
    transports.push(transport);
    transportsByAttempt.set(transport.attemptId, transports);
  }
  const rows: { job: DiagnosticJob; attempt: DiagnosticAttempt | null }[] = [];
  for (const job of input.jobs) {
    const attempts = attemptsByJob.get(job.id) ?? [];
    if (attempts.length === 0) rows.push({ job, attempt: null });
    else for (const attempt of attempts) rows.push({ job, attempt });
  }
  const groups = new Map<string, {
    identity: {
      dataClass: string; sourceType: string; mode: string; profileId: string | null;
      profileKey: string | null; profileVersion: number | null;
      workflowKey: string | null; workflowVersion: number | null;
      provider: string | null; requestedModel: string | null;
    };
    jobs: DiagnosticJob[]; attempts: DiagnosticAttempt[]; transports: DiagnosticTransport[];
  }>();
  for (const { job, attempt } of rows) {
    const identity = {
      dataClass: job.dataClass, sourceType: job.sourceType, mode: job.mode,
      profileId: job.profileId, profileKey: attempt?.profileKey ?? null,
      profileVersion: attempt ? attempt.profileVersion : job.profileVersion,
      workflowKey: attempt?.workflowKey ?? null, workflowVersion: attempt?.workflowVersion ?? null,
      provider: attempt ? attempt.provider : job.provider, requestedModel: job.model,
    };
    const key = JSON.stringify(identity);
    const group = groups.get(key) ?? { identity, jobs: [], attempts: [], transports: [] };
    // A product request contributes its final status and end-to-end latency
    // only to its latest attempt's pins. Earlier retries remain attempt evidence.
    if (!attempt || latestAttempt.get(job.id)?.id === attempt.id) group.jobs.push(job);
    if (attempt) {
      group.attempts.push(attempt);
      group.transports.push(...transportsByAttempt.get(attempt.id) ?? []);
    }
    groups.set(key, group);
  }
  const statuses = (values: readonly { status: string }[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value.status] = (counts[value.status] ?? 0) + 1;
    return counts;
  };
  return [...groups.values()].map((group) => {
    const performance = group.transports.map((transport) => performanceEvidence(usage.get(transport.id)));
    const endToEnd = group.jobs.map((job) => elapsed(job.createdAt, job.finishedAt ?? job.completedAt));
    const queue = group.attempts.map((attempt) => elapsed(attempt.createdAt, attempt.startedAt));
    return {
      ...group.identity,
      jobs: { samples: group.jobs.length, statuses: statuses(group.jobs) },
      attempts: { samples: group.attempts.length, statuses: statuses(group.attempts) },
      invocations: { samples: group.transports.length, statuses: statuses(group.transports) },
      queueMs: timingDistribution(queue),
      executionMs: timingDistribution(group.transports.map((transport) => transport.latencyMs)),
      endToEndMs: timingDistribution(endToEnd),
      successfulEndToEndMs: timingDistribution(group.jobs.filter((job) => job.status === "completed").map((job) => elapsed(job.createdAt, job.completedAt ?? job.finishedAt))),
      resourceWaitMs: timingDistribution(performance.map((row) => measured(row?.resourceWaitMs) ? row.resourceWaitMs : null)),
      runnerPreparationMs: timingDistribution(performance.map((row) => measured(row?.runnerPreparationMs) ? row.runnerPreparationMs : null)),
      observedPerformanceSamples: performance.filter((row) => row !== null).length,
      invocationEvidence: group.transports.map((transport) => ({
        requestId: requestByAttempt.get(transport.attemptId) ?? null,
        attemptId: transport.attemptId, transportExecutionId: transport.id,
        transportAttemptNo: transport.transportAttemptNo, status: transport.status,
        provider: usage.get(transport.id)?.provider ?? null,
        model: usage.get(transport.id)?.model ?? null,
        latencyMs: transport.latencyMs, performance: performanceEvidence(usage.get(transport.id)),
      })),
    };
  }).sort((left, right) => right.jobs.samples - left.jobs.samples || JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
