import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("Character Detail");

export default async function CharacterDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: AdminSearchParams;
}) {
  const { id } = await params;
  return renderAdminRoute(["characters", id], searchParams);
}
