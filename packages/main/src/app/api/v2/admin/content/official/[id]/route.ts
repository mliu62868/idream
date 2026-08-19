import { updateOfficialCharacter } from "@/server/modules/admin-v2/content/official";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.official.write");
    // INVARIANT: 编辑官方角色资料就是编辑 Character Project 草稿，所以 Project 写权限也必须成立。
    await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "contentOfficialUpdateRequestSchema");
    return updateOfficialCharacter({ request, actor, id, body });
  });
}
