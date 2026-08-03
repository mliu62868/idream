import { retryFailedCreativeRun } from "@/server/modules/admin-v2/commands/authoritative";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RetryFailedRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RetryFailedRouteContext) {
  const { id } = await context.params;
  // commandResponse 继续负责命令语义的错误映射（幂等冲突 409、不变量失败等）；
  // adminV2Route 只在 2xx 上按 manifest 收窄信封，非 2xx 原样透传
  // （route-handler.ts:50），所以两层不会互相踩。
  // 这条此前挂在 ROUTE_SEAM_DEBT 上，理由是「并行的 Creative 重构持有它，一起改会
  // 冲突」—— 那次重构已经合并，理由消失，债一并清掉。
  return adminV2Route(request, () => retryFailedCreativeRun(request, id));
}
