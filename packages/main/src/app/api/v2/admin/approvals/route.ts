import { createApproval, listApprovals } from "@/server/modules/admin-v2/approvals/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listApprovals(request));
}

export function POST(request: Request) {
  return adminV2Route(request, () => createApproval(request));
}
