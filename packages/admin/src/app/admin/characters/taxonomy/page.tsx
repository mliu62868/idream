import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata() {
  return adminRouteMetadata("Taxonomy");
}

export default function CharacterTaxonomyPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters", "taxonomy"], searchParams);
}
