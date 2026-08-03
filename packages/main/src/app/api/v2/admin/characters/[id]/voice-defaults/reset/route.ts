import { characterVoiceSystemDefaultResetResponseSchema } from "@idream/shared/admin";
import { resetCharacterVoiceToSystemDefault } from "@/server/modules/admin-v2/characters/voice-identity";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(
      request,
      "character.release.publish",
      { characterId: id },
    );
    return characterVoiceSystemDefaultResetResponseSchema.parse(
      await resetCharacterVoiceToSystemDefault({
        characterId: id,
        actor,
        idempotencyKey: requireIdempotencyKey(request),
        requestId:
          request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
        request: await jsonBody(
          request,
          "characterVoiceSystemDefaultResetRequestSchema+idempotency-key",
        ),
      }),
    );
  });
}
