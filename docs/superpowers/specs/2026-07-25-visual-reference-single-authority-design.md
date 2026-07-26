# 视觉参考图归一：删除 CharacterVisualProfile 的影子列

**状态**：方案已定，代码改造未实施（2026-07-25）
**关联**：[[admin-ia-redesign-and-deferred-datamodel]] §9 数据模型精简的后续；本轮 L0/L1 已合入工作区

---

## 1. 问题

「这个角色的参考图是哪几张」这一个事实，当前存在 **3 处**：

| 存储 | 形态 |
|---|---|
| `CharacterVisualProfile.referenceAssetIds` | Json 字符串数组 |
| `CharacterVisualProfile.anchorAssetIds` | Json 字符串数组 |
| `ReferenceSetRevision` → `CharacterVisualReferenceSnapshot` | 两张表，每张图带 role/position/weight/crop/score/reason |

多副本必须靠代码裁决谁算数，于是产生了 `visual-authority.ts` /
`reference-media-authority.ts` / `identity-bootstrap-authority.ts` /
`image-readiness-authority.ts` 等模块，以及运营面上 4 道「密封 / 未激活 / 已过期」闸门
（`visual_identity_unsealed`、`reference_set_not_active`、`reference_set_unsealed`、
`reference_assets_unavailable`，见 `CharacterAssetStudio.tsx`）。

## 2. 权威归属（实证，非推断）

付费生成主链路 `service.ts::…referenceAuthority`（约 3790 行）的行为：

- 参考图取自 `ReferenceSetRevision.references`（`status:"active"`，`revision` 最大）
- `anchorAssetIds` 由 `references` 按 `role ∈ {primary_face, identity_anchor}` **现算**
- 严格校验：唯一、position 连续、未删除、`type=image`、`safetyStatus=passed`、
  operational、blob 可取、`characterId` 精确归属，且 `snapshotHash` 必须与内容一致
- **全程不读 `CharacterVisualProfile` 的两个 Json 列**

写入 job 的 `controls.visualIdentity.{anchorAssetIds,referenceAssetIds}` 是**该 revision 的
快照**，供 `ai/reference-images.ts` 在出图时复原当时的参考集 —— 这是正确的不可变快照，
**不在本次改造范围内**。

> 结论：**`ReferenceSetRevision` + `Snapshot` 是参考集的唯一真权威。**

### 2.1 修正：两个 Json 列语义不同，只有一个是影子副本

实施中发现最初的判断过粗。两列必须分开处理：

| 列 | 语义 | 处置 |
|---|---|---|
| `referenceAssetIds` | **参考集的影子副本** —— 与 active revision 的 references 一一对应 | 读点全部改走权威，最终删列 |
| `anchorAssetIds` | **可选图池** —— 可以包含参考集*之外*的图 | **不能当副本删**，见下 |

`publishCharacterReferenceSet` 的 `eligibleIds` 白名单 = `anchorAssetIds ∪ 参考集`。若把它收窄成
参考集自身，运营将**永远无法往参考集里加新图** —— 而"发布新参考集"的全部意义就是加图。
`getCharacterWorkspace` 的 `visualPoolIds` / `anchors` DTO 同理：前端 `referenceCandidates`
由 `anchors ∪ references` 组成，收窄会让候选图消失。

（这个错误犯过两次：先收窄了 `workspace.ts` 的图池，又收窄了 `reference-set.ts` 的白名单，
被 6 个集成测试全数 409 挡下。**anchorAssetIds 不是参考集副本，是候选图池。**）

**图池的正确权威是 `ReferenceCandidate` 表**（候选池，有 candidate/rejected/promoted 状态机），
不是 profile 上的 Json 列。在图池来源迁移到候选池之前，涉及图池的读点保持读 `anchorAssetIds`，
代码里以 `TODO(reference-authority)` 标注（`workspace.ts`、`reference-set.ts` 各一处）。

因此终局是**分两步删列**：`referenceAssetIds` 随本轮改造删除；`anchorAssetIds` 要等图池迁到
`ReferenceCandidate` 之后才能删 —— 那是一个独立的、有产品语义的改造，不属于"消除冗余副本"。

## 3. 漂移实测（dev 库，2026-07-25）

```
profiles=9  identical=8  drifted=1  no_active_revision=0
```

漂移的 `zt-imgsvc-sys-char-profile` 是测试 fixture。真实角色当前全部一致 —— 但这个一致是
**靠散落各处的同步代码维持的**，不是结构保证。存在 `no_active_revision=0` 也说明
「没有 active revision 时回退读 Json 列」的分支（如 `reference-set.ts:88-96`）在真实数据上
是死分支。

## 4. 改造范围（编译器精确探测，非 grep 估算）

方法：临时从 `schema.prisma` 摘掉两列 → `prisma generate` → `tsc --noEmit`，
错误位置即全部真实依赖点（探测后已还原，`typecheck` 绿）。

**生产代码 65 处 / 17 文件；测试 76 处。** 按文件：

| 文件 | 处 |
|---|---|
| `modules/ourdream/service.ts` | 20 |
| `admin-v2/characters/image-readiness-repair.ts` | 6 |
| `admin/characters/visual-profiles.ts` | 5 |
| `admin/content-ops.ts` | 4 |
| `admin/characters/official.ts` | 4 |
| `admin-v2/shared/media-asset-authority-dependencies.ts` | 4 |
| `admin-v2/characters/workspace.ts` | 4 |
| `admin-v2/characters/backfill.ts` | 4 |
| `admin-v2/creative/workflow.ts` | 3 |
| `admin-v2/characters/identity-bootstrap-authority.ts` | 3 |
| `admin-v2/characters/reference-set.ts` | 2 |
| 其余 6 文件各 1 | 6 |

构成：约 25 处真实读点、约 10 处 `select` 子句、约 20 处随源头修复自动消失的类型传递错误。

## 5. 方案

### 5.1 目标修正（重要）

最初设想是「删掉 authority 模块」。精确测量后修正为：

> **删掉冗余列，让 authority 模块从「裁决多个副本」退化为「单一投影」。**

authority 模块会大幅瘦身，但不会消失 —— 因为「从 revision 的 references 派生 anchors」
本身是必要的派生逻辑。真正消失的是**裁决**和随之而来的 4 道密封闸门。

### 5.2 单一读取入口

新增叶子函数（建议置于 `admin-v2/characters/reference-authority.ts`，取代现有分散实现）：

```ts
// SPEC: 角色参考图的唯一读取入口。权威 = active ReferenceSetRevision 的 references。
// INTENT: anchors 一律现算，不再有第二处存储 —— 副本消失，裁决与密封闸门随之消失。
export async function characterReferenceAuthority(
  tx: Prisma.TransactionClient, visualProfileId: string,
): Promise<{ refs: string[]; anchors: string[]; revisionId: string } | null>
```

25 处读点全部改调此函数。

### 5.3 分步顺序（每步独立可验证）

0. ✅ **解开密封 hash 与影子列的耦合**（原计划遗漏，实际是前置）。
1. ✅ **落 `characterReferenceAuthority` + 单测**。
2. ✅ **补上「每个 identity 版本都带 active Reference Set」不变式**。
3. ✅ **改完 admin 侧全部读点**。
4. ✅ **改完 `service.ts`**（付费主链路）。
5. ✅ **`referenceAssetIds` 列已从 schema 与 dev 库删除**（2026-07-25）。
6. ✅ **测试断言收尾完成**（2026-07-25）。

**最终状态**：`typecheck` / `lint` 绿，`admin` + `admin-v2` + `ourdream` 共
**1077 passed / 142 files**，剩余 5 个失败全部是本次改造之前就存在的（LTX/voice 未提交工作
带来的：`api-manifest` 路由计数、`admin-console` video 预期、`voice-generation-service`），
已用 `git stash` 严格比对确认无回归。

### 5.3.3 收尾中发现的两个「typecheck 抓不到」的写点

删列后 `tsc` 全绿、集成测试却 500 —— 两处都绕过了 Prisma 的类型检查：

1. `visual-profiles.ts` 的 `visualProfileSelect` 用 `as const` 而非
   `satisfies Prisma.…Select` —— select 字段完全不受检查。
2. `service.ts` 的 `characterVisualProfileCreateData()` 把 create data 作为**对象字面量返回**
   再经变量传入 `create()` —— TypeScript 的 excess property check 只作用于直接字面量，
   经变量传递即失效。

> 教训：删列不能只信 `tsc`。凡是 `as const` 的 select、以及「构造函数返回 data 再传入
> create/update」的位置，都要人工排查一遍，并以集成测试兜底。

### 5.3.4 测试断言的判据（已应用）

⚠️ `GenerationJob` 有同名列且**必须保留**（不可变生成快照）。逐条判断主语：

| 语境 | 处置 |
|---|---|
| `expect(job/jobs[n]/createdJob).toMatchObject` | 保留 |
| `controls.visualIdentity.referenceAssetIds` | 保留（payload 快照） |
| `referenceAssetIds: null` | 保留（profile 的原本非空，只可能是 job） |
| `createCreativeRun(request({…}))` 请求体 | 保留 |
| `imageReferenceInputsForGenerationJob({…})` 入参 | 保留 |
| `expect(profile/activeProfile/profiles[n]).toMatchObject` | **删**，需验参考集内容的改查 `referenceSetRevision.references` |

本轮两次批量操作事故均源于混淆主语：误删 `generationJob.referenceAssetIds` 导致 release
lineage 校验失败；按行删除吞掉同一行的 `anchorAssetIds` / `adapterRefs`。均已修复。

⚠️ **逐条判断主语再改，不要批量替换**：`GenerationJob` 也有同名列且**必须保留**（它是
不可变的生成快照）。本轮两次批量操作事故都源于此：
- 误删 `release-lifecycle.integration.test.ts` 里 `generationJob.referenceAssetIds`
  → release lineage 校验失败（已修）。
- 按行删除时吞掉了同一行上的 `anchorAssetIds` / `adapterRefs`（已修）。

判据：`referenceAssetIds: null` 或紧邻 `generationJob` 的一定是 job（保留）；
断言对象是 profile / 视觉身份版本的才删，需要验证参考集内容的改为查
`referenceSetRevision.references`。

另需注意：`visual-profiles.ts` 的 `visualProfileSelect` 用的是 `as const` 而非
`satisfies Prisma.…Select`，**类型检查不覆盖它** —— 删列后 typecheck 仍绿但运行时 500。
同类 `as const` select 若还有，需人工排查。

### 5.3.1 步骤 0：密封 hash 解耦（已完成）

`characterVisualProfileSnapshotHash` 曾把 `anchorAssetIds`/`referenceAssetIds` 算进 hash，
存进 `CharacterVisualProfile.immutableHash`。删列会让所有已密封 profile 的 hash 失效，
`qa.ts:125` 与 `release-lifecycle.ts:425` 的守卫会拦住 QA 与发布 —— **这是删列的真正硬约束，
比 65 处读点重要**。

移除是零能力损失：`characterReleaseSnapshotHash` 不含 profile hash（只 pin
`visualProfileId+version` 与 `referenceSetRevisionId` 两个引用），参考图完整性由
`referenceSetSnapshotHash` 独立覆盖 —— 两个 hash 各管一半，合起来无缺口，把参考图再算进
profile hash 是对同一批图的二次覆盖。

历史留痕不受影响：`invariants.ts` 对 `CharacterQaRun.visualProfileHash` 只验存在性、
**不做值比对**，值比对只发生在「当前存储值 vs 当前重算值」之间。

**配套**：`packages/main/src/server/reseal-visual-profile-hashes.ts`（幂等，带 dry-run）。
部署新代码后 dev/prod 各跑一次，否则 QA 与发布会报 sealed hash drifted。

### 5.3.2 步骤 2：补上 Reference Set 不变式（已完成）

两条 profile 创建路径此前不一致：

| 路径 | 建 active revision |
|---|---|
| admin-v2 `identity-bootstrap` | ✅ 同事务原子创建 |
| v1 `admin/characters/visual-profiles.ts`（铸新版本） | ❌ 仅 `if (candidate)` 分支 |

第二条是「有 profile 无 revision」状态的来源，而各处「没有 revision 就回退读影子列」的
分支正是为伺候这个状态而存在。

修法：**任何新 identity 版本都建 active revision** —— 有候选图时用候选图；只改提示词时
**原样继承上一版的 references**（role/position/weight 照搬）；都没有时用已校验的锚点建首版。

**顺带修好一个真实体验问题**：此前铸新身份版本会让角色掉进「无参考集」状态、
`readiness.ready` 变 false，运营改个提示词就得重新发布参考集。现在参考集随版本继承，
改提示词不再打回未就绪 —— 草稿资产仍照常作废，那才是铸版真正该失效的东西。

> ⚠️ **v1 `visual-profiles` 端点不是死端点，不要删。**
> 它是 `CharacterWorkspace.tsx:1735`「激活候选身份」的后端，即视觉身份工作台
> 铸造新版本的唯一路径。（曾因一次带 `head -8` 的截断 grep 被误判为零调用方。）

### 5.4 迁移顺序（DROP 列，零窗口）

按本仓既有惯例：**build → restart → DROP**。新 client 的 model 已无此列，SELECT 从不选它，
删前删后都工作。SQL 见 `db/sql/2026-07-25-drop-visual-profile-shadow-refs.sql`。

## 6. 不做

- **不删 `ReferenceSetRevision` / `Snapshot`**：它们是真权威，且承载 role/position/weight/crop。
- **不动 job payload 里的 `controls.visualIdentity` 快照**：不可变快照是正确设计。
- **不动 `snapshotHash` 密封校验**：它校验的是同一张表内 hash 与内容一致（防篡改），
  不是跨副本同步，成本低、保留。
- **不合并 `CharacterLook`**：与参考集正交（同一身份的不同造型）。
