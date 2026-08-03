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
