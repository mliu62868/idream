import { setCharacterChatTools } from "@/server/modules/admin-v2/content/chat-tools";
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
    const actor = await actorWithPermission(request, "content.production.write");
    const body = await jsonBody(request, "contentCharacterChatToolsRequestSchema");
    return setCharacterChatTools({ request, actor, characterId: id, body });
  });
}
