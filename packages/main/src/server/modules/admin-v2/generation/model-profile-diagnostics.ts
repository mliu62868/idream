// SPEC: the evidence an operator gathers before publishing a Generation model profile —
//       observed health over a window, a provider-free configuration check, and a real
//       profile-test image.
// INTENT: migrated from v1 `generation-health.ts` plus the `test-job` branch of the config
//         service. The configuration check deliberately calls no provider: it is a
//         deterministic read of the profile against its own sample matrix, and its verdict is
//         what `publish` later admits against.
// INVARIANT: the persisted `dryRunSummary` keeps whatever an earlier run left behind (publish
//            admissibility reads it), while the response only carries this run's verdict.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { generationProfileTestJobResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  OPERATIONAL_METRIC_DATA_SCOPE,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import { dimensionsForImageOrientation } from "@/server/modules/ourdream/generation-dimensions";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt,
} from "@/server/modules/generation/generation-attempt-authority";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { jsonRecord, jsonStrings, toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  adminRequestId,
  assertTargetConfirmation,
  stringFromRecord,
  writeProfileAudit,
} from "./model-profiles";

function percentile(sortedMs: readonly number[], p: number): number | null {
  if (sortedMs.length === 0) return null;
  const index = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return Math.round(sortedMs[index]!);
}

export async function getGenerationProfileHealth(request: Request, profileId: string) {
  await actorWithPermission(request, "generation.config.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/model-profiles/:id/health");
  const days = query.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const profile = await prisma.generationModelProfile.findUnique({
    where: { id: profileId },
    select: { id: true, profileKey: true },
  });
  if (!profile) throw Errors.notFound("Model profile not found");

  const where = operationalGenerationJobWhere({
    profileId: { in: [profile.id, profile.profileKey] },
    createdAt: { gte: since },
  });
  const [total, completed, failed, blocked, refunded, done] = await Promise.all([
    prisma.generationJob.count({ where }),
    prisma.generationJob.count({ where: { ...where, status: "completed" } }),
    prisma.generationJob.count({ where: { ...where, status: "failed" } }),
    prisma.generationJob.count({ where: { ...where, status: "blocked" } }),
    prisma.generationJob.count({ where: { ...where, status: "refunded" } }),
    prisma.generationJob.findMany({
      where: { ...where, status: "completed", completedAt: { not: null } },
      select: { createdAt: true, completedAt: true },
      take: 1000,
    }),
  ]);

  const durations = done
    .map((job) => (job.completedAt ? job.completedAt.getTime() - job.createdAt.getTime() : 0))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  const finished = completed + failed + blocked;

  return {
    dataScope: OPERATIONAL_METRIC_DATA_SCOPE,
    profileId: profile.id,
    profileKey: profile.profileKey,
    window: { from: since.toISOString(), days },
    metrics: {
      total,
      completed,
      failed,
      blocked,
      refunded,
      successRate: finished > 0 ? Math.round((completed / finished) * 100) : null,
      blockedRate: finished > 0 ? Math.round((blocked / finished) * 100) : null,
      refundRate: total > 0 ? Math.round((refunded / total) * 100) : null,
      latencyP50Ms: percentile(durations, 50),
      latencyP95Ms: percentile(durations, 95),
      latencySamples: durations.length,
    },
  };
}

export async function runGenerationProfileDryRun(request: Request, profileId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationConfigCommandRequestSchema+idempotency-key");
  if (body.confirmation !== profileId) {
    throw Errors.badRequest("Confirmation did not match dry-run target");
  }
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "generation.profile.dry_run",
    target: { type: "generation_model_profile", id: profileId },
    payload: body,
    mutate: async (tx) => {
      const profile = await tx.generationModelProfile.findUnique({
        where: { id: profileId },
        select: {
          mode: true,
          allowedOrientations: true,
          pipelineModel: true,
          maxCount: true,
          steps: true,
          runnerConfig: true,
          dryRunSummary: true,
        },
      });
      if (!profile) throw Errors.notFound("Model profile not found");

      const orientations = jsonStrings(profile.allowedOrientations);
      const useCases = profile.mode === "video" ? ["freeplay"] : ["character", "freeplay"];
      const samples: { useCase: string; orientation: string; ok: boolean; issues: string[] }[] = [];
      for (const useCase of useCases) {
        for (const orientation of orientations.length ? orientations : ["1:1"]) {
          const issues: string[] = [];
          if (!profile.pipelineModel.trim()) issues.push("pipelineModel empty");
          if (profile.maxCount < 1) issues.push("maxCount < 1");
          if (profile.steps < 1) issues.push("steps < 1");
          if (!orientations.length) issues.push("no allowedOrientations");
          issues.push(...runnerConfigIssues(profile.runnerConfig));
          samples.push({ useCase, orientation, ok: issues.length === 0, issues });
        }
      }
      const passed = samples.filter((sample) => sample.ok).length;
      const status = passed === samples.length ? "pass" : "fail";
      const previousSummary = jsonRecord(profile.dryRunSummary);
      const previousFailureMode = stringFromRecord(previousSummary, "failureMode");
      const failureMode = previousFailureMode ??
        (status === "fail" ? failureModeForSamples(samples) : undefined);
      const verdict = {
        status: status as "pass" | "fail",
        passed,
        total: samples.length,
        sampleCount: samples.length,
        configurationPassRate: samples.length > 0 ? passed / samples.length : 0,
        samples,
        ...(failureMode ? { failureMode } : {}),
      };
      await tx.generationModelProfile.update({
        where: { id: profileId },
        data: {
          dryRunSummary: toInputJson({
            ...previousSummary,
            source: "admin_console_configuration_check",
            ranBy: actor.id,
            ...verdict,
          }),
        },
      });
      await writeProfileAudit(tx, actor, requestId, {
        action: "generation.profile.dry_run",
        targetId: profileId,
        reason: body.reason,
        after: { status, passed, total: samples.length },
      });
      return { dryRun: verdict };
    },
  });
}

export async function createGenerationProfileTestJob(request: Request, profileId: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = await jsonBody(request, "generationProfileTestJobRequestSchema+idempotency-key");
  const requestId = adminRequestId(request);
  const result = generationProfileTestJobResponseSchema.parse(
    await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey: requireIdempotencyKey(request),
      requestId,
      commandType: "generation.profile.test_job",
      target: { type: "generation_model_profile", id: profileId },
      payload: body,
      mutate: async (tx) => {
        const profile = await tx.generationModelProfile.findUnique({ where: { id: profileId } });
        if (!profile) throw Errors.notFound("Model profile not found");
        assertTargetConfirmation(body.confirmation, profile.id);
        if (profile.status === "archived") {
          throw Errors.badRequest("Archived profiles cannot create test jobs");
        }
        if (profile.mode !== "image") {
          throw Errors.badRequest("Admin test image currently supports image profiles only");
        }
        const allowedOrientations = jsonStrings(profile.allowedOrientations);
        const orientation = body.orientation ?? allowedOrientations[0] ?? "1:1";
        if (allowedOrientations.length > 0 && !allowedOrientations.includes(orientation)) {
          throw Errors.badRequest("Orientation is not allowed for this profile", {
            orientation,
            allowedOrientations,
          });
        }
        const outputCount = Math.min(body.outputCount, profile.maxCount, 4);
        const dimensions = dimensionsForImageOrientation({
          orientation,
          defaultWidth: profile.defaultWidth,
          defaultHeight: profile.defaultHeight,
        });
        const created = await tx.generationJob.create({
          data: {
            userId: actor.id,
            mode: "image",
            prompt: body.prompt?.trim() || `Admin test image for ${profile.label}`,
            negativePrompt: body.negativePrompt?.trim() || null,
            controls: toInputJson({
              orientation,
              model: profile.profileKey,
              profileId: profile.profileKey,
              width: dimensions.width,
              height: dimensions.height,
              adminTest: true,
            }),
            presetIds: [],
            model: profile.pipelineModel,
            profileId: profile.profileKey,
            profileVersion: profile.version,
            orientation,
            outputCount,
            status: "queued",
            costDreamcoins: 0,
            provider: profile.runner,
            sourceType: "admin_profile_test",
            sourceId: `${profile.id}:${randomUUID()}`,
            sourceMeta: toInputJson({ profileRecordId: profile.id }),
          },
        });
        await appendTestJobEvent(tx, created.id, "created", "Admin profile test job accepted", {
          profileId: profile.profileKey,
          profileVersion: profile.version,
          source: "admin_generation_config",
        });
        await appendTestJobEvent(tx, created.id, "queued", "Admin profile test job queued", {});
        await reserveInitialGenerationAttempt(tx, {
          requestId: created.id,
          dispatch: {
            outboxId: `generation_initial_${created.id}`,
            eventType: "generation.retry.dispatch.v2",
            payload: { source: "admin_profile_test" },
          },
        });
        await writeProfileAudit(tx, actor, requestId, {
          action: "generation.profile.test_job",
          targetId: profile.id,
          reason: body.reason,
          after: {
            jobId: created.id,
            profileKey: profile.profileKey,
            profileVersion: profile.version,
            orientation,
            outputCount,
          },
        });
        return {
          job: {
            id: created.id,
            status: created.status,
            mode: created.mode,
            profileId: created.profileId,
            profileVersion: created.profileVersion,
            orientation: created.orientation,
            outputCount: created.outputCount,
            createdAt: created.createdAt.toISOString(),
          },
        };
      },
    }),
  );
  // INVARIANT: dispatch happens after the reservation commits. Replaying the same idempotency
  // key re-runs this and finds nothing pending, which is the intended no-op.
  await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [`generation_initial_${result.job.id}`],
  });
  return ok(result, { status: 202 });
}

function failureModeForSamples(samples: readonly { issues: string[] }[]) {
  const issues = samples.flatMap((sample) => sample.issues).join(" ").toLowerCase();
  if (issues.includes("missing") || issues.includes("not_imported")) return "missing_runtime_components";
  if (issues.includes("unsupported")) return "unsupported_runtime_components";
  if (issues.includes("failed")) return "failed_runtime_components";
  return "configuration_failed";
}

function runnerConfigIssues(runnerConfig: Prisma.JsonValue) {
  const config = jsonRecord(runnerConfig);
  const issues: string[] = [];
  const verificationStatus = stringFromRecord(config, "verificationStatus");
  if (verificationStatus && !["passed", "verified", "manual_passed"].includes(verificationStatus)) {
    issues.push(`verificationStatus is ${verificationStatus}`);
  }
  const componentStatus = jsonRecord(config.componentStatus as Prisma.JsonValue);
  for (const [key, value] of Object.entries(componentStatus)) {
    const status = typeof value === "string"
      ? value
      : stringFromRecord(jsonRecord(value as Prisma.JsonValue), "status");
    if (!status) continue;
    const normalized = status.toLowerCase();
    if (
      normalized.includes("missing") ||
      normalized.includes("failed") ||
      normalized.includes("unsupported") ||
      normalized.includes("not_imported")
    ) {
      issues.push(`component ${key} is ${status}`);
    }
  }
  return issues;
}

function appendTestJobEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: { jobId, type, message, metadata: toInputJson(metadata) },
  });
}
