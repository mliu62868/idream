import { voiceDefaultSettingsSchema } from "@idream/shared/admin";
import {
  getVoiceDefaultSettings,
  updateVoiceDefaultSettings,
} from "@/server/modules/voice-defaults";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return adminV2Route(async () => {
    await actorWithPermission(request, "generation.config.read");
    return voiceDefaultSettingsSchema.parse(await getVoiceDefaultSettings());
  });
}

export async function PUT(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "generation.config.write");
    return updateVoiceDefaultSettings({
      actor,
      idempotencyKey: requireIdempotencyKey(request),
      requestId:
        request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
      request: await jsonBody(request),
    });
  });
}
