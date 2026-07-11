import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminDevLogin } from "@/components/admin/AdminDevLogin";
import { adminEntryRedirect } from "@/components/admin/nav-config";
import { deriveAdminShellSignals } from "@/components/admin/shell-signals";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { getAuthCtx } from "@/server/lib/auth";
import { devLoginEnabled } from "@/server/admin/dev-login";
import { DEV_ADMIN_ACCOUNT_HINTS } from "@/server/admin/dev-login-accounts";
import { AdminConsoleClientOnly } from "../AdminConsoleClientOnly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Admin | iDream",
  robots: {
    index: false,
    follow: false,
  },
};

type AdminPageProps = {
  params: Promise<{
    section?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPage({ params, searchParams }: AdminPageProps) {
  const { section = [] } = await params;
  const query = await searchParams;
  const entryRedirect = adminEntryRedirect(section, query);
  if (entryRedirect) redirect(entryRedirect);

  const headerList = await headers();
  const ctx = await getAuthCtx(
    new Request("http://localhost/admin", {
      headers: headerList,
    }),
  );
  const permissions = await effectivePermissions(ctx.userId, ctx.role);
  const canReadDashboard = permissions.has("dashboard.read");

  // 本地开发：无后台权限时给出内置账号的快捷登录，而非裸的 access denied。
  if (!canReadDashboard && devLoginEnabled()) {
    return (
      <AdminDevLogin
        accounts={DEV_ADMIN_ACCOUNT_HINTS}
        actor={ctx.userId ? { id: ctx.userId, role: ctx.role ?? "user" } : null}
      />
    );
  }

  return (
    <AdminConsoleClientOnly
      actor={ctx.userId ? { id: ctx.userId, role: ctx.role ?? "user" } : null}
      initialAccess={canReadDashboard}
      initialPermissions={[...permissions]}
      initialSection={withSearchParams(section.join("/"), query)}
      shellSignals={deriveAdminShellSignals(process.env)}
      devLogout={devLoginEnabled()}
    />
  );
}

function withSearchParams(
  path: string,
  values: Readonly<Record<string, string | string[] | undefined>>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  const encoded = query.toString();
  return `${path}${encoded ? `?${encoded}` : ""}`;
}
