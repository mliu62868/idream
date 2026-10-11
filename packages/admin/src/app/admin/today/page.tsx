import { adminRouteLabel, adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function generateMetadata({ searchParams }: { searchParams: AdminSearchParams }) {
  return adminRouteMetadata(adminRouteLabel(["today"], await searchParams));
}

export default function TodayPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["today"], searchParams);
}
