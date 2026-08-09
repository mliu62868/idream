import type { Prisma } from "@prisma/client";
import { CHARACTER_SERVING_STATES } from "../shared/state-transition-authority";

type ServingState = (typeof CHARACTER_SERVING_STATES)[number];

/**
 * SPEC: 从 Serving 状态推导可变 Character 行的 status / visibility —— 全仓唯一一份。
 *
 * INTENT: 受治理的发布链（Project → Release → Serving）与客户实际读到的 Character 行是两条并行
 * 生命周期，靠手写投影缝合。缝合点此前散在 release-executor 的两处硬编码字面量里：发布路径写
 * `status:"approved", visibility:"public"`，暂停/退役路径写 `status:"archived",
 * visibility:"private"`。两处各自独立，改一处不改另一处就会出现「Release 认为已下线、客户仍能
 * 看到」。
 *
 * INVARIANT: chat 侧的 `character-eligibility` 只读 Character 行，不看 Release/Serving。因此这个
 * 投影是发布权威唯一能影响客户可见性的地方——绕过它写 Character.status/visibility 就等于让
 * 发布链和实际服务状态分叉。
 */
export function servingCharacterProjection(input: {
  readonly state: ServingState;
  readonly avatarAssetId?: string | null;
}) {
  return input.state === "live"
    ? {
        status: "approved",
        visibility: "public",
        ...(input.avatarAssetId !== undefined
          ? { imageAssetId: input.avatarAssetId }
          : {}),
      }
    : {
        // paused 是运营暂扣、retired 是终态，客户侧一律不可见；封面指针保留，恢复时原样回到线上。
        status: "archived",
        visibility: "private",
      };
}

/**
 * 把一次 Serving 状态变更投影到 Character 行。发布链里所有改变客户可见性的写入都必须经过这里。
 */
export async function projectServingToCharacter(
  tx: Prisma.TransactionClient,
  input: {
    readonly characterId: string;
    readonly state: ServingState;
    readonly avatarAssetId?: string | null;
    readonly content?: Prisma.CharacterUncheckedUpdateInput;
  },
) {
  await tx.character.update({
    where: { id: input.characterId },
    data: {
      ...input.content,
      ...servingCharacterProjection({
        state: input.state,
        avatarAssetId: input.avatarAssetId,
      }),
    },
  });
}
