import { setOfficialState } from "@/server/modules/admin-v2/content/official";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.official.write");
    // INVARIANT: 上下架就是发布/暂停 Serving，所以 content.official.write 不足以单独放行。
    await actorWithPermission(request, "character.release.publish");
    const body = await jsonBody(request, "contentOfficialStateRequestSchema");
    return setOfficialState({ request, actor, id, body });
  });
}
