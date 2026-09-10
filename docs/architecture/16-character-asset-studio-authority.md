# ADR-12：Character Asset Studio 的角色图片库、草稿与发布权威

更新日期：2026-09-09
状态：Accepted / Implemented
产品说明：[联合评审方案](../product/CHARACTER_ASSET_STUDIO_REVIEW.md)
运营流程：[Character Asset Studio 运营手册](../product/CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md)

## 1. 决策

2026-09-05 产品决策取消日常人工审核关卡，替代本文此前的逐图批准要求。Character Asset Studio 复用 Creative Run 作为生成 authority、Character Project 作为草稿选择 authority、Character Release/Serving 作为发布 authority。历史 Creative Review Decision 只保留为记录；模型评估的实验评分继续使用该存储。基础自动拦截、举报和申诉处理不变。

2026-09-09 依据 [领域语言](../../CONTEXT.md) 修订生成用途与产品槽位的关系：图片先进入同角色图片库，发布运营再决定它出现在哪个产品槽位。生成时的 `purpose` 记录创作请求与历史来源，不再限制合格图片只能用于同名槽位。此前上传图可用于三个槽位、生成图只能用于其生成用途的差异取消；生成和上传仍各自保留完整来源证据。

任何单一 UI 状态、Asset ID 或 Character image 字段都不能跨越这些边界代替完整发布事实。

## 2. 领域映射

| 产品概念 | 实现 authority | 关键事实 |
| --- | --- | --- |
| 角色视觉身份 | active `CharacterVisualProfile` | immutable version、identity prompt、traits、anchors |
| 身份参考集 | active sealed `ReferenceSetRevision` | 精确 reference snapshot |
| 运行生成路线 | active `GenerationModelProfile` + pinned `GenerationRouteQualification` | 兼容的 profile/workflow version、单图策略、精确 lineage |
| Creative Run | `ContentProductionBatch` | 创作 purpose、targetType/targetId、profile/workflow、brief、count；不决定最终产品槽位 |
| Run Item | `ContentProductionItem` | ordinal、Job、Asset、status、version、direction lineage |
| 历史决策与模型实验评分 | `CreativeReviewDecision` | 保留历史事实，不作为日常采用和发布的前置条件 |
| 草稿资产包 | `CharacterProject.draftAssetPack` | purpose 到 exact lineage 的内部映射 |
| 草稿主图 | `CharacterProject.draftImageAssetId` | cover 的可查询 FK 与 Preview fallback |
| 发布快照 | `CharacterRelease.releasePlacementManifest` | 三个 placement 的 immutable lineage |
| 线上事实 | `CharacterServing` + live Character projection | publish command 成功后才改变 |

代码中的 Creative Run 目前由 `ContentProductionBatch`/`ContentProductionItem` 持久化；公共契约统一使用 Creative Run 语言。

## 3. 核心不变量

### 3.1 生成前

- Run 必须绑定 `targetType=character` 与精确 `targetId`；
- 当前 `character_cover`、`character_hero`、`character_chat` purpose 保留为创作构图模板和不可变请求来源；它们不授予或限制最终产品槽位资格；
- 使用 active Visual Profile、active Reference Set 与当前兼容、非 stale route；
- 额外 reference 必须是可用图片，且属于同一个 Character；
- 角色运营 Run 每次必须且只能生成 1 个 Item；旧的模型评测矩阵不是正式生图前置门槛；
- 生成参数固定到 Run/Item lineage，不能随后静默替换。

### 3.2 采用

- 已完成且通过基础自动检查的素材可直接采用，不创建虚假的评分或人工批准；
- Asset 必须存在、可用，并精确属于所提交的 Run Item；
- Run 的 target 必须属于同一 Character；生成图片可以被选择到任一产品槽位，不要求 generation purpose 等于 selection purpose；
- 采用固定原 Run/Item/Job lineage，不改写生成请求或伪造一个与新槽位同名的 Run。发布重验 Job 的 source metadata 与原 Run 相符；
- Character Project 更新使用 `If-Match` + body `entityVersion` 做 compare-and-swap；
- 采用只更新草稿，不直接修改 live Character；
- 待发布 candidate Release 存在时禁止改写草稿资产包；可通过有审计的 withdraw 放弃候选后编辑。

### 3.3 发布

- Release proposal 把三个草稿 entry 转换为 immutable placements；
- 生成 placement 保存 `assetId + runId + itemId + generationJobId`；上传素材保留独立上传来源，不伪造生成记录；历史 `reviewDecisionId` 为可选记录；
- slot/purpose 映射固定为：
  - `character_avatar` → `character_cover`
  - `character_hero` → `character_hero`
  - `character_chat` → `character_chat`
- 发布 validation 重新检查素材可用性、角色归属、原 Run/Item/Job 的来源一致性与 provider/attempt，不用最终槽位反推历史生成用途；
- 建立视觉身份的首张生成图可以用于任一槽位，但仍须精确证明它建立了快照所固定的 Visual Profile 与 Reference Set；`bootstrapIdentity` 不能绕过这份来源核验；
- 历史评分和决策变化不改变图片资格；文件、安全状态和来源失效仍阻止发布；
- 只有 publish command 成功后才更新 Serving/live projection。

## 4. 状态流

```mermaid
sequenceDiagram
    participant O as Operator
    participant A as Admin Web/BFF
    participant C as Creative authority
    participant P as Character Project
    participant R as Release authority
    participant S as Serving projection

    O->>A: Generate one image from a creative brief
    A->>C: POST Creative Run count=1 (idempotent)
    C-->>A: Run + one Item + one Job
    O->>A: Select an existing library image for a product placement
    A->>P: CAS update draftAssetPack
    P-->>A: New project version
    O->>A: Propose Release
    A->>R: Freeze placements + lineage
    O->>A: Validate frozen snapshot
    A->>R: Recheck current asset authority
    O->>A: Publish command
    R->>S: Update serving/live projection
```

## 5. 草稿数据形状

`CharacterProject.draftAssetPack` 的内部持久化形状：

```json
{
  "character_cover": {
    "assetId": "asset_...",
    "runId": "run_...",
    "itemId": "item_...",
    "generationJobId": "job_..."
  },
  "character_hero": {
    "assetId": "asset_...",
    "runId": "run_...",
    "itemId": "item_...",
    "generationJobId": "job_..."
  },
  "character_chat": {
    "assetId": "asset_...",
    "runId": "run_...",
    "itemId": "item_...",
    "generationJobId": "job_..."
  }
}
```

公共 Workspace DTO 只暴露每个 purpose 的 Asset ID，避免 UI 误用内部 lineage 代替服务端校验。服务端在 selection 与 Release proposal 时使用完整形状。

## 6. API 与权限参考

| 操作 | Endpoint | 权限 | 并发/幂等 |
| --- | --- | --- | --- |
| 查询角色 Runs | `GET /api/v2/admin/creative/runs?targetType=character&targetId=…&sort=updated_desc` | `creative.run.read` | cursor query |
| 创建 Run | `POST /api/v2/admin/creative/runs` | `creative.run.write` | `Idempotency-Key` |
| 查询 Run lineage | `GET /api/v2/admin/creative/runs/:id` | `creative.run.read` | read |
| 采用草稿素材 | `PATCH /api/v2/admin/characters/:id/draft-image` | `character.project.write` | `If-Match` + entity version |
| 创建 Release proposal | `POST /api/v2/admin/characters/:id/releases` | `character.release.propose` | `Idempotency-Key` |
| 校验 Release | `POST /api/v2/admin/characters/:id/releases/:releaseId/validation` | `character.release.publish` | `Idempotency-Key` |
| 发布 Release | `POST /api/v2/admin/characters/:id/releases/:releaseId/commands/publish` | `character.release.publish` | `Idempotency-Key` |

API manifest 与 Zod 契约的单一事实来源：

- `packages/shared/src/admin/api-manifest.ts`
- `packages/shared/src/admin/contracts/characters-release.ts`
- `packages/shared/src/admin/contracts/characters-visual-workspace.ts`
- `packages/shared/src/admin/contracts/creative.ts`

## 7. 写入副作用

采用草稿素材的事务同时写入：

- Character Project 新版本；
- Audit event（before/after 与 reason）；
- Collaboration activity；
- Outbox event。

生成、采用、Release proposal、validation 与 publish 分别保留自己的审计与事件证据。客户端成功提示不是任何异步动作完成的 authority。

## 8. 失败语义

| 条件 | 结果 |
| --- | --- |
| Run target 或原生成来源不匹配 | fail closed |
| Asset 不属于 Item 或不可用 | fail closed |
| Character Project version 过期 | conflict，客户端刷新后重试 |
| active candidate Release 已存在 | conflict，先处理 Release |
| proposal 后文件或来源失效 | validation failed，可放弃候选后修复并重建 |
| 生成部分失败 | 保留成功 Item，可直接选择采用；失败项不冒充成功 |

## 9. 关键实现位置

- Admin 工作台：`packages/admin/src/features/characters/CharacterAssetStudio.tsx`
- Character Workspace 接入：`packages/admin/src/features/characters/CharacterWorkspace.tsx`
- 草稿采用 authority：`packages/main/src/server/modules/admin-v2/characters/asset-studio.ts`
- Release proposal：`packages/main/src/server/modules/admin-v2/characters/release-lifecycle.ts`
- 发布校验与执行：`packages/main/src/server/modules/admin-v2/characters/release-executor.ts`
- Shared contracts：`packages/shared/src/admin/contracts/characters-release.ts`、`characters-visual-workspace.ts`、`creative.ts`
- Schema：`packages/main/prisma/schema.prisma`
- Migration：`packages/main/prisma/migrations/20260713010000_character_asset_studio/`

## 10. 验证契约

最低回归集：

```bash
bun run --filter @idream/admin test src/features/characters/CharacterAssetStudio.test.ts
bun run --filter @idream/shared test src/admin/contracts/characters-asset-studio.test.ts
bun run --filter @idream/main test src/server/modules/admin-v2/characters/asset-studio.integration.test.ts
bun run --filter @idream/main test:pure src/server/modules/admin-v2/characters/image-qualification.test.ts
bun run --filter @idream/main test src/server/modules/admin-v2/characters/release-historical-image-authority.integration.test.ts
bun run --filter @idream/main test src/server/modules/admin-v2/characters/release-recovery.integration.test.ts
```

合并前继续执行仓库级 `bun run check` 与完整测试。涉及 schema 时必须在隔离 PostgreSQL 数据库演练 migration；涉及工作台交互时必须完成真实浏览器生成、三类采用、Preview 与控制台检查。
