import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("Cases");

export default function CasesPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["cases"], searchParams);
}
