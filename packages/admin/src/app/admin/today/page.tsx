import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata() {
  return adminRouteMetadata("Today");
}

export default function TodayPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["today"], searchParams);
}
