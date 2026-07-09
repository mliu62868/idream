# 数据模型精简 ③：`MediaAsset.characterId` 正规化为 FK

- 日期：2026-07-09
- 范围：把游离的 `MediaAsset.characterId` String 列正规化成真正的 Prisma 关系（加 FK 约束 + 反向 accessor）
- 关联：spec §9-③；承接 §9-②（recipe rename）
- 状态：设计已确认（onDelete=SetNull），执行中

## 1. 关键发现（scope 比"双绑定收敛"小）
查真实用法后确认：`imageAssetId` / `characterId` / `sourceJob.characterId` **不是冗余**，是三种不同关系：
- `Character.imageAssetId` (FK, `CharacterImage`) = **当前头像**（角色→1 张）。30 处在用，保留。
- `MediaAsset.characterId` = **归属**（asset→角色）。51/73 条数据在用，有 `media_assets_characterId_idx` 索引；写在 `local-pipeline.ts:537`（生图时 `characterId: job.characterId`），读在 `reference-images.ts:41`（`where.OR:[{characterId}]` 取角色参考图）。**唯一 smell：它是游离 String，没有 FK 关系**（无引用完整性、无反向 accessor）。
- `sourceJob.characterId` = **出处**，可推导，保留。

所以 ③ = **只把 `characterId` 正规化成 FK**，不合并、不动 `imageAssetId` / `sourceJob`。

## 2. 改动
**schema**（`packages/main/prisma/schema.prisma`）：
- `MediaAsset` 加：`character Character? @relation("CharacterAssets", fields: [characterId], references: [id], onDelete: SetNull)`
- `Character` 加反向：`mediaAssets MediaAsset[] @relation("CharacterAssets")`
- `@@index([characterId])` 已存在，不变。既有 `CharacterImage`（imageAssetId 头像关系）不变——两个具名关系并存。

**代码**：极小。现有 `where:{ characterId }`（reference-images）、`create({ data:{ characterId }})`（local-pipeline）**照常工作**（Prisma 允许直接读写标量 FK）；新增能力仅 `character.mediaAssets` accessor（本次不强制改用）。`prisma generate` 更新 client。

## 3. 迁移（代理在 dev 执行；prod 出文件）
dev 库现状：73 assets，51 条 characterId 非空，**2 条孤儿**（指向已删角色）。加 FK 前必须清孤儿，否则 `ADD CONSTRAINT` 失败。

`db/sql/2026-07-09-mediaasset-characterid-fk.sql`：
```sql
BEGIN;
-- 1) 清 2 条孤儿：characterId 指向不存在的角色 → 置空
UPDATE public.media_assets m SET "characterId" = NULL
  WHERE m."characterId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = m."characterId");
-- 2) 加 FK（名字对齐 Prisma 默认 {table}_{col}_fkey；camelCase 列需引号）
ALTER TABLE public.media_assets
  ADD CONSTRAINT "media_assets_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES public.characters(id) ON DELETE SET NULL;
COMMIT;
```
- **绝不 `db push`**（沿用 §9-② gotcha；虽是加约束但手写更可控）。事务化 → 失败整体回滚。
- **cutover 极轻**：加 FK 是 DB 层约束，运行中的旧代码用标量 `characterId` 读写**照常**、无需 rebuild/restart（新 `character` accessor 无人用）。跑完 SQL 即完成；client 侧的关系随下次构建自然带上。
- 测试库每次从 schema 全新建 → 自动带 FK；若某测试插入了非法 characterId 会被 FK 拒绝（那是测试 bug，改用有效角色）。

## 4. 验收
- [ ] schema 两处关系就位；`prisma generate` 后 client 有 `character.mediaAssets`。
- [ ] `bun run typecheck` + 相关 vitest 绿（测试库带 FK 跑通）。
- [ ] dev：2 孤儿已 SetNull、`media_assets_characterId_fkey` 存在、51→49 条有效 characterId（或 51 条若孤儿本就该保留……实为 49 有效 + 2 置空）、数据无损。
- [ ] 交付 `db/sql/2026-07-09-mediaasset-characterid-fk.sql`（prod 用户跑）。

## 5. 后续（§9 剩余）
- ④ negative prompt 三源归一（出图相关，下一项）。
- ① `CharacterTemplate ↔ 官方角色` 合并（产品决策，待用户定语义）。
