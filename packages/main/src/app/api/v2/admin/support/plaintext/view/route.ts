import { viewPlaintext } from "@/server/modules/admin-v2/support/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, () => viewPlaintext(request));
}
