import { characterVoiceCloneCreateResponseSchema } from "@idream/shared/admin";
import {
  createCharacterVoiceClone,
  parseVoiceCloneForm,
} from "@/server/modules/admin-v2/characters/voice-identity";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
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
      "character.project.write",
      { characterId: id },
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const form = await parseVoiceCloneForm(request);
    return characterVoiceCloneCreateResponseSchema.parse(
      await createCharacterVoiceClone({
        characterId: id,
        actor,
        idempotencyKey,
        requestId,
        form,
      }),
    );
  });
}
