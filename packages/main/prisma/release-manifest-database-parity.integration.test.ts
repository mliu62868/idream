import { parseCharacterReleaseAssetManifest } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

// SPEC: 同一组 manifest 样本，共享 Zod 契约与数据库契约函数必须给出同一个结论。
// INTENT: 这两侧曾经漂移了一周多 —— 应用层取消逐图审核决定，数据库仍然要求它，于是 Admin
//         的发布预检 16 项全绿、点下去执行器回滚，运营拿不到任何可修的信息。文本比对只能钉住
//         SQL 长什么样，钉不住它到底接受什么；把样本真的喂给函数才能。
// INVARIANT: 这里只调用纯函数，不写任何表，也不依赖触发器是否安装。

function placement(
  slotKey: "character_avatar" | "character_hero" | "character_chat",
  overrides: Record<string, unknown> = {},
) {
  return {
    slotKey,
    assetId: `${slotKey}-asset`,
    slotVersion: 1,
    runId: `${slotKey}-run`,
    itemId: `${slotKey}-item`,
    generationJobId: `${slotKey}-job`,
    ...overrides,
  };
}

function manifest(placements: Record<string, unknown>[]) {
  return { schemaVersion: 2, placements };
}

async function databaseAccepts(value: unknown) {
  try {
    // 函数返回 void，驱动不认这个原生类型，所以包一层成常量列再选出来。
    await prisma.$queryRaw`
      SELECT true AS accepted
      FROM (SELECT assert_character_release_asset_manifest_v2(${JSON.stringify(value)}::jsonb)) AS checked
    `;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("strict v2 Release manifest contract")) return false;
    throw error;
  }
}

const samples: Array<{ label: string; value: unknown }> = [
  {
    label: "directly adopted generation without a review decision",
    value: manifest([
      placement("character_avatar"),
      placement("character_hero"),
      placement("character_chat"),
    ]),
  },
  {
    label: "historical placements that still carry a review decision",
    value: manifest([
      placement("character_avatar", { reviewDecisionId: "decision-a" }),
      placement("character_hero", { reviewDecisionId: "decision-b" }),
      placement("character_chat", { reviewDecisionId: "decision-c" }),
    ]),
  },
  {
    label: "imported library images with no generation lineage",
    value: manifest([
      { slotKey: "character_avatar", assetId: "a", slotVersion: 1 },
      { slotKey: "character_hero", assetId: "b", slotVersion: 1 },
      { slotKey: "character_chat", assetId: "c", slotVersion: 1 },
    ]),
  },
  {
    label: "a bootstrap identity placement",
    value: manifest([
      placement("character_avatar", { bootstrapIdentity: true }),
      placement("character_hero"),
      placement("character_chat"),
    ]),
  },
  {
    label: "partial generation lineage",
    value: manifest([
      { ...placement("character_avatar"), itemId: undefined },
      placement("character_hero"),
      placement("character_chat"),
    ]),
  },
  {
    label: "two placements sharing one asset",
    value: manifest([
      placement("character_avatar"),
      placement("character_hero", { assetId: "character_avatar-asset" }),
      placement("character_chat"),
    ]),
  },
  {
    label: "a duplicated slot",
    value: manifest([
      placement("character_avatar"),
      placement("character_avatar"),
      placement("character_chat"),
    ]),
  },
  {
    label: "an unknown placement key",
    value: manifest([
      { ...placement("character_avatar"), unexpected: "x" },
      placement("character_hero"),
      placement("character_chat"),
    ]),
  },
  {
    label: "a blank review decision id",
    value: manifest([
      placement("character_avatar", { reviewDecisionId: "   " }),
      placement("character_hero"),
      placement("character_chat"),
    ]),
  },
  {
    label: "only two placements",
    value: manifest([placement("character_avatar"), placement("character_hero")]),
  },
  {
    label: "a zero slot version",
    value: manifest([
      placement("character_avatar", { slotVersion: 0 }),
      placement("character_hero"),
      placement("character_chat"),
    ]),
  },
];

describe("Release placement manifest: shared contract vs database contract", () => {
  it.each(samples)("agrees on $label", async ({ value }) => {
    // JSON.stringify 会丢掉 undefined 的键，这正是"这个键不存在"要表达的形状。
    const normalized: unknown = JSON.parse(JSON.stringify(value));
    const sharedAccepts = parseCharacterReleaseAssetManifest(normalized) !== null;
    await expect(databaseAccepts(normalized)).resolves.toBe(sharedAccepts);
  });
});
