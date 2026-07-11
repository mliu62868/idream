import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin/service";
import { cancelGenerationRequest } from "@/server/ai/generation-request-lifecycle";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), reason: z.string().trim().min(3), confirmation: z.string().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "generation.job.requeue");
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:cancel`) throw Errors.badRequest("Confirmation did not match Generation Request cancellation target");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required");
    return cancelGenerationRequest({ requestId: id, expectedVersion: body.entityVersion, actor, reason: body.reason, idempotencyKey, traceId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  });
}
