import { characterVoiceCallHistorySchema } from "@idream/shared/admin";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { readCharacterVoiceCalls } from "@/server/modules/chat/voice-call";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "character.project.read", { characterId: id });
    return characterVoiceCallHistorySchema.parse(await readCharacterVoiceCalls(id));
  });
}
