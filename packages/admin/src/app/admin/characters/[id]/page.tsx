import { adminDynamicRouteLabel, adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 这个目录同时接住真实详情与 characters/releases、characters/calendar 两条列表别名。
  return adminRouteMetadata(adminDynamicRouteLabel(["characters", id], "Character Detail"));
}

export default async function CharacterDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: AdminSearchParams;
}) {
  const { id } = await params;
  return renderAdminRoute(["characters", id], searchParams);
}
