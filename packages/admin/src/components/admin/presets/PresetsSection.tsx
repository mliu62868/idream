"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { PresetsListPage } from "./PresetsListPage";
import { PresetsDetailPage } from "./PresetsDetailPage";
import { PresetsNewPage } from "./PresetsNewPage";

// SPEC: generation/presets 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function PresetsSection({ canWrite, view }: { canWrite: boolean; view: AdminSubview }) {
  if (view.kind === "new") return <PresetsNewPage canWrite={canWrite} />;
  if (view.kind === "detail") return <PresetsDetailPage canWrite={canWrite} id={view.id} key={view.id} />;
  return <PresetsListPage canWrite={canWrite} />;
}
