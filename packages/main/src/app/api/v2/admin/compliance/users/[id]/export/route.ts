import { exportUserData } from "@/server/modules/admin-v2/compliance/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () => exportUserData(request, id));
}
