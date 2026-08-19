import { listUserPermissions, setUserPermission } from "@/server/modules/admin-v2/access/users";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () => listUserPermissions(request, id));
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () => setUserPermission(request, id));
}
