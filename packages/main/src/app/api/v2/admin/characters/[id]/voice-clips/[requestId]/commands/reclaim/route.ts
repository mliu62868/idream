import { characterVoiceClipReclaimResponseSchema } from "@idream/shared/admin";
import { reclaimCharacterVoiceClip } from "@/server/modules/admin-v2/characters/voice-clip-reclaim";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; requestId: string }> },
) {
  const { id, requestId } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(
      request,
      "character.project.write",
      { characterId: id },
    );
    return characterVoiceClipReclaimResponseSchema.parse(
      await reclaimCharacterVoiceClip({
        characterId: id,
        requestId,
        actor,
        idempotencyKey: requireIdempotencyKey(request),
        transportRequestId:
          request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
        request: await jsonBody(
          request,
          "characterVoiceClipReclaimRequestSchema+idempotency-key",
        ),
      }),
    );
  });
}
