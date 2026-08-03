import { selectCharacterDraftImage } from "@/server/modules/admin-v2/characters/asset-studio";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import type { AdminV2RequestBody } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DraftImageSelection = AdminV2RequestBody<
  "characterDraftImageSelectionRequestSchema+idempotency-key+if-match"
>;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(() =>
    executeAdminMutation<DraftImageSelection>(
      "PATCH /api/v2/admin/characters/:id/draft-image",
      request,
      {
        params: { id },
        resource: { characterId: id },
        target: () => ({ type: "character", id }),
        expectedVersion: (body) => body.entityVersion,
        mutate: (tx, { actor, body, requestId }) => selectCharacterDraftImage({
          characterId: id,
          expectedProjectVersion: body.entityVersion,
          purpose: body.purpose,
          runId: body.runId,
          itemId: body.itemId,
          assetId: body.assetId,
          reviewDecisionId: body.reviewDecisionId,
          actor,
          reason: body.reason,
          requestId,
        }, tx),
      },
    )
  );
}
