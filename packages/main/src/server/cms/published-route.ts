// SPEC: CMS 公开读路径的 DB override 源（ADMIN_PHASE3_DESIGN §3.2）。
// INTENT: 公开 [...slug] 优先读 published RoutePage；任何 DB 错误或无已发布行 → null，
//         由调用方 fallback 到静态 getOurdreamRoute。故 DB 不可达时构建/渲染仍正常（韧性）。
//         用 unstable_cache 包裹（per-path，60s ISR + tag），让 SEO 页保持静态/ISR 而非每次
//         请求都打 DB 退化为动态 SSR；编辑经 ISR 在 ≤60s 生效（无需发版）。
import { unstable_cache } from "next/cache";
import { prisma } from "@/server/lib/db";

export type PublishedRoutePage = {
  path: string;
  title: string;
  description: string;
  canonical: string | null;
  body: unknown;
};

async function readPublishedRoutePage(path: string): Promise<PublishedRoutePage | null> {
  try {
    const page = await prisma.routePage.findUnique({ where: { path } });
    if (!page || page.contentStatus !== "published") return null;
    return {
      path: page.path,
      title: page.title,
      description: page.description,
      canonical: page.canonical,
      body: page.body,
    };
  } catch {
    // DB 不可达/未迁移 → 退回静态页，绝不让 CMS 拖垮公开渲染。
    return null;
  }
}

export async function loadPublishedRoutePage(path: string): Promise<PublishedRoutePage | null> {
  const cached = unstable_cache(() => readPublishedRoutePage(path), ["cms-route-page", path], {
    revalidate: 60,
    tags: ["cms-pages", `cms-page:${path}`],
  });
  return cached();
}
