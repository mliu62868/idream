import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { reviewCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), decision: z.enum(["approved", "changes_requested"]), reason: z.string().trim().min(3).max(2_000), confirmation: z.string().trim().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; releaseId: string }> }) {
  const { id, releaseId } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.release.review", { characterId: id });
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:${releaseId}:${body.decision}`) throw Errors.badRequest("Confirmation did not match Release review target");
    return reviewCharacterRelease({ request, characterId: id, releaseId, expectedVersion: body.entityVersion, decision: body.decision, reason: body.reason });
  });
}
