import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("Characters");

export default function CharactersPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters"], searchParams);
}
