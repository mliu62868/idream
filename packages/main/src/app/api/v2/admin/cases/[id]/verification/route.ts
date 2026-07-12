import { caseVerificationRequestSchema } from "@idream/shared/admin";
import { verifyReviewCase } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = caseVerificationRequestSchema.parse(await request.json());
    return verifyReviewCase({
      caseId: id,
      actor,
      expectedVersion: body.entityVersion,
      state: body.state,
      evidenceRefs: body.evidenceRefs,
      overrideReason: body.overrideReason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
