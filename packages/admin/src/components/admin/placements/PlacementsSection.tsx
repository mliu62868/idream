"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { PlacementsListPage } from "./PlacementsListPage";
import { PlacementsDetailPage } from "./PlacementsDetailPage";
import { PlacementsNewPage } from "./PlacementsNewPage";

// SPEC: content/placements 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function PlacementsSection({ canPublish, view }: { canPublish: boolean; view: AdminSubview }) {
  if (view.kind === "new") return canPublish ? <PlacementsNewPage /> : <PlacementsListPage canPublish={false} />;
  if (view.kind === "detail") return <PlacementsDetailPage canPublish={canPublish} id={view.id} />;
  return <PlacementsListPage canPublish={canPublish} />;
}
