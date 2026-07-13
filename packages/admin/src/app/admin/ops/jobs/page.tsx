import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("Generation Jobs");

export default function JobsPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["ops", "jobs"], searchParams);
}
