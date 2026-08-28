import { characterVideoSourceUploadResponseSchema } from "@idream/shared/admin";
import {
  createCharacterVideoSource,
  parseCharacterVideoSourceForm,
} from "@/server/modules/admin-v2/characters/video-sources";
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
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(
      request,
      "character.project.write",
      { characterId: id },
    );
    const form = await parseCharacterVideoSourceForm(request);
    return characterVideoSourceUploadResponseSchema.parse(
      await createCharacterVideoSource({
        characterId: id,
        actor,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
        form,
      }),
    );
  });
}
