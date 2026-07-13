import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("Creative Runs");

export default function CreativeRunsPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["creative", "runs"], searchParams);
}
