import { characterMediaLibraryBatchReviewResponseSchema } from "@idream/shared/admin";
import { batchReviewCharacterMediaLibrary } from "@/server/modules/character-media-library/admin-service";
import { actorWithPermission, jsonBody, requireActorPermission } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    const actor = await actorWithPermission(request, "creative.run.write", { characterId: id });
    await requireActorPermission(request, actor, "character.release.publish", { characterId: id });
    const body = await jsonBody(request, "POST /api/v2/admin/characters/:id/media-library/batch-review");
    return characterMediaLibraryBatchReviewResponseSchema.parse(
      await batchReviewCharacterMediaLibrary({
        characterId: id,
        actor,
        body,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
      }),
    );
  });
}
