import { randomUUID } from "node:crypto";
import { z } from "zod";

const canaryRequestSchema = z.object({
  name: z.string().min(1).max(120),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/").superRefine((value, context) => {
    const sentinel = new URL("https://admin-canary.invalid");
    const target = new URL(value, sentinel);
    if (target.origin !== sentinel.origin) {
      context.addIssue({ code: "custom", message: "path must stay on the same configured origin" });
      return;
    }
    if (target.pathname !== "/api/v2/admin" && !target.pathname.startsWith("/api/v2/admin/")) {
      context.addIssue({ code: "custom", message: "canary requests must target the Admin v2 API" });
    }
  }),
  expectedStatuses: z.array(z.number().int().min(200).max(299)).min(1),
  idempotencyKeyPrefix: z.string().min(1).max(120).optional(),
  body: z.unknown().optional(),
}).strict();

export const adminCanaryPlanSchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.literal("production"),
  mode: z.enum(["read", "write"]),
  baseUrl: z.string().url(),
  iterations: z.number().int().min(1).max(1_000),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  requests: z.array(canaryRequestSchema).min(1).max(20),
}).strict().superRefine((plan, context) => {
  const readMethods = new Set(["GET", "HEAD"]);
  if (plan.mode === "read") {
    for (const [index, request] of plan.requests.entries()) {
      if (!readMethods.has(request.method)) context.addIssue({ code: "custom", message: "read canary accepts only GET/HEAD", path: ["requests", index, "method"] });
    }
  } else {
    if (plan.iterations > 10) context.addIssue({ code: "custom", message: "write canary is bounded to 10 iterations per invocation", path: ["iterations"] });
    for (const [index, request] of plan.requests.entries()) {
      if (readMethods.has(request.method)) context.addIssue({ code: "custom", message: "write canary requires a mutation method", path: ["requests", index, "method"] });
      if (!request.idempotencyKeyPrefix) context.addIssue({ code: "custom", message: "write canary requires idempotencyKeyPrefix", path: ["requests", index, "idempotencyKeyPrefix"] });
    }
  }
});

export type AdminCanaryPlan = z.input<typeof adminCanaryPlanSchema>;

export type AdminCanaryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AdminCanaryOptions {
  readonly fetch?: AdminCanaryFetch;
  readonly cookie?: string;
  readonly authorization?: string;
  readonly writeConfirmation?: string;
  readonly now?: () => Date;
}

function percentile(values: readonly number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "0.0.0.0" || normalized === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
  return normalized.startsWith("::ffff:127.");
}

export async function runAdminCanary(input: unknown, options: AdminCanaryOptions = {}) {
  const plan = adminCanaryPlanSchema.parse(input);
  const baseUrl = new URL(plan.baseUrl);
  if (baseUrl.protocol !== "https:" || isLoopbackHostname(baseUrl.hostname) || baseUrl.username || baseUrl.password) {
    throw new Error("Production Admin canary requires a non-local HTTPS base URL");
  }
  if (plan.mode === "write" && options.writeConfirmation !== "I_UNDERSTAND_THIS_MUTATES_PRODUCTION") {
    throw new Error("Explicit production write confirmation is required");
  }

  const request: AdminCanaryFetch = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const now = options.now ?? (() => new Date());
  const runId = randomUUID();
  const startedAt = now();
  const samples: Array<{
    name: string;
    method: string;
    path: string;
    status: number | null;
    outcome: "pass" | "unexpected_status" | "unavailable";
    durationMs: number;
  }> = [];

  for (let iteration = 0; iteration < plan.iterations; iteration += 1) {
    for (const [scenarioIndex, scenario] of plan.requests.entries()) {
      const headers = new Headers({
        accept: "application/json",
        "x-admin-canary-run-id": runId,
        "x-request-id": `${runId}:${scenario.name}:${iteration}`,
      });
      if (options.cookie) headers.set("cookie", options.cookie);
      if (options.authorization) headers.set("authorization", options.authorization);
      if (scenario.body !== undefined) headers.set("content-type", "application/json");
      if (plan.mode === "write") headers.set("idempotency-key", `${scenario.idempotencyKeyPrefix}:${runId}:${scenarioIndex}:${iteration}`);
      const sampleStartedAt = performance.now();
      try {
        const response = await request(new URL(scenario.path, baseUrl), {
          method: scenario.method,
          headers,
          body: scenario.body === undefined ? undefined : JSON.stringify(scenario.body),
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(plan.timeoutMs),
        });
        samples.push({
          name: scenario.name,
          method: scenario.method,
          path: scenario.path,
          status: response.status,
          outcome: scenario.expectedStatuses.includes(response.status) ? "pass" : "unexpected_status",
          durationMs: Math.max(0, performance.now() - sampleStartedAt),
        });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        samples.push({
          name: scenario.name,
          method: scenario.method,
          path: scenario.path,
          status: null,
          outcome: "unavailable",
          durationMs: Math.max(0, performance.now() - sampleStartedAt),
        });
      }
    }
  }

  const endedAt = now();
  const failures = samples.filter((sample) => sample.outcome !== "pass").length;
  const durations = samples.map((sample) => sample.durationMs);
  return {
    status: failures === 0 ? "pass" as const : "fail" as const,
    observedAt: endedAt.toISOString(),
    evidenceRefs: [`canary://${plan.mode}/${runId}`],
    mode: plan.mode,
    environment: plan.environment,
    runId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    sampleSize: samples.length,
    failures,
    availability: samples.length === 0 ? 0 : (samples.length - failures) / samples.length,
    p95Ms: percentile(durations, 0.95),
    samples,
  };
}
