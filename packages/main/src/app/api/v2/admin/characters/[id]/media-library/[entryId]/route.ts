import { characterMediaLibraryMutationResponseSchema } from "@idream/shared/admin";
import { updateCharacterMediaLibraryEntry } from "@/server/modules/character-media-library/admin-service";
import {
  actorWithPermission,
  jsonBody,
  requireActorPermission,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; entryId: string }> },
) {
  return adminV2Route(request, async () => {
    const { id, entryId } = await context.params;
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "PATCH /api/v2/admin/characters/:id/media-library/:entryId");
    if (body.status === "published" || body.status === "withdrawn") {
      await requireActorPermission(request, actor, "character.release.publish", { characterId: id });
    }
    // Main additionally checks the persisted status under its mutation lock:
    // omitting status must not bypass publication permission for a live entry.
    return characterMediaLibraryMutationResponseSchema.parse(
      await updateCharacterMediaLibraryEntry({
        characterId: id, entryId, actor, body,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
      }),
    );
  });
}
