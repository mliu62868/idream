import { listCustomers } from "@/server/modules/admin-v2/cases/customer-query";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return adminV2Route(() => listCustomers(request));
}
