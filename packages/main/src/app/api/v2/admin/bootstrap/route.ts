import { adminBootstrapResponseSchema, adminBootstrapSchema } from "@idream/shared/admin";
import { deriveAdminShellSignals } from "@/server/admin/shell-signals";
import { DEV_ADMIN_ACCOUNT_HINTS } from "@/server/admin/dev-login-accounts";
import { devLoginEnabled } from "@/server/admin/dev-login";
import { canCreateCharacterProjects, effectiveCharacterScopes, effectivePermissions } from "@/server/admin/effective-permissions";
import { getAuthCtx } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { verifyAdminBffRequest } from "@/server/modules/admin-v2/shared/admin-bff";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return adminV2Route(request, async () => {
    const bff = await verifyAdminBffRequest(request);
    if (!bff.ok) {
      throw Errors.unauthorized("Admin BFF authentication failed", { reason: bff.reason });
    }
    const actor = await getAuthCtx(request);
    const permissions = await effectivePermissions(actor.userId, actor.role);
    const canCreateCharacters = await canCreateCharacterProjects(actor.userId, actor.role);
    // Same rule as actorForCharacterCreationAid: a Character-scoped content.official.write
    // cannot back a request that names no Character.
    const officialWriteGlobal = permissions.has("content.official.write") && (
      !actor.userId ||
      (await effectiveCharacterScopes(actor.userId, actor.role, ["content.official.write"])).get("content.official.write") === null
    );
    const bootstrap = adminBootstrapSchema.parse({
      actor: actor.userId ? { id: actor.userId, role: actor.role ?? "user" } : null,
      permissions: [...permissions].sort(),
      canReadDashboard: permissions.has("dashboard.read"),
      canCreateCharacters,
      canAssistCharacterDrafts: canCreateCharacters || officialWriteGlobal,
      devLogin: {
        enabled: devLoginEnabled(),
        accounts: devLoginEnabled() ? DEV_ADMIN_ACCOUNT_HINTS : [],
      },
      shellSignals: deriveAdminShellSignals(process.env),
    });
    return ok(adminBootstrapResponseSchema.parse({ bootstrap }));
  });
}
