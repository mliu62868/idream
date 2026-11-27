import {
  actorCharacterScope,
  actorWithPermission,
  jsonBody,
  requireActorPermission,
} from "@/server/modules/admin-v2/shared/authority";
import { Errors } from "@/server/lib/errors";
import { createCreativeRun } from "@/server/modules/admin-v2/creative/run-create";
import { listCreativeRuns } from "@/server/modules/admin-v2/creative/run-read";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { ok } from "@/server/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    // INVARIANT: listCreativeRuns narrows its rows to this scope.
    const actor = await actorWithPermission(request, "creative.run.read", { characterScope: "handler_enforced" });
    const characterScope = await actorCharacterScope(actor, "creative.run.read");
    return listCreativeRuns({ requestUrl: request.url, actor, characterScope });
  });
}

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    // The Run's Character is named only in the body; its scope is asserted right after parsing.
    const actor = await actorWithPermission(request, "creative.run.write", { characterScope: "handler_enforced" });
    if (!request.headers.get("idempotency-key")?.trim()) {
      throw Errors.badRequest("Idempotency-Key is required for Creative Run creation");
    }
    const body = await jsonBody(request, "creativeRunCreateRequestSchema+idempotency-key");
    // SPEC: a scoped grant creates only `targetType=character` Runs for an assigned Character;
    //       every other target names no Character and is refused for it.
    await requireActorPermission(
      request,
      actor,
      "creative.run.write",
      body.targetType === "character" && body.targetId ? { characterId: body.targetId } : undefined,
    );
    const result = await createCreativeRun(request, actor, body);
    return ok(result, { status: result.replayed || "skip" in result ? 200 : 202 });
  });
}
