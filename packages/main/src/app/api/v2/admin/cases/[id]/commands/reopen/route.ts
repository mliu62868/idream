import { caseReopenRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { reopenOrRecurCase } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = caseReopenRequestSchema.parse(await request.json());
    if (body.confirmation !== `${id}:reopen`) throw Errors.badRequest("Confirmation did not match Case reopen target");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "case.reopen",
      target: { type: "admin_case", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => {
        const result = await reopenOrRecurCase({ caseId: id, actor, expectedVersion: body.entityVersion, reason: body.reason, requestId }, tx);
        return {
          mode: result.mode,
          caseId: result.adminCase.id,
          status: result.adminCase.status,
          verificationState: result.adminCase.verificationState,
          version: result.adminCase.version,
        };
      },
    });
  });
}
