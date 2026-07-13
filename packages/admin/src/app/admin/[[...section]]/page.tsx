import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { adminEntryRedirect } from "@/components/admin/nav-config";
import {
  adminRouteLabel,
  adminRouteMetadata,
  renderAdminRoute,
  type AdminSearchParams,
} from "../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminPageProps = {
  params: Promise<{
    section?: string[];
  }>;
  searchParams: AdminSearchParams;
};

export async function generateMetadata({ params }: Pick<AdminPageProps, "params">): Promise<Metadata> {
  const { section = [] } = await params;
  return adminRouteMetadata(adminRouteLabel(section));
}

export default async function AdminPage({ params, searchParams }: AdminPageProps) {
  const { section = [] } = await params;
  const query = await searchParams;
  const entryRedirect = adminEntryRedirect(section, query);
  if (entryRedirect) redirect(entryRedirect);
  return renderAdminRoute(section, Promise.resolve(query));
}
