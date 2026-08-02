import { characterVoiceActivationResponseSchema } from "@idream/shared/admin";
import { activateCharacterVoiceProfile } from "@/server/modules/admin-v2/characters/voice-identity";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id, profileId } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(
      request,
      "character.release.publish",
      { characterId: id },
    );
    return characterVoiceActivationResponseSchema.parse(
      await activateCharacterVoiceProfile({
        characterId: id,
        profileId,
        actor,
        idempotencyKey: requireIdempotencyKey(request),
        requestId:
          request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
        request: await jsonBody(request),
      }),
    );
  });
}
