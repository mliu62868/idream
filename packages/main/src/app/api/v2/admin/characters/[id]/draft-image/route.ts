import {
  characterDraftImageSelectionRequestSchema,
  characterDraftImageSelectionResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { selectCharacterDraftImage } from "@/server/modules/admin-v2/characters/asset-studio";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = characterDraftImageSelectionRequestSchema.parse(await request.json());
    requireMatchingProjectVersion(request, body.entityVersion);
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return characterDraftImageSelectionResultSchema.parse(
      await executeAtomicIdempotentMutation({
        environment: env.APP_ENV,
        actor,
        idempotencyKey,
        requestId,
        commandType: "character.project.draft_image.select",
        target: { type: "character", id },
        expectedVersion: body.entityVersion,
        payload: body,
        mutate: (tx) => selectCharacterDraftImage({
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
      }),
    );
  });
}
