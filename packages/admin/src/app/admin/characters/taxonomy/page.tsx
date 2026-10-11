import { adminRouteLabel, adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function generateMetadata({ searchParams }: { searchParams: AdminSearchParams }) {
  return adminRouteMetadata(adminRouteLabel(["characters", "taxonomy"], await searchParams));
}

export default function CharacterTaxonomyPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters", "taxonomy"], searchParams);
}
