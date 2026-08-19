import { setTemplateActive } from "@/server/modules/admin-v2/content/templates";
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
    const actor = await actorWithPermission(request, "content.template.write");
    const body = await jsonBody(request, "contentTemplateActiveRequestSchema");
    return setTemplateActive({ request, actor, id, body });
  });
}
