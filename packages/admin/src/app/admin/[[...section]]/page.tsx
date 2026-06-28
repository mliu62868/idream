import type { Metadata } from "next";
import { headers } from "next/headers";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import { AdminDevLogin } from "@/components/admin/AdminDevLogin";
import { hasPermission } from "@/server/admin/permissions";
import { getAuthCtx } from "@/server/lib/auth";
import { devLoginEnabled } from "@/server/admin/dev-login";
import { DEV_ADMIN_ACCOUNT_HINTS } from "@/server/admin/dev-login-accounts";

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
};

export default async function AdminPage({ params }: AdminPageProps) {
  const { section = [] } = await params;
  const headerList = await headers();
  const ctx = await getAuthCtx(
    new Request("http://localhost/admin", {
      headers: headerList,
    }),
  );
  const canReadDashboard = hasPermission(ctx.role, "dashboard.read");

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
    <AdminConsoleClient
      actor={ctx.userId ? { id: ctx.userId, role: ctx.role ?? "user" } : null}
      initialAccess={canReadDashboard}
      initialSection={section.join("/") || "dashboard"}
      devLogout={devLoginEnabled()}
    />
  );
}
