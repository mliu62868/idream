import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata() {
  return adminRouteMetadata("Characters");
}

export default function CharactersPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters"], searchParams);
}
