import { generateCharacterDraft } from "@/server/modules/admin-v2/content/assist";
import {
  actorForCharacterCreationAid,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    await actorForCharacterCreationAid(request, "content.official.write");
    const body = await jsonBody(request, "contentCharacterAssistRequestSchema");
    return generateCharacterDraft(body, undefined, request.headers.get("x-request-id") ?? undefined);
  });
}
