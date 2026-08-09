import { canonicalSha256 } from "../shared/canonical-json";

// SPEC: 视觉身份的密封 hash —— 覆盖「这个角色长什么样」的描述性事实（提示词 + 五组 traits）。
// INTENT: 参考图**不进这个 hash**。参考图的完整性由 referenceSetSnapshotHash 独立覆盖
// （mediaAssetId/position/role/weight），而 CharacterRelease 同时 pin 了 visualProfileId+version
// 与 referenceSetRevisionId 两个引用——两个 hash 各管一半，合起来无缺口。此前把 profile 上的
// anchorAssetIds/referenceAssetIds 影子副本也算进来，是对同一批图做第二次覆盖，且把密封与那两个
// 冗余列焊死，挡住了它们的删除。移除是语义修正，不是能力损失。
export function characterVisualProfileSnapshotHash(profile: {
  readonly version: number;
  readonly style: string;
  readonly identityPrompt: string;
  readonly negativeIdentityPrompt: string | null;
  readonly faceTraits: unknown;
  readonly hairTraits: unknown;
  readonly bodyTraits: unknown;
  readonly signatureTraits: unknown;
  readonly styleTraits: unknown;
}) {
  return canonicalSha256({
    version: profile.version,
    style: profile.style,
    identityPrompt: profile.identityPrompt,
    negativeIdentityPrompt: profile.negativeIdentityPrompt,
    traits: {
      face: profile.faceTraits,
      hair: profile.hairTraits,
      body: profile.bodyTraits,
      signature: profile.signatureTraits,
      style: profile.styleTraits,
    },
  });
}

export function referenceSetSnapshotHash(input: {
  readonly visualProfileId: string;
  readonly revision: number;
  readonly selectorVersion: string;
  readonly references: readonly {
    readonly mediaAssetId: string;
    readonly position: number;
    readonly role: string;
    readonly weight: number;
  }[];
}) {
  return canonicalSha256({
    visualProfileId: input.visualProfileId,
    revision: input.revision,
    selectorVersion: input.selectorVersion,
    references: input.references.map((item) => ({
      mediaAssetId: item.mediaAssetId,
      position: item.position,
      role: item.role,
      weight: item.weight,
    })),
  });
}

export function characterReleaseSnapshotHash(input: {
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly characterContentVersionId: string | null;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
  readonly referenceSetRevisionId: string | null;
  readonly generationProvenance: unknown;
  readonly releasePlacementManifest: unknown;
}) {
  return canonicalSha256(input);
}
