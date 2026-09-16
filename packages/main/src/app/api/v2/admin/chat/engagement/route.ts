import { chatOpsEngagement } from "@/server/modules/admin-v2/chat/engagement";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => chatOpsEngagement(request));
}
