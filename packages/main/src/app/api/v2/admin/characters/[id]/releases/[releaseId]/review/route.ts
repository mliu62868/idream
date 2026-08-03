import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { reviewCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { characterReleaseContract } from "@/server/modules/admin-v2/characters/character-release-contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; releaseId: string }> }) {
  const { id, releaseId } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.release.review", { characterId: id });
    const body = await jsonBody(request, "characterReleaseReviewRequestSchema+idempotency-key+if-match");
    const ifMatch = request.headers.get("if-match")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    if (!ifMatch || !/^\d+$/.test(ifMatch) || Number(ifMatch) !== body.entityVersion) {
      throw Errors.badRequest("If-Match must equal body entityVersion");
    }
    if (body.confirmation !== `${id}:${releaseId}:${body.decision}`) throw Errors.badRequest("Confirmation did not match Release review target");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.release.review",
      target: { type: "character_release", id: releaseId },
      expectedVersion: body.entityVersion,
      payload: { characterId: id, releaseId, ...body },
      mutate: (tx) => reviewCharacterRelease({
        request,
        characterId: id,
        releaseId,
        expectedVersion: body.entityVersion,
        decision: body.decision,
        reason: body.reason,
        actor,
        requestId,
      }, tx),
      decorateResult: (result) => characterReleaseContract(result),
    });
  });
}
