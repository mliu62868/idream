import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata() {
  return adminRouteMetadata("Incidents");
}

export default function IncidentsPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["ops", "incidents"], searchParams);
}
