import { readCharacterMediaLibraryContent } from "@/server/modules/character-media-library/admin-service";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request, context: { params: Promise<{ id: string; entryId: string }> }) {
  return adminV2Route(request, async () => {
    const { id, entryId } = await context.params;
    await actorWithPermission(request, "character.project.read", { characterId: id });
    const query = queryParams(request, "GET /api/v2/admin/characters/:id/media-library/:entryId/content");
    return readCharacterMediaLibraryContent({
      characterId: id,
      entryId,
      thumbnail: query.thumbnail === "1",
      request,
    });
  });
}
