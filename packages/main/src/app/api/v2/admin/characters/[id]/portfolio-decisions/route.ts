import { env } from "@/server/lib/env";
import { createCharacterPortfolioDecisionInTransaction } from "@/server/modules/admin-v2/characters/portfolio";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "characterPortfolioDecisionRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const data = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.portfolio.decision.record",
      target: { type: "character", id },
      payload: body,
      mutate: (tx) => createCharacterPortfolioDecisionInTransaction(tx, { characterId: id, actor, requestId, body }),
    });
    return Response.json({ ok: true, data }, { status: 201 });
  });
}
