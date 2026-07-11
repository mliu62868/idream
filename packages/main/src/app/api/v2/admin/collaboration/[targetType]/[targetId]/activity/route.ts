import { createActivity, listActivity } from "@/server/modules/admin-v2/collaboration/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ targetType: string; targetId: string }> };
export async function GET(request: Request, { params }: Context) {
  const { targetType, targetId } = await params;
  return adminV2Route(() => listActivity(request, targetType, targetId));
}
export async function POST(request: Request, { params }: Context) {
  const { targetType, targetId } = await params;
  return adminV2Route(() => createActivity(request, targetType, targetId));
}
