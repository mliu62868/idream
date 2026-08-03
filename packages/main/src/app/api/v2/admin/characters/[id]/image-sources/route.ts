import {
  characterImageSourceListResponseSchema,
  characterImageSourceUploadResponseSchema,
} from "@idream/shared/admin";
import {
  createCharacterImageSource,
  listCharacterImageSources,
  parseCharacterImageSourceForm,
} from "@/server/modules/admin-v2/characters/image-sources";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(
      request,
      "character.project.read",
      { characterId: id },
    );
    return characterImageSourceListResponseSchema.parse(
      await listCharacterImageSources({ characterId: id }),
    );
  });
}

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
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId =
      request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const form = await parseCharacterImageSourceForm(request);
    return characterImageSourceUploadResponseSchema.parse(
      await createCharacterImageSource({
        characterId: id,
        actor,
        idempotencyKey,
        requestId,
        form,
      }),
    );
  });
}
