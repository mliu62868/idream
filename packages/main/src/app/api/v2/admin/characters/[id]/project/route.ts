import { characterProjectDraftResumeSchema } from "@idream/shared/admin";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { getCharacterProjectDraftForResume, updateCharacterProjectDraft } from "@/server/modules/admin-v2/characters/project-draft";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "character.project.write", { characterId: id });
    return characterProjectDraftResumeSchema.parse(await getCharacterProjectDraftForResume(id));
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "characterProjectDraftPatchRequestSchema+if-match");
    requireMatchingProjectVersion(request, body.entityVersion);
    return updateCharacterProjectDraft({
      characterId: id,
      expectedVersion: body.entityVersion,
      actor,
      ownerId: body.ownerId,
      audience: body.audience,
      companionNeed: body.companionNeed,
      hypothesis: body.hypothesis,
      differentiation: body.differentiation,
      targetPlacementKeys: body.targetPlacementKeys,
      successCriteria: body.successCriteria,
      productionPackage: body.productionPackage,
      qaPlan: body.qaPlan,
      plannedLaunchAt: body.plannedLaunchAt,
      content: body.content,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
