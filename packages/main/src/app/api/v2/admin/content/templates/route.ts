import {
  createTemplate,
  listTemplates,
} from "@/server/modules/admin-v2/content/templates";
import {
  actorWithPermission,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.read");
    return listTemplates(queryParams(request, "GET /api/v2/admin/content/templates"));
  });
}

export function POST(request: Request) {
  return adminV2Route(request, () => createTemplate(request));
}
