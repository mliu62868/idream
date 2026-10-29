import { characterMediaLibrarySearchResponseSchema } from "@idream/shared/admin";
import { previewCharacterMediaLibrarySearch } from "@/server/modules/character-media-library/admin-service";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    await actorWithPermission(request, "character.project.read", { characterId: id });
    const body = await jsonBody(request, "POST /api/v2/admin/characters/:id/media-library/search-preview");
    return characterMediaLibrarySearchResponseSchema.parse(
      await previewCharacterMediaLibrarySearch({ characterId: id, body }),
    );
  });
}
