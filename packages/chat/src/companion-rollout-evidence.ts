import { z } from "zod";
import { Prisma } from "../generated/client/client.js";
import { chatPrisma, type ChatPrismaClient } from "./db.js";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import type {
  CompanionIgrepAttemptMetric,
  CompanionOperationalTelemetry,
} from "./companion-rollout-telemetry.js";

// SPEC: Gate R evidence is an observed-data report, never a release decision.
// INVARIANT: inputs and output contain aggregate telemetry only—no ids, content,
// prompts, tool arguments, profile text, or provider secrets.
export type EvidenceRuntime = "native" | "dsh";

export interface EvidenceTelemetry extends CompanionOperationalTelemetry {
  schemaVersion: 1;
  runtime: EvidenceRuntime;
  startedAt: string;
  firstTokenMs?: number;
  totalMs?: number;
  terminalStatus?: "sent" | "blocked" | "failed" | "cancelled";
  truncated?: boolean;
  provider?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
  };
  steps?: number;
  toolCalls?: number;
  retryCount: number;
  sseTerminal?: "done" | "error";
  memory?: { outcome: string; settleLagMs?: number };
  error?: { category: string; code: string };
}

const igrepAttemptMetricSchema = z.object({
  calls: z.number().int().nonnegative(),
  hit: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
  failure: z.number().int().nonnegative(),
  resultCount: z.number().int().nonnegative(),
  latencyMs: z.array(z.number().int().nonnegative()).max(64),
}).strict().refine(
  (value) => value.calls === value.hit + value.empty + value.failure
    && value.calls === value.latencyMs.length,
  "igrep aggregate counts must match observed calls",
);

export interface AttemptEvidenceRow {
  telemetry: EvidenceTelemetry;
  memoryExtracted: boolean | null;
}

export interface OutboxEvidenceRow {
  runtime: EvidenceRuntime;
  status: string;
  deliveryLagMs: number | null;
  pendingAgeMs: number | null;
}

const telemetrySchema = z.object({
  schemaVersion: z.literal(1),
  runtime: z.enum(["native", "dsh"]),
  startedAt: z.string().datetime({ offset: true }),
  firstTokenMs: z.number().nonnegative().optional(),
  totalMs: z.number().nonnegative().optional(),
  terminalStatus: z.enum(["sent", "blocked", "failed", "cancelled"]).optional(),
  truncated: z.boolean().optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  usage: z.object({
    promptTokens: z.number().nonnegative(),
    completionTokens: z.number().nonnegative(),
    reasoningTokens: z.number().nonnegative().optional(),
  }).optional(),
  steps: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().nonnegative(),
  sseTerminal: z.enum(["done", "error"]).optional(),
  memory: z.object({
    outcome: z.string().min(1),
    settleLagMs: z.number().nonnegative().optional(),
  }).optional(),
  error: z.object({
    category: z.string().min(1),
    code: z.string().min(1),
  }).optional(),
  sidecar: z.object({
    instanceId: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }),
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  igrep: z.object({
    search: igrepAttemptMetricSchema.optional(),
    memory: igrepAttemptMetricSchema.optional(),
  }).strict().optional(),
});

interface RawAttemptEvidenceRow {
  telemetry: Prisma.JsonValue;
  memoryExtracted: boolean | null;
}

interface RawOutboxEvidenceRow {
  runtime: string;
  status: string;
  deliveryLagMs: number | null;
  pendingAgeMs: number | null;
}

// INTENT: query only the small aggregate telemetry envelope. Message content,
// ids, prompts, tool arguments and outbox payloads never cross this boundary.
export async function collectCompanionRolloutEvidence(
  input: { window: { from: Date; to: Date }; userId?: string },
  prisma: ChatPrismaClient = chatPrisma,
) {
  const userFilter = input.userId
    ? Prisma.sql`AND s.user_id = ${input.userId}`
    : Prisma.empty;
  const primaryTelemetry = Prisma.sql`mv.runtime_trace -> 'primaryTelemetry'`;
  // INVARIANT: memory_extracted_attempt is the current Message watermark, not
  // a historical attempt ledger. Only the selected current sent attempt can be
  // proven extracted; older versions remain unknown even when the watermark is newer.
  const attempts = await prisma.$queryRaw<RawAttemptEvidenceRow[]>(Prisma.sql`
    SELECT
      ${primaryTelemetry} AS telemetry,
      CASE
        WHEN m.status = 'sent'
          AND m.memory_authority = 'enabled'
          AND m.attempt = mv.attempt
          AND mv.selected
        THEN m.memory_extracted_attempt = mv.attempt
        ELSE NULL
      END AS "memoryExtracted"
    FROM chat.message_versions mv
    JOIN chat.messages m ON m.id = mv.message_id
    JOIN chat.chat_sessions s ON s.id = m.session_id
    JOIN core.chat_user_view u ON u.user_id = s.user_id
    WHERE mv.created_at >= ${input.window.from}
      AND mv.created_at < ${input.window.to}
      AND m.role = 'assistant'
      AND jsonb_typeof(${primaryTelemetry}) = 'object'
      AND ${primaryTelemetry} ->> 'runtime' IN ('native', 'dsh')
      AND u.status = 'active'
      AND u.deleted_at IS NULL
      AND u.data_class = 'customer'
      ${userFilter}
  `);
  const evidenceAttempts: AttemptEvidenceRow[] = [];
  for (const row of attempts) {
    const parsed = telemetrySchema.safeParse(row.telemetry);
    if (parsed.success) {
      evidenceAttempts.push({ telemetry: parsed.data, memoryExtracted: row.memoryExtracted });
    }
  }

  const outbox = await prisma.$queryRaw<RawOutboxEvidenceRow[]>(Prisma.sql`
    WITH evidence_attempts AS (
      SELECT
        mv.message_id,
        mv.created_at AS attempt_created_at,
        lead(mv.created_at) OVER (
          PARTITION BY mv.message_id ORDER BY mv.created_at, mv.id
        ) AS next_attempt_at,
        ${primaryTelemetry} ->> 'runtime' AS runtime
      FROM chat.message_versions mv
      JOIN chat.messages m ON m.id = mv.message_id
      JOIN chat.chat_sessions s ON s.id = m.session_id
      JOIN core.chat_user_view u ON u.user_id = s.user_id
      WHERE mv.created_at >= ${input.window.from}
        AND mv.created_at < ${input.window.to}
        AND m.role = 'assistant'
        AND jsonb_typeof(${primaryTelemetry}) = 'object'
        AND ${primaryTelemetry} ->> 'runtime' IN ('native', 'dsh')
        AND u.status = 'active'
        AND u.deleted_at IS NULL
        AND u.data_class = 'customer'
        ${userFilter}
    )
    SELECT
      a.runtime,
      o.status,
      CASE
        WHEN o.delivered_at IS NULL THEN NULL
        ELSE greatest(
          0,
          extract(epoch FROM (o.delivered_at - o.created_at)) * 1000
        )::double precision
      END AS "deliveryLagMs",
      CASE
        WHEN o.status <> 'pending' THEN NULL
        ELSE greatest(
          0,
          extract(epoch FROM (${input.window.to} - o.created_at)) * 1000
        )::double precision
      END AS "pendingAgeMs"
    FROM evidence_attempts a
    JOIN chat.chat_outbox_events o
      ON o.aggregate_type = 'message'
     AND o.aggregate_id = a.message_id
     AND o.created_at >= a.attempt_created_at
     AND (a.next_attempt_at IS NULL OR o.created_at < a.next_attempt_at)
     AND o.created_at < ${input.window.to}
    WHERE o.event_type IN (
      ${CHAT_TO_MAIN_EVENTS.messageCompleted},
      ${CHAT_TO_MAIN_EVENTS.messageBlocked}
    )
  `);
  const evidenceOutbox = outbox.filter(
    (row): row is RawOutboxEvidenceRow & { runtime: EvidenceRuntime } =>
      row.runtime === "native" || row.runtime === "dsh",
  );

  return {
    ...summarizeCompanionRolloutEvidence({
      window: input.window,
      attempts: evidenceAttempts,
      outbox: evidenceOutbox,
    }),
    dataScope: {
      userAuthority: "core.chat_user_view",
      activeCustomersOnly: true,
      userFilterApplied: input.userId !== undefined,
      windowBasis: "message_versions.created_at",
    },
  };
}

interface MetricSummary {
  samples: number;
  p50: number | null;
  p95: number | null;
}

export function summarizeCompanionRolloutEvidence(input: {
  window: { from: Date; to: Date };
  attempts: readonly AttemptEvidenceRow[];
  outbox: readonly OutboxEvidenceRow[];
}) {
  const runtimes = {
    native: summarizeRuntime("native", input.attempts, input.outbox, input.window),
    dsh: summarizeRuntime("dsh", input.attempts, input.outbox, input.window),
  };
  const sampleEvidence = {
    native: runtimes.native.attempts === 0 ? "no_samples" : "observed",
    dsh: runtimes.dsh.attempts === 0 ? "no_samples" : "observed",
  } as const;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window: {
      from: input.window.from.toISOString(),
      to: input.window.to.toISOString(),
      durationMs: input.window.to.getTime() - input.window.from.getTime(),
    },
    comparisonStatus:
      sampleEvidence.native === "no_samples" || sampleEvidence.dsh === "no_samples"
        ? "sample_insufficient"
        : "observed",
    sampleEvidence,
    releaseDecision: {
      status: "not_evaluated",
      reason: "no_gate_thresholds_or_observation_window_policy",
    },
    runtimes,
  };
}

function summarizeRuntime(
  runtime: EvidenceRuntime,
  allAttempts: readonly AttemptEvidenceRow[],
  allOutbox: readonly OutboxEvidenceRow[],
  window: { from: Date; to: Date },
) {
  const attempts = allAttempts.filter((row) => row.telemetry.runtime === runtime);
  const telemetry = attempts.map((row) => row.telemetry);
  const outbox = allOutbox.filter((row) => row.runtime === runtime);
  const terminal = {
    sent: count(telemetry, (row) => row.terminalStatus === "sent"),
    blocked: count(telemetry, (row) => row.terminalStatus === "blocked"),
    failed: count(telemetry, (row) => row.terminalStatus === "failed"),
    cancelled: count(telemetry, (row) => row.terminalStatus === "cancelled"),
  };
  const errorCount = count(telemetry, (row) => row.error !== undefined);
  const memoryOutcomes: Record<string, number> = {};
  for (const row of attempts) {
    const observed = runtime === "native" && row.memoryExtracted
      ? "extracted"
      : runtime === "native" && row.memoryExtracted === null
        ? "unknown"
      : row.telemetry.memory?.outcome;
    if (observed) memoryOutcomes[observed] = (memoryOutcomes[observed] ?? 0) + 1;
  }
  const providerModels = groupedCounts(telemetry, (row) =>
    row.provider && row.model ? `${row.provider}\0${row.model}` : null)
    .map(({ key, count }) => {
      const [provider, model] = key.split("\0");
      return { provider, model, count };
    });
  const sidecarAttempts = telemetry
    .filter((row) => row.sidecar !== undefined)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const instanceTransitions = sidecarAttempts.reduce((total, row, index) => {
    if (index === 0) return total;
    return total + (sidecarAttempts[index - 1]?.sidecar?.instanceId === row.sidecar?.instanceId ? 0 : 1);
  }, 0);
  const sidecarStatus = runtime === "native"
    ? "not_applicable"
    : sidecarAttempts.length === attempts.length && sidecarAttempts.length >= 2
      ? "observed"
      : "insufficient";
  const durationHours = (window.to.getTime() - window.from.getTime()) / 3_600_000;
  const igrepStatus = runtime === "native"
    ? "not_applicable"
    : sidecarAttempts.length === attempts.length && attempts.length > 0
      ? "observed"
      : "insufficient";
  return {
    attempts: attempts.length,
    terminal,
    rates: {
      error: rate(errorCount, attempts.length),
      truncated: rate(count(telemetry, (row) => row.truncated === true), attempts.length),
      cancelled: rate(terminal.cancelled, attempts.length),
    },
    firstTokenMs: metric(telemetry.map((row) => row.firstTokenMs)),
    totalMs: metric(telemetry.map((row) => row.totalMs)),
    steps: metric(telemetry.map((row) => row.steps)),
    toolCalls: metric(telemetry.map((row) => row.toolCalls)),
    retryCount: metric(telemetry.map((row) => row.retryCount)),
    usage: {
      promptTokens: metric(telemetry.map((row) => row.usage?.promptTokens)),
      completionTokens: metric(telemetry.map((row) => row.usage?.completionTokens)),
      reasoningTokens: metric(telemetry.map((row) => row.usage?.reasoningTokens)),
    },
    providerModels,
    providerCost: {
      status: "insufficient",
      samples: 0,
      totalMicros: null,
      reason: "provider_cost_not_reported_by_companion_upstream",
    },
    errors: {
      byCategory: Object.fromEntries(groupedCounts(telemetry, (row) => row.error?.category ?? null)
        .map(({ key, count }) => [key, count])),
      byCode: Object.fromEntries(groupedCounts(telemetry, (row) => row.error?.code ?? null)
        .map(({ key, count }) => [key, count])),
    },
    memory: {
      outcomes: memoryOutcomes,
      settleLagMs: metric(telemetry.map((row) => row.memory?.settleLagMs)),
    },
    sidecar: {
      status: sidecarStatus,
      sampledAttempts: sidecarAttempts.length,
      distinctInstances: new Set(sidecarAttempts.map((row) => row.sidecar?.instanceId)).size,
      instanceTransitions,
      restartRatePerHour: sidecarStatus === "observed" && durationHours > 0
        ? round(instanceTransitions / durationHours)
        : null,
      ...(sidecarStatus === "insufficient"
        ? { reason: "complete_instance_identity_requires_at_least_two_dsh_attempts" }
        : {}),
    },
    igrep: {
      status: igrepStatus,
      search: summarizeIgrep(telemetry.map((row) => row.igrep?.search)),
      memory: summarizeIgrep(telemetry.map((row) => row.igrep?.memory)),
      ...(igrepStatus === "insufficient"
        ? { reason: "igrep_observation_coverage_incomplete" }
        : {}),
    },
    casConflicts: count(telemetry, (row) =>
      row.error?.category === "cas" || row.error?.code === "terminal_cas_conflict"),
    sseIncomplete: count(telemetry, (row) =>
      row.terminalStatus !== undefined && row.sseTerminal === undefined),
    outbox: {
      events: outbox.length,
      delivered: count(outbox, (row) => row.status === "delivered"),
      pending: count(outbox, (row) => row.status === "pending"),
      failed: count(outbox, (row) => row.status === "failed"),
      deliveryLagMs: metric(outbox.map((row) => row.deliveryLagMs ?? undefined)),
      oldestPendingMs: maximum(outbox.map((row) => row.pendingAgeMs ?? undefined)),
    },
  };
}

function summarizeIgrep(
  values: readonly (CompanionIgrepAttemptMetric | undefined)[],
) {
  const observed = values.filter(
    (value): value is CompanionIgrepAttemptMetric => value !== undefined,
  );
  return {
    calls: observed.reduce((total, value) => total + value.calls, 0),
    hit: observed.reduce((total, value) => total + value.hit, 0),
    empty: observed.reduce((total, value) => total + value.empty, 0),
    failure: observed.reduce((total, value) => total + value.failure, 0),
    resultCount: observed.reduce((total, value) => total + value.resultCount, 0),
    latencyMs: metric(observed.flatMap((value) => value.latencyMs)),
  };
}

function metric(values: readonly (number | undefined)[]): MetricSummary {
  const samples = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
  };
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const left = sorted[lower] ?? 0;
  const right = sorted[upper] ?? left;
  return round(left + (right - left) * (index - lower));
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round(numerator / denominator);
}

function maximum(values: readonly (number | undefined)[]): number | null {
  const samples = values.filter((value): value is number => value !== undefined);
  return samples.length === 0 ? null : Math.max(...samples);
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

function groupedCounts<T>(
  values: readonly T[],
  keyFor: (value: T) => string | null,
): Array<{ key: string; count: number }> {
  const groups = new Map<string, number>();
  for (const value of values) {
    const key = keyFor(value);
    if (key) groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count }));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
