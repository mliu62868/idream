# Admin「生成」组重构 — 设计 (Spec)

- **Date:** 2026-07-09
- **Status:** Approved (brainstorming) → ready for writing-plans
- **Scope:** presentation-layer only（前端）
- **Owner:** admin console

## 1. 背景与问题

`/admin/generation/*` 这一组页面（由 `packages/main/src/components/admin/AdminConsoleClient.tsx`
渲染，该文件 7709 行，`ConfigView` 一个视图从 3230 行起）对**运营人员**基本不可用——它是一个
工程调试面板套了运营的壳。实机（`http://127.0.0.1:3001/admin/generation/config`，中文模式）确认的
病症：

1. **双语混乱**：语言开关是中文，但大量英文兜底穿透（`t()` 查不到 key 就回退英文）。例：
   `Built-in profiles, test, publish, monitor`、`Operate seeded generation profiles here…`、
   `status = active`、`Verification status missing · No component status recorded`。
2. **工程黑话怼脸**：内部 ID `profile_sdcpp_darkbeast_krea2_img2img_v1`、权重文件名
   `darkBeastKrea2_dbkleinv2BFS.safetensors`、原始错误码
   `missing_flux2_klein_reference_runtime_components` / `failureMode: missing_runtime_components`、
   组件名 `flux2Vae`/`comfyWorkflow`/`flux2BaseModel`。运营无从下手。
3. **布局塌陷**：config 右侧"已选配置"工作台栏过窄，`试运行/验证/最近任务/输出尺寸` 被挤成
   一列一个字竖排，错误码逐字符换行。
4. **满屏红 + 无出路 + 重复**：每个 profile 都"发布已阻止"，卡在运营改不了的组件上；同一
   错误码一屏出现三四次，`模型配置`×3、草稿数 `10`×3。

**根因**：导航把"运营要操作的页"和"工程诊断页"平铺成同级同权重，运营分不清哪些是自己的；
且页面内部把工程标识符/错误码直接渲染给运营。光"每页折叠黑话"治标不治本。

### 已确认的现状（降低设计风险）

- `nav-config.ts` 已有 guided nav（`tier: "daily"|"folded"` + 分组），生成相关的已分成
  `GenerationConfig`(config/recipes/presets) 与 `Engineering`(workflows/backends/ops-providers/
  jobs/dead-letter/metrics，注释标注 "hidden-by-default diagnostics")。**三层不是重造，是把
  Engineering 再拆开。**
- i18n 是一张 `zh: Record<string,string>`（`i18n.tsx`，923 行），`t(key)` 查不到 → 兜底回 key。
  "补翻译" = 把缺失 key 补进这张表，机制现成。

## 2. 目标 / 非目标

**目标**
- 把「生成」组重排成运营看得懂、走得动的**三层**界面。
- 统一"列表→选中→动作"动线与"工程黑话默认折叠"规则，规则活在**共享原语**里（SSoT，不逐页重写）。
- 补齐 i18n，修掉 config 布局塌陷。
- 失败原因用**人话 + 建议动作**呈现（运维自助排查）。

**非目标（明确不做）**
- 不动 API / Prisma schema / worker（纯前端）。
- 不做角色门禁 / RBAC（"role 不重要"——用引导与视觉层级区分，不用权限）。
- 不改 `workflows` 的工程本质（它就是工程诊断视图）。
- 不碰既定延后项（safety-gateway、video、`MODERATION_PROVIDER=mock` 等）。

## 3. 关键决策（brainstorming 已拍板）

| # | 决策 | 取舍 |
|---|---|---|
| D1 | 运营主线 = **测试→发布** + **只读自助排查**（任务/事故/死信/后端健康），但不改 workflow | 见 §4 三层 |
| D2 | 失败人话来源 = **纯前端字典** `failureReasons.ts`（不改后端） | 最小改动、SSoT 在前端一处 |
| D3 | 实现策略 = **共享原语 + 薄页面**（不逐页手改、不只动导航） | 真正"统一"、未来页自动继承 |

## 4. 架构

### 4.1 三层 IA（改 `packages/main/src/components/admin/nav-config.ts`）

把现有两组重排成三组。**只改 `group` 字段 + 组顺序 + 组显示名 i18n；`id`/`href`/`icon`/`tier`
全不动**，守住 nav-config 既有 INVARIANT（daily+folded 覆盖所有 id 恰好一次）。

| 新组 | 成员（id） | 定位 |
|---|---|---|
| **Operations（运营）** | `generation/config`、`generation/recipes`、`generation/presets` | 主区：选→试→发 |
| **GenerationOps（运维·只读）** | `generation/jobs`、`generation/dead-letter`、`generation/backends`、`ops/providers` | 自助排查"为什么失败/卡住" |
| **Engineering（工程·诊断）** | `generation/workflows`、`generation/metrics` | 纯诊断，退到最次要 |

- 组显示名走 i18n（运营 / 运维 / 工程诊断）；确保 `FOLDED_GROUP_ORDER`、`nav-config.test.ts`、
  `i18n-nav.test.ts` 同步更新。
- 组顺序：Operations 在 GenerationOps 之前，Engineering 最后。

### 4.2 四个共享原语（新文件，刻意少且小）

建议目录 `packages/main/src/components/admin/generation/`（primitives 与薄页面同处），具体路径由
plan 定。原语数量压到最少；`OperatorFlow` 与 `ReadonlyOpsView` 内部**可**共用一个 `ItemList`，
是否抽取交给 plan，不硬抽。

| 原语 | Props（示意） | 职责 |
|---|---|---|
| `FailureReason` | `{ code: string; detail?: string }` | 查 `failureReasons.ts` → 人话标题 + 建议动作；原始 code/detail 折进 `EngineeringDetails` |
| `EngineeringDetails` | `{ summary: ReactNode; children }` | `<details>` 折叠容器：默认折叠，标题一行人话摘要，展开才见 ID/文件名/原始码/组件表。**所有工程黑话统一进这里** |
| `OperatorFlow` | `{ items; selectedId; onSelect; renderDetail; actions }` | 列表→选中→动作栏 骨架（响应式栅格，窄屏单栏回退）；profiles/recipes/presets 复用 |
| `ReadonlyOpsView` | `{ items; columns; renderStatus }` | 只读表格/卡片 + 人话状态 + `FailureReason`；jobs/dead-letter/backends/providers 复用 |

**不变量**
- `EngineeringDetails` 默认折叠（运营首屏不见黑话）。
- `OperatorFlow` 动作按钮的可用性由传入的 `actions` 决定（例：发布仅在"可发布"时亮），
  原语不含业务判断。

### 4.3 `failureReasons.ts`（字典 SSoT，纯前端）

```ts
type Severity = "retry" | "engineering" | "waiting";
type FailureReason = { title: string; hint: string; severity: Severity };
const FAILURE_REASONS: Record<string, FailureReason> = {
  missing_runtime_components: {
    title: "模型文件未就绪",
    hint: "缺运行组件，需工程处理",
    severity: "engineering",
  },
  timeout: { title: "生成超时", hint: "可重试", severity: "retry" },
  // …按实机出现的 failureMode / verificationStatus 逐步补
};
// 未知 code → 兜底：{ title: "未知错误", hint: "请把错误代码给工程", severity: "engineering" } + 原码
```

- 文案走 i18n（title/hint 是可翻译 key，或字典存 key 再 `t()`——由 plan 定，保持 SSoT）。
- `severity` 决定动作与配色：retry→给"重试"、engineering→给"复制给工程"、waiting→只提示等待。

### 4.4 每页薄化映射

| 页面 (render fn) | 用原语 | 运营看到 | 折进 EngineeringDetails |
|---|---|---|---|
| 模型配置 `ConfigView`(~3230) | OperatorFlow + FailureReason + EngineeringDetails | 草稿列表→选→[试运行/发布(能发才亮)]；状态一行人话（待测试/可发布/被阻止+原因）| `profile_...`、`.safetensors`、槽位、组件校验表、原始 `verificationStatus` |
| 配方 `PromptRecipesView`(3321) | OperatorFlow | label+用途(useCase)+状态；动作 publish/rollback | `id`、`recipeKey` |
| 预设 `GenerationPresetsView`(3354) | OperatorFlow（只读/轻动作）| label+类别+可见性+状态 | raw `id`、`type` |
| 任务·事故 `JobsView`(2445) | ReadonlyOpsView + FailureReason | 角色/时间/状态；失败→人话 | jobId、原始 error |
| 死信 `DeadLetterView`(5618) | ReadonlyOpsView + FailureReason | 失败消息人话摘要 | queue payload |
| 后端 `BackendsView.tsx` / 供应商健康 | ReadonlyOpsView | 名称+健康✓✗+延迟；失败→人话 | endpoint/cliPath |
| 工作流 `WorkflowsView.tsx` / 指标 `GenerationMetricsView` | 原样（工程组，不薄化）| —（本身就是详情）| — |

config 是最重的一页（含 dry-run/publish/rollback/verification 业务逻辑）；"薄化"指用原语接管
**布局 + 折叠 + 人话**，其业务动作保留，重排进 OperatorFlow 动线。

### 4.5 i18n

- 补齐运营区 + 运维区所有 `t()` 缺失 key（config/recipes/presets/jobs/dead-letter/backends/
  providers 视图内所有用户可见文案）。
- 三个新组显示名 + 新原语文案 + `failureReasons` 文案入 `zh` 表。
- 标识符类（ID/文件名/错误码/组件名）**不翻译**，但折叠进 `EngineeringDetails`。
- **验收**：中文模式下运营主区 + 运维区无英文残留（`EngineeringDetails` 内的标识符除外）。

### 4.6 布局修复

- config 右侧工作台挤压 → 由 `OperatorFlow` 响应式栅格接管（`min-width` + 窄屏单栏回退），
  不再出现单字符竖排。

## 5. 测试 / 验收

- `nav-config.test.ts` 扩展：三组覆盖所有 id 各一次；`i18n-nav.test.ts` 同步。
- `failureReasons` 单测：已知码映射 + 未知兜底。
- 新原语组件测试：渲染 + `EngineeringDetails` 默认折叠态 + `OperatorFlow` 动作禁用态。
- 手动验收：中文模式逐页 smoke（实机/截图），运营主区无黑话、动作可走通、布局不塌。
- `bun run check`（lint + typecheck + build）全绿。

## 6. 分期（writing-plans 种子）

- **P1** 原语（4 个）+ `failureReasons.ts` + 单测/组件测试。
- **P2** nav 三层拆分（group 重排 + 组显示名 i18n + `nav-config.test.ts`/`i18n-nav.test.ts`）。
- **P3** 运营区三页薄化（config 最重，recipes/presets 次之）。
- **P4** 运维区三页接 `ReadonlyOpsView` + `FailureReason`（jobs/dead-letter/backends+providers）。
- **P5** i18n 补齐 + 手动逐页验收 + `bun run check` 绿。

## 7. 风险 / gotchas

- **nav INVARIANT**：改 group 时保证 daily+folded 仍覆盖所有 id 恰好一次（有测试兜底）。
- **组显示名 i18n**：nav 组头经 i18n 渲染；漏翻会露英文组名。
- **SSR hydration**：既有 openGroups 读 localStorage 已放 `useEffect`+rAF（见 guided-nav 历史）；
  本次只改 nav **数据**（group 字段）不改渲染逻辑，风险低，但勿把新读值塞进渲染期。
- **config 体量**：`ConfigView` 逻辑重，薄化时保留 dry-run/publish/rollback 行为，只换壳与文案，
  避免回归。
- **failureReasons 覆盖**：字典按实机出现的 code 逐步补；未知码必须走兜底，不得再漏原始码到首屏。

## 8. 明确 out of scope

后端/schema/worker 改动、RBAC、workflow 工程本质重做、safety-gateway、video、moderation provider。
