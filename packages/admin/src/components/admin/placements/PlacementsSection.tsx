"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { PlacementsListPage } from "./PlacementsListPage";
import { PlacementsDetailPage } from "./PlacementsDetailPage";
import { PlacementsNewPage } from "./PlacementsNewPage";

// SPEC: content/placements 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function PlacementsSection({ canPublish, canReadRuns, canUpload = false, view }: { canPublish: boolean; canReadRuns?: boolean; canUpload?: boolean; view: AdminSubview }) {
  if (view.kind === "new") return canPublish ? <PlacementsNewPage canUpload={canUpload} canReadRuns={canReadRuns} /> : <PlacementsListPage canPublish={false} />;
  if (view.kind === "detail") return <PlacementsDetailPage canPublish={canPublish} id={view.id} key={view.id} />;
  return <PlacementsListPage canPublish={canPublish} />;
}
