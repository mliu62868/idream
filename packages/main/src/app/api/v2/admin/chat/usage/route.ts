import { chatOpsUsage } from "@/server/modules/admin-v2/chat/ops-proxy";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => chatOpsUsage(request));
}
