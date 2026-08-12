import {
  characterProjectDraftResumeSchema,
  customerCharacterPublicationPrepResponseSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { getCharacterProjectDraftForResume, updateCharacterProjectDraft } from "@/server/modules/admin-v2/characters/project-draft";
import { prepareApprovedCustomerCharacterPublication } from "@/server/modules/admin-v2/characters/publication-prep";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
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

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "customerCharacterPublicationPrepRequestSchema+idempotency-key");
    if (body.confirmation !== `PREPARE PUBLICATION ${id}`) {
      throw Errors.badRequest("Confirmation did not match publication preparation");
    }
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey: requireIdempotencyKey(request),
      requestId,
      commandType: "character.publication.prepare",
      target: { type: "character", id },
      payload: body,
      mutate: (tx) => prepareApprovedCustomerCharacterPublication(tx, {
        characterId: id,
        actor,
        requestId,
        reason: body.reason,
        submissionId: body.submissionId,
      }),
      decorateResult: (value, replayed) => ({
        ...(value as Record<string, unknown>),
        replayed,
      }),
    });
    return customerCharacterPublicationPrepResponseSchema.parse(result);
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
