import { previewVoiceDefault } from "@/server/modules/voice-defaults";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "generation.config.read");
    return previewVoiceDefault(
      await jsonBody(request, "voiceDefaultPreviewRequestSchema"),
    );
  });
}
