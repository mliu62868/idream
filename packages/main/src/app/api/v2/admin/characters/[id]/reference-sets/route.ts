import {
  characterReferenceSetPublishResponseSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { publishCharacterReferenceSet } from "@/server/modules/admin-v2/characters/reference-set";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.official.write");
    const { id } = await context.params;
    const body = await jsonBody(request, "characterReferenceSetPublishRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.reference_set.publish",
      target: { type: "character", id },
      payload: body,
      mutate: (tx) => publishCharacterReferenceSet({ characterId: id, actor, requestId, request: body, tx }),
      decorateResult: (stored, replayed) =>
        characterReferenceSetPublishResponseSchema.parse({
          ...(stored as Record<string, unknown>),
          replayed,
        }),
    });
    return Response.json({ ok: true, data: result }, { status: 201 });
  });
}
