import { deleteSavedViewV2, updateSavedViewV2 } from "@/server/modules/admin-v2/collaboration/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "dashboard.read");
    return updateSavedViewV2(request, id);
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "dashboard.read");
    return deleteSavedViewV2(request, id);
  });
}
