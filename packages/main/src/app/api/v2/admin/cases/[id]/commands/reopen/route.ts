import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin/service";
import { reopenOrRecurCase } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), reason: z.string().trim().min(3).max(2_000), confirmation: z.string().trim().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:reopen`) throw Errors.badRequest("Confirmation did not match Case reopen target");
    return reopenOrRecurCase({ caseId: id, actor, expectedVersion: body.entityVersion, reason: body.reason, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  });
}
