import { adminRouteLabel, adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function generateMetadata({ searchParams }: { searchParams: AdminSearchParams }) {
  return adminRouteMetadata(adminRouteLabel(["ops", "jobs"], await searchParams));
}

export default function JobsPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["ops", "jobs"], searchParams);
}
