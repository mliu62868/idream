import { adminRouteLabel, adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function generateMetadata({ searchParams }: { searchParams: AdminSearchParams }) {
  return adminRouteMetadata(adminRouteLabel(["ops", "incidents"], await searchParams));
}

export default function IncidentsPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["ops", "incidents"], searchParams);
}
