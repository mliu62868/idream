import { parseArgs } from "node:util";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { classifyExistingCustomerMetricActor } from "@/server/modules/admin-v2/metrics/event-classification";
import { summarizeGenerationDiagnostics } from "@/server/modules/admin-v2/metrics/generation-diagnostics";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      hours: { type: "string", default: "168" }, limit: { type: "string", default: "1000" },
      "profile-id": { type: "string" }, "data-class": { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write("Usage: generation:diagnostics [--hours 168] [--limit 1000] [--profile-id ID] [--data-class customer|internal|fixture|audit]\n"
      + "Read-only operational report. Exit 0 = complete selected window; 2 = capped sample; 1 = execution error.\n");
    return;
  }
  const hours = Number(values.hours);
  const limit = Number(values.limit);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 2160) throw new Error("--hours must be greater than 0 and at most 2160");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("--limit must be an integer from 1 to 10000");
  if (values["data-class"] && !["customer", "internal", "fixture", "audit"].includes(values["data-class"])) {
    throw new Error("--data-class must be customer, internal, fixture, or audit");
  }
  const asOf = new Date();
  const windowStart = new Date(asOf.getTime() - hours * 60 * 60 * 1000);
  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const selectedJobs = await tx.generationJob.findMany({
      where: {
        createdAt: { gte: windowStart, lte: asOf },
        ...(values["profile-id"] ? { profileId: values["profile-id"] } : {}),
        ...(values["data-class"] ? { user: { dataClass: values["data-class"] } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: {
        id: true, mode: true, status: true, sourceType: true, profileId: true, profileVersion: true,
        model: true, provider: true, createdAt: true, finishedAt: true, completedAt: true,
        user: { select: { id: true, email: true, role: true, status: true, dataClass: true, deletedAt: true } },
      },
    });
    const truncated = selectedJobs.length > limit;
    const jobs = selectedJobs.slice(0, limit).map(({ user, ...job }) => ({
      ...job, dataClass: classifyExistingCustomerMetricActor(user).dataClass,
    }));
    const attempts = await tx.generationAttempt.findMany({
      where: { requestId: { in: jobs.map((job) => job.id) } },
      select: {
        id: true, requestId: true, attemptNo: true, profileKey: true, profileVersion: true,
        workflowKey: true, workflowVersion: true, provider: true, status: true, createdAt: true, startedAt: true,
      },
    });
    const transports = await tx.generationTransportExecution.findMany({
      where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
      select: { id: true, attemptId: true, transportAttemptNo: true, status: true, latencyMs: true, startedAt: true, finishedAt: true },
    });
    const usage = await tx.aiUsageFact.findMany({
      where: { sourceService: "gen", transportExecutionId: { in: transports.map((transport) => transport.id) } },
      select: { transportExecutionId: true, provider: true, model: true, usage: true },
    });
    return { truncated, selectedJobs: jobs.length, selectedAttempts: attempts.length, selectedInvocations: transports.length,
      groups: summarizeGenerationDiagnostics({ jobs, attempts, transports, usage }) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
  const database = new URL(env.DATABASE_URL);
  process.stdout.write(`${JSON.stringify({
    scope: "operational_diagnostics_only", environment: env.APP_ENV,
    database: { host: database.hostname, port: database.port || "5432", name: database.pathname.slice(1) },
    asOf: asOf.toISOString(), windowStart: windowStart.toISOString(), limit,
    filters: { profileId: values["profile-id"] ?? null, storedUserDataClass: values["data-class"] ?? null },
    definitions: {
      population: "Requests created in the window; all associated attempts and invocations, including retries. User-selected workloads may vary within pinned profiles; this is not a controlled model benchmark. Current authority state, not historical state reconstruction.",
      dataClass: "Current user authority including internal/fixture overrides; stored user data class is used for the optional filter. No eligibility or commercial certification is inferred.",
      queueMs: "Attempt createdAt to startedAt; includes admission and shared-device wait before provider entry. Missing/negative timestamps are missing, not zero.",
      executionMs: "Recorded invocation latencyMs from provider-entry authority to adapter result, excluding resource wait; not pure model inference.",
      endToEndMs: "Request creation to terminal completion/finalization, counted only under latest attempt pins. Failure latency is included; successfulEndToEndMs reports completed requests separately.",
      performance: "usage.performance preserved as recorded. requests[].waitMs includes Comfy queue/execution/polling. providerExecutionMs is provider-history execution span including model loading. Missing observations remain null.",
      percentiles: "Nearest-rank p50/p95 over measured nonnegative milliseconds; small samples are descriptive only.",
    },
    ...report,
  }, null, 2)}\n`);
  if (report.truncated) process.exitCode = 2;
}

main().finally(() => prisma.$disconnect()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
