"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { PlacementsListPage } from "./PlacementsListPage";
import { PlacementsDetailPage } from "./PlacementsDetailPage";
import { PlacementsNewPage } from "./PlacementsNewPage";

// SPEC: content/placements 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function PlacementsSection({ view }: { view: AdminSubview }) {
  if (view.kind === "new") return <PlacementsNewPage />;
  if (view.kind === "detail") return <PlacementsDetailPage id={view.id} />;
  return <PlacementsListPage />;
}
