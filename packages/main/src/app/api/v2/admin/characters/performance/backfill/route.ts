import {
  characterPerformanceBackfillResponseSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { backfillCharacterFunnelFacts, backfillCharacterVariableCostFacts } from "@/server/modules/admin-v2/characters/performance-facts";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "analytics.metric.export");
    const body = await jsonBody(request, "characterPerformanceBackfillRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.performance.backfill",
      target: { type: "character_performance", id: `${body.kind}:${body.source}` },
      payload: body,
      mutate: async (tx) => {
        const rawResult = body.kind === "funnel"
          ? await backfillCharacterFunnelFacts(tx, body)
          : await backfillCharacterVariableCostFacts(tx, body);
        const result = characterPerformanceBackfillResponseSchema.parse(rawResult);
        await tx.adminAuditLog.create({ data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: "character.performance.backfill",
          targetType: "character_performance",
          targetId: `${body.kind}:${body.source}`,
          reason: `Run ${body.kind} performance backfill`,
          after: toInputJson(result),
          requestId,
        } });
        await tx.mainOutboxEvent.create({ data: {
          eventType: "character.performance.backfilled.v2",
          aggregateType: "character_performance",
          aggregateId: `${body.kind}:${body.source}`,
          payload: toInputJson(result),
        } });
        return result;
      },
    });
  });
}
