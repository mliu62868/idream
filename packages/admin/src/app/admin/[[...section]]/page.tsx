import type { Metadata } from "next";
import { headers } from "next/headers";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import { hasPermission } from "@/server/admin/permissions";
import { getAuthCtx } from "@/server/lib/auth";

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

  return (
    <AdminConsoleClient
      actor={ctx.userId ? { id: ctx.userId, role: ctx.role ?? "user" } : null}
      initialAccess={canReadDashboard}
      initialSection={section.join("/") || "dashboard"}
    />
  );
}
