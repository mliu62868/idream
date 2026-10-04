import {
  getTemplate,
  updateTemplate,
} from "@/server/modules/admin-v2/content/templates";
import {
  actorWithPermission,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.read");
    return getTemplate(id);
  });
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () => updateTemplate(request, id));
}
