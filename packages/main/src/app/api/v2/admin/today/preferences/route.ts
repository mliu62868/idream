import { operationalWorkPreferenceUpdateSchema } from "@idream/shared/admin";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { updateOperationalWorkPreference } from "@/server/modules/admin-v2/today/preferences";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function PUT(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "dashboard.read");
    const permissions = await effectivePermissions(actor.id, actor.role);
    const body = operationalWorkPreferenceUpdateSchema.parse(await request.json());
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
    });
  });
}
