import { characterReleaseReviewRequestSchema } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { reviewCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; releaseId: string }> }) {
  const { id, releaseId } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.release.review", { characterId: id });
    const body = characterReleaseReviewRequestSchema.parse(await request.json());
    const ifMatch = request.headers.get("if-match")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    if (!ifMatch || !/^\d+$/.test(ifMatch) || Number(ifMatch) !== body.entityVersion) {
      throw Errors.badRequest("If-Match must equal body entityVersion");
    }
    if (body.confirmation !== `${id}:${releaseId}:${body.decision}`) throw Errors.badRequest("Confirmation did not match Release review target");
    return reviewCharacterRelease({ request, characterId: id, releaseId, expectedVersion: body.entityVersion, decision: body.decision, reason: body.reason });
  });
}
