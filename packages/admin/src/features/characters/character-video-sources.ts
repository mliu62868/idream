// SPEC: 角色可用来生成视频的源图 —— 已采用的封面 / 主视觉 / 聊天图排前，其余可用图片随后。
// INTENT: 视频创作台与聊天素材的视频预生成包都从这里选源图；纯函数单独成模块，
//         这样只渲染其中一个组件的测试可以 mock 另一个组件而不丢掉这份推导。
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";

export type CharacterVideoSourceOption = {
  readonly assetId: string;
  readonly label: string;
  readonly labelValues?: Readonly<Record<string, string | number>>;
  readonly url: string;
  readonly thumbnailUrl: string | null;
};

const adoptedSourceLabels = {
  character_cover: "Primary portrait",
  character_hero: "Character hero",
  character_chat: "Chat moment",
} as const;

export function characterVideoSourceOptions(
  data: Pick<CharacterWorkspaceDetail, "project" | "visual">,
): readonly CharacterVideoSourceOption[] {
  const assets = new Map(
    [
      ...data.visual.videoSources,
      ...data.visual.anchors,
      ...data.visual.references,
    ]
      .filter((asset) => asset.available && asset.url)
      .map((asset) => [asset.mediaAssetId, asset] as const),
  );
  const options: CharacterVideoSourceOption[] = [];
  const used = new Set<string>();
  for (const purpose of Object.keys(adoptedSourceLabels) as Array<
    keyof typeof adoptedSourceLabels
  >) {
    const assetId = data.project.draftAssetPack[purpose];
    const asset = assetId ? assets.get(assetId) : undefined;
    if (!asset || !asset.url || used.has(asset.mediaAssetId)) continue;
    used.add(asset.mediaAssetId);
    options.push({
      assetId: asset.mediaAssetId,
      label: adoptedSourceLabels[purpose],
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
    });
  }
  for (const asset of assets.values()) {
    if (!asset.url || used.has(asset.mediaAssetId)) continue;
    used.add(asset.mediaAssetId);
    options.push({
      assetId: asset.mediaAssetId,
      label: "Character image {id}",
      labelValues: { id: options.length + 1 },
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
    });
  }
  return options;
}
