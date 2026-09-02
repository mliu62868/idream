import {
  actorWithPermission,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { reviewImportedCharacterImage } from "@/server/modules/admin-v2/characters/image-qualification";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CharacterImageReview = AdminV2RequestBody<
  "characterImageReviewRequestSchema+idempotency-key"
>;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; assetId: string }> },
) {
  const { id, assetId } = await context.params;
  return adminV2Route(request, async () => {
    // executeAdminMutation enforces the manifest's first static permission;
    // keep the second all-of permission explicit until that shared executor
    // accepts the complete authorization expression.
    await actorWithPermission(
      request,
      "creative.run.review",
      { characterId: id },
    );
    return executeAdminMutation<CharacterImageReview>(
      "POST /api/v2/admin/characters/:id/image-sources/:assetId/reviews",
      request,
      {
        params: { id, assetId },
        resource: { characterId: id },
        target: () => ({ type: "media_asset", id: assetId }),
        reason: (body) => body.reason,
        mutate: (tx, { actor, body, requestId }) =>
          reviewImportedCharacterImage(
            {
              characterId: id,
              assetId,
              actor,
              review: body,
              requestId,
            },
            tx,
          ),
        decorateResult: (result, replayed) => ({
          ...(result as Record<string, unknown>),
          replayed,
        }),
      },
    );
  });
}
