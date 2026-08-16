import { mergeTags } from "@/server/modules/admin-v2/content/tags";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.tag.write");
    const body = await jsonBody(request, "contentTagMergeRequestSchema");
    return mergeTags({ request, actor, body });
  });
}
