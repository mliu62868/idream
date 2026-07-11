import { deleteSavedViewV2, updateSavedViewV2 } from "@/server/modules/admin-v2/collaboration/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(() => updateSavedViewV2(request, id));
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(() => deleteSavedViewV2(request, id));
}
