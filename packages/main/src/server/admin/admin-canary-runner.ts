import { randomUUID } from "node:crypto";
import {
  ADMIN_CANARY_SCENARIO_IDS,
  requiredAdminCanaryScenarioIds,
  type AdminCanaryScenarioId,
} from "./canary";
import { canonicalJson } from "@idream/shared/contracts";
import { z } from "zod";

const canaryPathSchema = z.string().startsWith("/").superRefine((value, context) => {
  const sentinel = new URL("https://admin-canary.invalid");
  const target = new URL(value, sentinel);
  if (target.origin !== sentinel.origin) {
    context.addIssue({ code: "custom", message: "path must stay on the same origin as the configured base URL" });
    return;
  }
  if (target.pathname !== "/api/v2/admin" && !target.pathname.startsWith("/api/v2/admin/")) {
    context.addIssue({ code: "custom", message: "canary requests must target the Admin v2 API" });
  }
});

const canaryRequestSchema = z.object({
  scenarioId: z.enum(ADMIN_CANARY_SCENARIO_IDS),
  method: z.enum(["GET", "POST"]),
  path: canaryPathSchema,
  body: z.unknown().optional(),
}).strict();

const CASE_COMMAND_PATH = /^\/api\/v2\/admin\/cases\/([^/?]+)\/commands\/close$/;
const LIST_PATH = /^\/api\/v2\/admin\/(cases|creative\/runs|customers|incidents|jobs)\/?$/;
const DETAIL_PATH = /^\/api\/v2\/admin\/(cases|characters|creative\/runs|customers|incidents|jobs)\/[^/?]+\/?$/;

function pathnameAndSearch(path: string) {
  const url = new URL(path, "https://admin-canary.invalid");
  return { pathname: url.pathname, searchParams: url.searchParams };
}

function validateScenarioShape(
  request: z.infer<typeof canaryRequestSchema>,
  index: number,
  context: z.RefinementCtx,
) {
  const { pathname, searchParams } = pathnameAndSearch(request.path);
  const issue = (message: string, field: "method" | "path" | "body" = "path") =>
    context.addIssue({ code: "custom", message, path: ["requests", index, field] });

  if (request.scenarioId.startsWith("read.")) {
    if (request.method !== "GET") issue("read scenarios require GET", "method");
    if (request.body !== undefined) issue("read scenarios cannot send a body", "body");
  }
  if (request.scenarioId === "read.today" && pathname !== "/api/v2/admin/today") issue("read.today must target Today");
  if (request.scenarioId === "read.list" && !LIST_PATH.test(pathname)) issue("read.list must target a canonical bounded list");
  if (request.scenarioId === "read.detail" && !DETAIL_PATH.test(pathname)) issue("read.detail must target a canonical entity detail");
  if (request.scenarioId === "read.search") {
    if (pathname !== "/api/v2/admin/search") issue("read.search must target global Admin search");
    if ((searchParams.get("q") ?? "").trim().length < 2) issue("read.search requires a non-trivial q parameter");
  }

  if (["write.command.accept", "write.command.replay", "write.command.collision"].includes(request.scenarioId)) {
    if (request.method !== "POST") issue("command mutation scenarios require POST", "method");
    if (!CASE_COMMAND_PATH.test(pathname)) issue("write command scenarios must use canonical Case close authority");
    if (request.body === undefined) issue("command mutation scenarios require a body", "body");
  }
  if (request.scenarioId === "write.command.readback") {
    if (request.method !== "GET") issue("command readback requires GET", "method");
    if (request.path !== "/api/v2/admin/commands/{{commandId}}") issue("command readback must use the accepted commandId placeholder");
  }
  if (request.scenarioId === "write.state.readback") {
    if (request.method !== "GET") issue("state readback requires GET", "method");
    if (!/^\/api\/v2\/admin\/cases\/[^/?]+\/?$/.test(pathname)) issue("state readback must target the mutated Case detail");
  }
}

export const adminCanaryPlanSchema = z.object({
  schemaVersion: z.literal(2),
  environment: z.literal("production"),
  mode: z.enum(["read", "write"]),
  baseUrl: z.string().url(),
  iterations: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  idempotencyKeyPrefix: z.string().trim().min(1).max(120).optional(),
  requests: z.array(canaryRequestSchema).min(1).max(9),
}).strict().superRefine((plan, context) => {
  const required = requiredAdminCanaryScenarioIds(plan.mode);
  const actual = plan.requests.map((request) => request.scenarioId);
  if (actual.length !== required.length || new Set(actual).size !== required.length || required.some((id) => !actual.includes(id))) {
    context.addIssue({
      code: "custom",
      message: `${plan.mode} canary must contain every required scenario exactly once: ${required.join(", ")}`,
      path: ["requests"],
    });
  }
  for (const [index, request] of plan.requests.entries()) validateScenarioShape(request, index, context);

  if (plan.mode === "read" && plan.idempotencyKeyPrefix !== undefined) {
    context.addIssue({ code: "custom", message: "read canary does not accept an idempotency prefix", path: ["idempotencyKeyPrefix"] });
  }
  if (plan.mode === "write") {
    if (plan.iterations > 10) context.addIssue({ code: "custom", message: "write canary is bounded to 10 iterations", path: ["iterations"] });
    if (!plan.idempotencyKeyPrefix) context.addIssue({ code: "custom", message: "write canary requires idempotencyKeyPrefix", path: ["idempotencyKeyPrefix"] });
    const byId = new Map(plan.requests.map((request) => [request.scenarioId, request]));
    const accept = byId.get("write.command.accept");
    const replay = byId.get("write.command.replay");
    const collision = byId.get("write.command.collision");
    const state = byId.get("write.state.readback");
    if (accept && replay && (accept.path !== replay.path || canonicalJson(accept.body) !== canonicalJson(replay.body))) {
      context.addIssue({ code: "custom", message: "write.command.replay must repeat the exact accepted path and payload", path: ["requests"] });
    }
    if (accept && collision && (accept.path !== collision.path || canonicalJson(accept.body) === canonicalJson(collision.body))) {
      context.addIssue({ code: "custom", message: "write.command.collision must reuse the accepted path with a changed payload", path: ["requests"] });
    }
    const caseId = accept ? pathnameAndSearch(accept.path).pathname.match(CASE_COMMAND_PATH)?.[1] : undefined;
    if (caseId && state && pathnameAndSearch(state.path).pathname !== `/api/v2/admin/cases/${caseId}`) {
      context.addIssue({ code: "custom", message: "state readback must target the Case mutated by the command", path: ["requests"] });
    }
  }
});

export type AdminCanaryPlan = z.input<typeof adminCanaryPlanSchema>;

export type AdminCanaryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AdminCanaryAuthorityCommand {
  readonly iteration: number;
  readonly commandId: string;
  readonly requestId: string;
  readonly caseId: string;
}

export interface AdminCanaryAuthorityCheck {
  readonly iteration: number;
  readonly commandId: string;
  readonly commandStatus: string | null;
  readonly auditRecordId: string | null;
  readonly outboxEventId: string | null;
  readonly outcome: "pass" | "fail";
}

export interface AdminCanaryAuthorityProbeResult {
  readonly status: "pass" | "fail";
  readonly checks: readonly AdminCanaryAuthorityCheck[];
}

export type AdminCanaryAuthorityVerifier = (input: {
  readonly runId: string;
  readonly commands: readonly AdminCanaryAuthorityCommand[];
}) => Promise<AdminCanaryAuthorityProbeResult>;

export interface AdminCanaryOptions {
  readonly fetch?: AdminCanaryFetch;
  readonly cookie?: string;
  readonly authorization?: string;
  readonly writeConfirmation?: string;
  readonly verifyAuthority?: AdminCanaryAuthorityVerifier;
  readonly now?: () => Date;
}

type SampleOutcome = "pass" | "unexpected_status" | "unavailable" | "invalid_response" | "dependency_failed";

interface CanarySample {
  readonly iteration: number;
  readonly scenarioId: AdminCanaryScenarioId;
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly status: number | null;
  readonly outcome: SampleOutcome;
  readonly durationMs: number;
}

const scenarioLabels: Record<AdminCanaryScenarioId, string> = {
  "read.today": "Today projection",
  "read.list": "Canonical list",
  "read.detail": "Canonical detail",
  "read.search": "Global search",
  "write.command.accept": "Canonical command accept",
  "write.command.replay": "Same-key replay",
  "write.command.collision": "Changed-payload collision",
  "write.command.readback": "Command readback",
  "write.state.readback": "State readback",
};

const expectedStatus: Record<AdminCanaryScenarioId, number> = {
  "read.today": 200,
  "read.list": 200,
  "read.detail": 200,
  "read.search": 200,
  "write.command.accept": 202,
  "write.command.replay": 202,
  "write.command.collision": 409,
  "write.command.readback": 200,
  "write.state.readback": 200,
};

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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseData(payload: unknown) {
  return record(record(payload).data);
}

function linkedResponseIsValid(
  scenarioId: AdminCanaryScenarioId,
  payload: unknown,
  commandId: string | null,
  caseId: string | null,
) {
  const data = responseData(payload);
  if (scenarioId === "write.command.accept") return typeof data.commandId === "string" && data.commandId.length > 0;
  if (scenarioId === "write.command.replay" || scenarioId === "write.command.readback") return data.commandId === commandId;
  if (scenarioId === "write.state.readback") {
    const stateCase = record(data.case);
    return stateCase.id === caseId && stateCase.status === "closed";
  }
  return true;
}

function parseJson(text: string) {
  try {
    return { parsed: true as const, value: JSON.parse(text) as unknown };
  } catch {
    return { parsed: false as const, value: null };
  }
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
  if (plan.mode === "write" && !options.verifyAuthority) {
    throw new Error("Production write canary requires the Audit/Outbox authority verifier");
  }

  const request: AdminCanaryFetch = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const now = options.now ?? (() => new Date());
  const runId = randomUUID();
  const startedAt = now();
  const samples: CanarySample[] = [];
  const authorityCommands: AdminCanaryAuthorityCommand[] = [];
  const scenarioMap = new Map(plan.requests.map((scenario) => [scenario.scenarioId, scenario]));
  const orderedScenarioIds = requiredAdminCanaryScenarioIds(plan.mode);

  for (let iteration = 0; iteration < plan.iterations; iteration += 1) {
    let commandId: string | null = null;
    const commandPath = scenarioMap.get("write.command.accept")?.path;
    const caseId = commandPath ? pathnameAndSearch(commandPath).pathname.match(CASE_COMMAND_PATH)?.[1] ?? null : null;
    const sharedIdempotencyKey = plan.mode === "write"
      ? `${plan.idempotencyKeyPrefix}:${runId}:${iteration}`
      : null;

    for (const scenarioId of orderedScenarioIds) {
      const scenario = scenarioMap.get(scenarioId)!;
      const requestId = `${runId}:${scenarioId}:${iteration}`;
      const resolvedPath = scenarioId === "write.command.readback" && commandId
        ? scenario.path.replace("{{commandId}}", encodeURIComponent(commandId))
        : scenario.path;
      if (scenarioId === "write.command.readback" && !commandId) {
        samples.push({ iteration, scenarioId, name: scenarioLabels[scenarioId], method: scenario.method, path: scenario.path, status: null, outcome: "dependency_failed", durationMs: 0 });
        continue;
      }
      const headers = new Headers({
        accept: "application/json",
        "x-admin-canary-run-id": runId,
        "x-request-id": requestId,
      });
      if (options.cookie) headers.set("cookie", options.cookie);
      if (options.authorization) headers.set("authorization", options.authorization);
      if (scenario.body !== undefined) headers.set("content-type", "application/json");
      if (sharedIdempotencyKey && scenarioId.startsWith("write.command.") && !scenarioId.endsWith("readback")) {
        headers.set("idempotency-key", sharedIdempotencyKey);
      }

      const sampleStartedAt = performance.now();
      try {
        const response = await request(new URL(resolvedPath, baseUrl), {
          method: scenario.method,
          headers,
          body: scenario.body === undefined ? undefined : JSON.stringify(scenario.body),
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(plan.timeoutMs),
        });
        const parsed = parseJson(await response.text());
        let outcome: SampleOutcome = response.status === expectedStatus[scenarioId]
          ? "pass"
          : "unexpected_status";
        if (outcome === "pass" && !parsed.parsed) outcome = "invalid_response";
        if (outcome === "pass" && !linkedResponseIsValid(scenarioId, parsed.value, commandId, caseId)) outcome = "invalid_response";
        if (scenarioId === "write.command.accept" && outcome === "pass") {
          commandId = String(responseData(parsed.value).commandId);
          if (caseId) authorityCommands.push({ iteration, commandId, requestId, caseId });
        }
        samples.push({
          iteration,
          scenarioId,
          name: scenarioLabels[scenarioId],
          method: scenario.method,
          path: resolvedPath,
          status: response.status,
          outcome,
          durationMs: Math.max(0, performance.now() - sampleStartedAt),
        });
      } catch {
        samples.push({
          iteration,
          scenarioId,
          name: scenarioLabels[scenarioId],
          method: scenario.method,
          path: resolvedPath,
          status: null,
          outcome: "unavailable",
          durationMs: Math.max(0, performance.now() - sampleStartedAt),
        });
      }
    }
  }

  let authorityProbe: AdminCanaryAuthorityProbeResult | null = null;
  if (plan.mode === "write") {
    try {
      const candidate = await options.verifyAuthority!({ runId, commands: authorityCommands });
      const complete = candidate.checks.length === plan.iterations
        && candidate.checks.every((check, index) => check.iteration === index && check.outcome === "pass")
        && authorityCommands.length === plan.iterations;
      authorityProbe = complete && candidate.status === "pass"
        ? candidate
        : { status: "fail", checks: candidate.checks };
    } catch {
      authorityProbe = { status: "fail", checks: [] };
    }
  }

  const endedAt = now();
  const failures = samples.filter((sample) => sample.outcome !== "pass").length;
  const durations = samples.map((sample) => sample.durationMs);
  const passed = failures === 0 && (plan.mode === "read" || authorityProbe?.status === "pass");
  return {
    status: passed ? "pass" as const : "fail" as const,
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
    authorityProbe,
  };
}
