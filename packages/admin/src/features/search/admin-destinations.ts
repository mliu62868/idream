import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import type { LucideIcon } from "lucide-react";
import { translateAdmin } from "@/components/admin/i18n";
import { ALL_SECTION_ITEMS, canReadWorkspace } from "@/components/admin/nav-config";

// SPEC: 把 34 个能力页（外加 3 个不在侧栏、只能靠记 URL 到达的兼容目的地）变成可搜索的
//       跳转目标，供全局搜索框当命令面板用。
// INTENT: 这是一个 34 页的控制台，侧栏按分组折叠，运营想去「死信队列」或「配置与灰度」
//         只能靠记路径或一层层展开分组——而全站唯一的搜索框只搜实体，搜不到页面。
export type AdminDestination = {
  id: string;
  href: string;
  /** i18n key；渲染时才按当前语言翻译。 */
  label: string;
  /** i18n key。 */
  group: string;
  icon: LucideIcon;
};

export const ADMIN_DESTINATION_LIMIT = 6;

// SPEC: 一个目的地的可搜索文本——英文标签、中文标签、英文分组、中文分组、URL。
// INTENT: 中英文用同一份索引：运营在中文界面下会打「死信」，在英文界面下会打 "dead letter"，
//         两边都必须命中。URL 也进索引，因为 ?view=dead-letter 这类子视图的英文名就藏在
//         query string 里，标签上反而看不到。
// INVARIANT: 前两项必须是标签——rank() 靠这个位置约定区分"命中页名"和"命中分组名/URL"。
function searchableFields(item: { label: string; group: string; href: string }) {
  return [
    item.label,
    translateAdmin("zh", item.label),
    item.group,
    translateAdmin("zh", item.group),
    item.href,
  ].map((value) => value.toLowerCase());
}

function rank(fields: readonly string[], needle: string) {
  const names = fields.slice(0, 2);
  if (names.some((name) => name.startsWith(needle))) return 0;
  if (names.some((name) => name.includes(needle))) return 1;
  return fields.some((field) => field.includes(needle)) ? 2 : -1;
}

// SPEC: 只返回运营真的读得进去的目的地。
// INTENT: 把无权限的页面列进来，Enter 之后只会撞上「无此工作区权限」——那是把搜索框
//         变成第二条死路。权限判定复用导航自己的谓词，不另立一套。
export function matchAdminDestinations(
  query: string,
  permissions: ReadonlySet<AdminPermissionKey>,
  limit: number = ADMIN_DESTINATION_LIMIT,
): AdminDestination[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  return ALL_SECTION_ITEMS
    .filter((item) => canReadWorkspace(item, permissions))
    .map((item) => ({ item, score: rank(searchableFields(item), needle) }))
    .filter((scored) => scored.score >= 0)
    // sort 是稳定的：同一档内保持 nav-config 的声明顺序。
    .sort((left, right) => left.score - right.score)
    .slice(0, limit)
    .map(({ item }) => ({
      id: item.id,
      href: item.href,
      label: item.label,
      group: item.group,
      icon: item.icon,
    }));
}
