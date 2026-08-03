import { env } from "@/server/lib/env";
import { archiveCharacterLookAsAdmin } from "@/server/modules/admin-v2/characters/looks";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; lookId: string }> },
) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "content.official.write");
    const { id, lookId } = await context.params;
    const body = await jsonBody(request, "characterLookArchiveRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId =
      request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.look.archive",
      target: { type: "character_look", id: lookId },
      payload: {
        characterId: id,
        ...body,
      },
      mutate: (tx) =>
        archiveCharacterLookAsAdmin({
          characterId: id,
          lookId,
          actor,
          requestId,
          request: body,
          tx,
        }),
    });
    return Response.json({ ok: true, data: result });
  });
}
