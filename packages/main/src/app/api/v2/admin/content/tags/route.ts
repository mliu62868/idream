import { createTag, listAdminTags } from "@/server/modules/admin-v2/content/tags";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.read");
    return listAdminTags(queryParams(request, "GET /api/v2/admin/content/tags"));
  });
}

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.tag.write");
    const body = await jsonBody(request, "contentTagCreateRequestSchema");
    return createTag({ request, actor, body });
  });
}
