import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";

// SPEC: 角色参考图的唯一读取入口。权威 = active ReferenceSetRevision 的 references；
//       anchors 由 reference.role 现算，不存第二份。
// INTENT: 此前同一事实存在三处（CharacterVisualProfile.anchorAssetIds / .referenceAssetIds
//       两个 Json 影子列 + 本表），调用方各自决定信哪个——有的「revision 优先、影子回退」，
//       有的干脆只读影子（如 workspace.ts 的 anchorAssetIds）。裁决逻辑本身成了新的事实来源。
//       付费生成主链路（service.ts referenceAuthority）从来只认本表，所以本表是权威，
//       影子列待删（见 docs/superpowers/specs/2026-07-25-visual-reference-single-authority-design.md）。

// anchors 与付费主链路口径一致：primary_face + identity_anchor 才是身份锚点，
// identity_reference 只是补充参考，不能当锚。
const ANCHOR_ROLES = new Set(["primary_face", "identity_anchor"]);

export type CharacterReferenceAuthority = {
  readonly revisionId: string;
  readonly revision: number;
  /** 全部参考图，按 position 升序 */
  readonly refs: readonly string[];
  /** 其中的身份锚点，保持 refs 的相对顺序 */
  readonly anchors: readonly string[];
};

type ReferenceSetShape = {
  readonly id: string;
  readonly revision: number;
  readonly references: readonly {
    readonly mediaAssetId: string;
    readonly role: string;
  }[];
};

/**
 * 从已查出的 active revision 派生权威。调用方大多已经 include 了 references，
 * 用这个纯函数避免二次查询。references 必须已按 position 升序。
 */
export function characterReferenceAuthorityFrom(
  referenceSet: ReferenceSetShape | null | undefined,
): CharacterReferenceAuthority | null {
  if (!referenceSet) return null;
  const refs = referenceSet.references.map((reference) => reference.mediaAssetId);
  return {
    revisionId: referenceSet.id,
    revision: referenceSet.revision,
    refs,
    anchors: referenceSet.references
      .filter((reference) => ANCHOR_ROLES.has(reference.role))
      .map((reference) => reference.mediaAssetId),
  };
}

/** 没有现成 revision 时的查询入口。 */
export async function loadCharacterReferenceAuthority(
  tx: Prisma.TransactionClient | typeof prisma,
  visualProfileId: string,
): Promise<CharacterReferenceAuthority | null> {
  return characterReferenceAuthorityFrom(
    await tx.referenceSetRevision.findFirst({
      where: { visualProfileId, status: "active" },
      select: {
        id: true,
        revision: true,
        references: {
          orderBy: { position: "asc" },
          select: { mediaAssetId: true, role: true },
        },
      },
      orderBy: { revision: "desc" },
    }),
  );
}
