import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { reconcileAdminMutationReceipt } from "@/server/modules/admin-v2/shared/mutation-recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(() => reconcileAdminMutationReceipt(request));
}
