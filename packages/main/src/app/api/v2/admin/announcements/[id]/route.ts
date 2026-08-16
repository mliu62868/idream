import {
  deleteAnnouncement,
  patchAnnouncement,
} from "@/server/modules/admin-v2/announcements/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () => patchAnnouncement(request, id));
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () => deleteAnnouncement(request, id));
}
