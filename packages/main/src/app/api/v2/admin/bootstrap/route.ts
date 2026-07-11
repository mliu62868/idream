import { adminBootstrapSchema } from "@idream/shared/admin";
import { deriveAdminShellSignals } from "@/server/admin/shell-signals";
import { DEV_ADMIN_ACCOUNT_HINTS } from "@/server/admin/dev-login-accounts";
import { devLoginEnabled } from "@/server/admin/dev-login";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { getAuthCtx } from "@/server/lib/auth";
import { ok } from "@/server/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const actor = await getAuthCtx(request);
  const permissions = await effectivePermissions(actor.userId, actor.role);
  const bootstrap = adminBootstrapSchema.parse({
    actor: actor.userId ? { id: actor.userId, role: actor.role ?? "user" } : null,
    permissions: [...permissions].sort(),
    canReadDashboard: permissions.has("dashboard.read"),
    devLogin: {
      enabled: devLoginEnabled(),
      accounts: devLoginEnabled() ? DEV_ADMIN_ACCOUNT_HINTS : [],
    },
    shellSignals: deriveAdminShellSignals(process.env),
  });
  return ok({ bootstrap });
}
