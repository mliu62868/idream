import { characterReleaseProposalRequestSchema } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { proposeCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.release.propose", { characterId: id });
    const body = characterReleaseProposalRequestSchema.parse(await request.json());
    if (body.confirmation !== `${id}:propose-release`) throw Errors.badRequest("Confirmation did not match Release proposal target");
    return proposeCharacterRelease({ request, characterId: id, expectedProjectVersion: body.entityVersion, qaRunId: body.qaRunId, reason: body.reason });
  });
}
