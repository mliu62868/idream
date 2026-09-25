import {
  characterProjectDraftResumeSchema,
  customerCharacterPublicationPrepResponseSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import {
  getCharacterProjectDraftForResume,
  updateCharacterProjectDraft,
} from "@/server/modules/admin-v2/characters/project-draft";
import { prepareApprovedCustomerCharacterPublication } from "@/server/modules/admin-v2/characters/publication-prep";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "character.project.write", {
      characterId: id,
    });
    // 早于向导的旧角色没有满足当前契约的草稿：这是「不可续建」而不是服务端故障，
    // 明确告诉运营去角色详情页编辑，而不是返回一个看不懂的校验错误。
    const resume = characterProjectDraftResumeSchema.safeParse(
      await getCharacterProjectDraftForResume(id),
    );
    if (!resume.success) {
      throw Errors.conflict(
        "This Character was not created with the creation wizard, so there is no draft to resume. Edit it from its Character page.",
        { reason: "draft_not_resumable" },
      );
    }
    return resume.data;
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(
      request,
      "character.project.write",
      { characterId: id },
    );
    const body = await jsonBody(
      request,
      "customerCharacterPublicationPrepRequestSchema+idempotency-key",
    );
    if (body.confirmation !== `PREPARE PUBLICATION ${id}`) {
      throw Errors.badRequest(
        "Confirmation did not match publication preparation",
      );
    }
    const requestId =
      request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey: requireIdempotencyKey(request),
      requestId,
      commandType: "character.publication.prepare",
      target: { type: "character", id },
      payload: body,
      mutate: (tx) =>
        prepareApprovedCustomerCharacterPublication(tx, {
          characterId: id,
          actor,
          requestId,
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(
      request,
      "character.project.write",
      { characterId: id },
    );
    const body = await jsonBody(
      request,
      "characterProjectDraftPatchRequestSchema+if-match",
    );
    requireMatchingProjectVersion(request, body.entityVersion);
    return updateCharacterProjectDraft({
      characterId: id,
      expectedVersion: body.entityVersion,
      actor,
      content: body.content,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
