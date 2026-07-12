import { adminBackfillResultSchema, type AdminBackfillRequest } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

type BackfillDomain = "generation_incident_v1" | "customer_case_v1" | "review_case_v1";
type BackfillActor = { readonly id: string; readonly role: string };

export function stableAdminBackfillRunId(input: {
  readonly environment: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly domain: BackfillDomain;
}) {
  return `admin_backfill_${canonicalSha256(input).slice(0, 32)}`;
}

export function adminBackfillOptionsHash(input: {
  readonly domain: BackfillDomain;
  readonly body: AdminBackfillRequest;
  readonly actor: BackfillActor;
}) {
  return canonicalSha256({
    domain: input.domain,
    mode: input.body.dryRun ? "dry_run" : "apply",
    batchSize: input.body.batchSize ?? 100,
    initialCursor: input.body.cursor ?? null,
    actor: input.actor,
  });
}

export async function executeAdminBackfillHttpMutation(input: {
  readonly request: Request;
  readonly actor: BackfillActor;
  readonly domain: BackfillDomain;
  readonly body: AdminBackfillRequest;
  readonly execute: (identity: { readonly stableRunId: string; readonly optionsHash: string }) => Promise<unknown>;
}) {
  const idempotencyKey = requireIdempotencyKey(input.request);
  const requestId = input.request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const stableRunId = stableAdminBackfillRunId({
    environment: env.APP_ENV,
    actorId: input.actor.id,
    idempotencyKey,
    domain: input.domain,
  });
  const optionsHash = adminBackfillOptionsHash({ domain: input.domain, body: input.body, actor: input.actor });
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey,
    requestId,
    commandType: `admin.backfill.${input.domain}`,
    target: { type: "admin_backfill_run", id: stableRunId },
    payload: input.body,
    mutate: async (tx) => {
      const result = adminBackfillResultSchema.parse(await input.execute({ stableRunId, optionsHash }));
      await tx.adminAuditLog.create({
        data: {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: "admin.backfill.executed",
          targetType: "admin_backfill_run",
          targetId: stableRunId,
          reason: `Execute ${input.domain} backfill`,
          after: toInputJson({ domain: input.domain, optionsHash, status: result.status }),
          requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "admin.backfill.executed.v2",
          aggregateType: "admin_backfill_run",
          aggregateId: stableRunId,
          payload: toInputJson(result),
        },
      });
      return result;
    },
  });
}
