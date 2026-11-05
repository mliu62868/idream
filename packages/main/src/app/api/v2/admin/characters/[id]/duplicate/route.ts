import { canCreateCharacterProjects } from "@/server/admin/effective-permissions";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  discardCharacterDuplicateCopies,
  prepareCharacterDuplicate,
  writeCharacterDuplicate,
  type PreparedCharacterDuplicate,
} from "@/server/modules/admin-v2/characters/duplicate";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminMutationResultValidator, adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    if (!await canCreateCharacterProjects(actor.id, actor.role)) {
      throw Errors.forbidden("Copying Characters requires global Character Project write permission", {
        permission: "character.project.write",
        reason: "global_scope_required",
      });
    }
    const body = await jsonBody(request, "characterProjectDuplicateRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    let prepared: PreparedCharacterDuplicate | null = null;
    let committed = false;
    try {
      const result = await executeAtomicIdempotentMutation<PreparedCharacterDuplicate>({
        validateResult: adminMutationResultValidator(request),
        environment: env.APP_ENV,
        actor,
        idempotencyKey,
        requestId,
        commandType: "character.project.duplicate",
        target: { type: "character", id },
        payload: body,
        transactionTimeoutMs: 30_000,
        prepare: async () => {
          prepared = await prepareCharacterDuplicate(id);
          return prepared;
        },
        mutate: (tx, copy) => {
          return writeCharacterDuplicate(tx, { actor, requestId, prepared: copy }).then((value) => {
            committed = true;
            return value;
          });
        },
        decorateResult: (value, replayed) => ({ ...(value as Record<string, unknown>), replayed }),
      });
      return Response.json({ ok: true, data: result }, { status: (result as { replayed?: boolean }).replayed ? 200 : 201 });
    } catch (cause) {
      committed = false;
      throw cause;
    } finally {
      const copy = prepared as PreparedCharacterDuplicate | null;
      if (copy && !committed) await discardCharacterDuplicateCopies(copy.copied);
    }
  });
}
