// SPEC: 角色运营台的每条 deepLink 都从这里出——tab 与页内锚点都是有限集合，不是自由字符串。
// INTENT: 「阻塞在哪 → 去哪个控件解决」是运营流程知识，属于服务端投影（ADR-13 §2.6）。这份知识
// 此前散在 characters/ 的八个文件里各拼各的，于是拼出了 admin 根本没有的 tab：readiness.ts 发
// `?tab=visual-identity`、`?tab=persona`、`?tab=overview`，workspace.ts 再用一次
// String.replace 把其中一个改回 `?tab=visual`，另外两个直接落到缺省 tab。更糟的是路线类阻塞：
// readiness.ts 把它指向 `/admin/ops/profiles`（另一个页面），workspace.ts 又给这个 URL 拼上一个
// 只存在于角色运营台的 `#route-qualification-workbench`——运营点「路线未合格」会落到
// 「Profiles & Rollout」页，后面挂一个永远匹配不上的片段。
// INVARIANT: tab 集合必须与 admin 的 characterWorkspaceTabs 逐字相等，锚点必须是 admin 里真实
// 存在的 DOM id；两者都由 deep-module-authority-boundaries 跨包对账，任一侧改名即失败。
// 判据：链接是"服务端算出的下一步"的一部分，它坏了运营就走不下去，而 TypeScript 看不见字符串。

// 与 packages/admin/src/features/image-workflow-transport.ts 的 characterWorkspaceTabs 同集合。
export const CHARACTER_WORKSPACE_TABS = [
  "project",
  "soul",
  "visual",
  "assets",
  "video",
  "voice",
  "preview",
  "release",
  "monitor",
] as const;

export type CharacterWorkspaceTab = (typeof CHARACTER_WORKSPACE_TABS)[number];

// 页内锚点：值是 admin 里的 DOM id，tab 是承载该控件的面板。两者必须成对给出——只给 id 会让
// 链接停在错误的 tab 上，只给 tab 会让运营自己在长页面里找控件。
export const CHARACTER_WORKSPACE_ANCHORS = {
  visual_identity_version: {
    tab: "visual",
    id: "visual-identity-version",
  },
  visual_reference_set: {
    tab: "visual",
    id: "visual-reference-set",
  },
  route_qualification_workbench: {
    tab: "visual",
    id: "route-qualification-workbench",
  },
} as const satisfies Readonly<
  Record<string, { readonly tab: CharacterWorkspaceTab; readonly id: string }>
>;

export type CharacterWorkspaceAnchor = keyof typeof CHARACTER_WORKSPACE_ANCHORS;

export function characterWorkspaceLink(characterId: string) {
  return `/admin/characters/${encodeURIComponent(characterId)}`;
}

export function characterWorkspaceTabLink(
  characterId: string,
  tab: CharacterWorkspaceTab,
) {
  return `${characterWorkspaceLink(characterId)}?tab=${tab}`;
}

export function characterWorkspaceAnchorLink(
  characterId: string,
  anchor: CharacterWorkspaceAnchor,
) {
  const target = CHARACTER_WORKSPACE_ANCHORS[anchor];
  return `${characterWorkspaceTabLink(characterId, target.tab)}#${target.id}`;
}

// SPEC: 生图（打磨）闸 ≠ 发布闸。这里只保留「没有它就画不出图」的条件。
// INTENT: 密封 hash（*_unsealed）是内容的派生缓存，它的价值是发布时锁住身份，对生成一张
// 草稿图没有意义；却曾要求运营「铸一个新版本」才能继续——用改数据的手段去修一个只需重算的
// 值。发布链仍在 readiness.ts 里检查这两项，打磨阶段不再被它拦住。
export const VISUAL_BLOCKER_CODES = [
  "visual_identity_missing", "visual_anchor_missing", "visual_traits_incomplete",
  "reference_set_not_active", "reference_assets_unavailable",
  "generation_route_unqualified", "generation_route_stale",
] as const;
type VisualBlockerCode = (typeof VISUAL_BLOCKER_CODES)[number];

export function isVisualBlockerCode(code: string): code is VisualBlockerCode {
  return (VISUAL_BLOCKER_CODES as readonly string[]).includes(code);
}

// SPEC: blocker 的 deepLink 直达能完成该动作的控件，不是 Visual 页首。
// INVARIANT: 每个 VisualBlockerCode 都有目标锚点——漏一个是编译错误，不靠测试兜。
const VISUAL_BLOCKER_ANCHORS: Readonly<
  Record<VisualBlockerCode, CharacterWorkspaceAnchor>
> = {
  visual_identity_missing: "visual_identity_version",
  visual_anchor_missing: "visual_identity_version",
  visual_traits_incomplete: "visual_identity_version",
  reference_set_not_active: "visual_reference_set",
  reference_assets_unavailable: "visual_reference_set",
  generation_route_unqualified: "route_qualification_workbench",
  generation_route_stale: "route_qualification_workbench",
};

export function visualBlockerDeepLink(
  characterId: string,
  code: string,
): string {
  return isVisualBlockerCode(code)
    ? characterWorkspaceAnchorLink(characterId, VISUAL_BLOCKER_ANCHORS[code])
    : characterWorkspaceTabLink(characterId, "visual");
}
