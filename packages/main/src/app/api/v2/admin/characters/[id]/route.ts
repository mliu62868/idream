import { characterWorkspaceDetailSchema } from "@idream/shared/admin";
import { actorWithPermission } from "@/server/modules/admin/service";
import { getCharacterWorkspace } from "@/server/modules/admin-v2/characters/workspace";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.project.read", { characterId: id });
    await actorWithPermission(request, "character.release.read", { characterId: id });
    await actorWithPermission(request, "character.performance.read", { characterId: id });
    return characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(id));
  });
}
