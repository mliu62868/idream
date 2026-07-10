"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { AssetsListPage } from "./AssetsListPage";
import { AssetsDetailPage } from "./AssetsDetailPage";

// SPEC: content/assets 的子视图路由 —— list / detail 两件套（spec §6.1 变体）。
// INTENT: 图片库没有 /new 页——"新建"是既有的生产/上传流程（Production Studio 等），不在这个
// 两件套范围内；view.kind === "new" 时回落列表页，而不是渲染一个不存在的表单。
export function AssetsSection({ view }: { view: AdminSubview }) {
  if (view.kind === "detail") return <AssetsDetailPage id={view.id} />;
  return <AssetsListPage />;
}
