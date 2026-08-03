import { effectivePermissions } from "@/server/admin/effective-permissions";
import { updateOperationalWorkPreference } from "@/server/modules/admin-v2/today/preferences";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { Errors } from "@/server/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requiredIfMatch(request: Request) {
  const value = request.headers.get("if-match")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!value || !/^\d+$/.test(value)) throw Errors.badRequest("If-Match version is required");
  return Number(value);
}

export function PUT(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "dashboard.read");
    const permissions = await effectivePermissions(actor.id, actor.role);
    const body = await jsonBody(request, "operationalWorkPreferenceUpdateSchema+if-match");
    const expectedVersion = requiredIfMatch(request);
    return updateOperationalWorkPreference({
      actor,
      permissions,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      watching: body.watching,
      pinned: body.pinned,
      snoozedUntil: body.snoozedUntil === undefined
        ? undefined
        : body.snoozedUntil
          ? new Date(body.snoozedUntil)
          : null,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      expectedVersion,
    });
  });
}
