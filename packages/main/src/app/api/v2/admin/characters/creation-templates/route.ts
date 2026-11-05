import { canCreateCharacterProjects } from "@/server/admin/effective-permissions";
import { Errors } from "@/server/lib/errors";
import { listTemplates } from "@/server/modules/admin-v2/content/templates";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SPEC: 创建向导的模板选择器：只读已上架模板。与模板管理分开，创建者不因此获得模板库导航。
export function GET(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.project.write");
    if (!await canCreateCharacterProjects(actor.id, actor.role)) {
      throw Errors.forbidden("Creating Characters requires global Character Project write permission", {
        permission: "character.project.write",
        reason: "global_scope_required",
      });
    }
    return listTemplates({ status: "active", limit: 100 });
  });
}
