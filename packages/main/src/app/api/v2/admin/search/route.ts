import { globalAdminSearch } from "@/server/modules/admin-v2/search/global-search";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return adminV2Route(() => globalAdminSearch(request));
}
