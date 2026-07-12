import { characterProjectDraftPatchRequestSchema, characterProjectDraftResumeSchema } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin/service";
import { getCharacterProjectDraftForResume, updateCharacterProjectDraft } from "@/server/modules/admin-v2/characters/workspace";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.project.write", { characterId: id });
    return characterProjectDraftResumeSchema.parse(await getCharacterProjectDraftForResume(id));
  });
}

function ifMatchVersion(request: Request): number | null {
  const value = request.headers.get("if-match")?.replace(/^W\//, "").replaceAll('"', "");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = characterProjectDraftPatchRequestSchema.parse(await request.json());
    const headerVersion = ifMatchVersion(request);
    if (headerVersion !== null && headerVersion !== body.entityVersion) {
      throw Errors.badRequest("If-Match and entityVersion must identify the same Project revision");
    }
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
