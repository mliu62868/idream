# 数据模型精简 ④：移除死字段 `GenerationModelProfile.negativeTemplateId`

- 日期：2026-07-09
- 范围：删除 vestigial `negativeTemplateId`（列 + admin CRUD + seed）
- 关联：spec §9-④；状态：已确认「彻底移除」，执行中

## 1. 发现（"三源归一"其实是"删一个死字段"）
生图的有效负面词只有 **2 个真源**，且已在一个函数里干净合成：
```ts
// ourdream/service.ts imageNegativePrompt()
return [cleanBase /*recipe.negativeBase*/, identityNegative /*visualProfile.negativeIdentityPrompt*/].filter(Boolean).join(", ")
```
两源是 base 质量负面 vs per-character 身份负面，**互补、正确分层、已统一**。
`GenerationModelProfile.negativeTemplateId`（dev 6/14 有值、seed 写死成 recipe key）**只在 admin CRUD 出现（service.ts:183/211/1955），生图路径从不读**→ 死字段。删它 **零出图变化**。

## 2. 改动（已完成）
- schema：删 `negativeTemplateId String?`。
- `admin/service.ts`：删 2 处 zod + 1 处 set。
- `seed.ts`：删 12 处写入。无 UI 字段。
- `prisma generate` + typecheck 绿；grep 源码零残留；admin+generation vitest 78/78。

## 3. 迁移（代理 dev 执行；prod 出文件）
`db/sql/2026-07-09-drop-negativetemplateid.sql`：`ALTER TABLE public.generation_model_profiles DROP COLUMN "negativeTemplateId";`（事务化）。
- **绝不 db push**。
- **cutover 顺序 = build → restart → DROP（零误差窗口）**：新 client 的 model 已无此列 → 它的 SELECT 从不选它 → 在"列还在"和"列已删"两种状态下都工作。所以先 build 出新 client、restart 受影响进程（main-web/admin-web/gen-finalizer/main-event-consumer；gen-image/chat 不碰 model_profiles/独立库），**最后**再 DROP 列 → 全程无进程打在缺列上。
- 数据：仅丢那 6 个从未被用的 negativeTemplateId 值，无行为影响。

## 4. 验收
- [ ] 源码零 `negativeTemplateId`；typecheck + vitest 绿。
- [ ] dev：列已 DROP；受影响进程 restart 后全 online、无 column 错误。
- [ ] 交付 SQL 文件给 prod。

## 5. 后续
- ① `CharacterTemplate ↔ 官方角色` 合并（产品决策，§9 最后一项）。
