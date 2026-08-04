# 结构债执行记录

Updated: 2026-08-04 · 基线 `3c6e88687` · 主实施 `1da17ffbd`

## 结论

原计划界定的本地代码、测试、数据库约束与认证浏览器复验已经实施；结构债台账已清零。剩余的是发布系统拥有的生产迁移，以及不属于本台账的项目级全新 Character generate → review → draft asset pack → QA → Release → serving 浏览器旅程。

这份文档保留计划、取舍和证据，避免把“源码完成”误写成“数据库与运行态已完成”。实现状态的 SSoT 仍是 `CURRENT_FUNCTIONAL_COVERAGE.md`，上线门禁仍是 `REMAINING_WORK_EXECUTION_PLAN.md`。

---

## §1 数据库与运行态门禁

### 1.1 dev 库：活跃身份键 CHECK 约束（已完成）

- 2026-08-04 在用户明确的一次性授权下，对 `postgresql://kk@localhost:5432/idream` 执行 `packages/main/prisma/manual/2026-08-03-invariant-collapse-check-constraints.sql`；事务以 `BEGIN → ALTER TABLE ×2 → COMMIT` 完成。
- 执行前四项存量违规查询均为 `0`；执行后 `admin_cases_active_key_identity` 与 `ops_incidents_terminal_releases_active_correlation_key` 均存在且 `convalidated = true`。
- 已删除被约束完全取代的四条离线扫描：`duplicate_active_case`、`active_case_missing_active_key`、`terminal_case_retains_active_key`、`terminal_incident_retains_active_correlation_key`。
- 对账改为检查两条 validated CHECK 与 Case `activeKey` 唯一索引；测试在事务内删除任一权威时必须 fail closed，并验证约束实际拒绝非法 Case/Incident。
- Main 测试库在 `db push` 后读取并执行同一 SQL 文件；schema-isolated 测试只替换目标 schema，不复制约束公式。

### 1.2 生产库

以下都由用户/发布系统执行，agent 只交付脚本：

| 项 | 文件 / migration | 顺序 |
|---|---|---|
| active identity CHECK | `packages/main/prisma/manual/2026-08-03-invariant-collapse-check-constraints.sql` | 先跑四项 preflight；两条约束 validated 后再激活新代码 |
| artifact 状态合并 | `db/sql/2026-08-02-generation-artifact-late-after-cancel-merge.sql` | 新代码激活前 |
| Voice / TerminalRecord schema | `20260801201500_voice_clip_authority`、`20260801203000_generation_terminal_record_authority` | `prisma migrate deploy` |
| 退役 `sd_cpp` runner | `db/sql/2026-08-03-generation-model-profile-runner-retire-sd-cpp.sql` | 无额外顺序 |

### 1.3 认证后的真实浏览器复验（已完成）

2026-08-03 使用应用内真实浏览器与本地开发登录态完成：

- `/generate` 创建取消探针 `cmse027yj0001mul7k46dn1g8`：页面先显示 queued，余额 `1000 → 995`；Admin v2 以精确 request/version/confirmation 取消后，页面投影 `Cancelled` 与 `Generation stopped.`，余额回到 `1000`，不再作为活动任务轮询；
- Today 把同一 `generation request cancel` 命令投影为最近解决、验证已通过；
- Alexa Character Workspace 实际打开详情、图片审核和 Release。审核 UI 明确把可见质量、身份一致性、Approve/Reject 与草稿采用分开；Release 显示当前线上版本及 `1/3` 图片资产包缺口，没有把 incomplete 伪装成 ready；
- Image Library、Creative Runs、Today 均完成真实数据加载；Image Library v2 列表、批量选择/归档入口可见；
- 浏览器发现并修复 Character 详情 Recent assets 的 LCP lazy-load warning，重载后首屏四张图片均为 `loading=eager`；Main/Admin 最终 console 为 `0 warning / 0 error`。

这轮没有制造新的 Character Release 来覆盖真实线上版本；现有 Alexa 权威链与未完成资产包被原样保留。浏览器证据来自应用内 Browser，不是源码检查、HTTP 探针或独立 Playwright 替代品。

---

## §2 结构债（已完成）

### 2.1 `ourdream/service.ts`

结果：`8842 → 7650` 行；非测试 ourdream 模块对 `./service` 的反向 import 台账为 `{}`。

- HTTP/JSON 与 query 原语进入 `server/lib/request-json.ts`、`request-query.ts`，有纯函数测试；
- feed item id 编解码进入 `feed-item-id.ts`，举报进入 `reports.ts`，原依赖环消失；
- 订阅/结算共享权威进入 `subscription-lifecycle.ts`、`offer-availability.ts` 与 `billing-checkout.ts`；
- 生成请求、角色、profile catalog/selection、quote contract 分别进入具名模块；
- 产品事件进入 `product-events.ts`；
- 文本审核与持久事件进入 `server/moderation/text-authority.ts`，Admin 与 Local Pipeline 共用同一中立权威；
- profile 选择改为单一 options Interface，目录范围用 `executable | public_text_to_image | public_image_edit` 判别联合表达，不再暴露两个可组合成非法状态的布尔参数；
- 共享随机 ID helper 使用 `randomUUID()`，名称与实现一致。

`architecture-boundaries.test.ts` 同时守依赖方向、反向 import 精确集合和公开读模型单实现。

### 2.2 其余大文件：按 deletion test 处理

| 文件 | 结果 | 判断 |
|---|---|---|
| `release-executor.ts` | `1927 → 1197` | validation 与 snapshot value 抽出后，执行器保留 Release/Serving 编排 |
| `run-create.ts` | `1779 → 1301` | profile/recipe/target/reference/bootstrap 解析进入 `run-create-authority.ts` |
| `CharacterWorkspace.tsx` | 保持 5641 | 可靠性 journal 已抽出；继续切 UI 状态只会把同一复杂度散到调用点 |
| `GeneratorWorkspace.tsx` | 保持约 3737 | 只抽可独立行为测试的状态接缝，不拆第二套 workspace authority |
| `CharacterAssetStudio.tsx` | 保持 3280 | 生产旅程状态是一个运营聚合，不按面板机械拆分 |
| `cases/service.ts` | 保持 1302 | Case lifecycle 是一个内聚 aggregate；删除文件不会删除复杂度 |

这不是以行数作为完成条件。只切能把知识收进更小 Interface 的模块；删除后只会把分支复制到 N 个调用点的文件保留。

### 2.3 Image Library v2 面

已进入 Admin v2 manifest 与统一响应/权限/幂等接缝：

- `GET /api/v2/admin/assets`
- `GET /api/v2/admin/assets/:id`
- `PATCH /api/v2/admin/assets/:id`
- `POST /api/v2/admin/assets/bulk/preflight`
- `POST /api/v2/admin/assets/bulk`

共享契约 SSoT 位于 `packages/shared/src/admin/contracts/assets.ts`；Admin 客户端与 Placements approved asset selector 已切 v2。真实数据库集成测试覆盖 list → detail → idempotent patch/replay → preflight → bulk archive，并验证 replay 不重复写 Audit。

---

## §3 测试装置（已完成）

### 3.1 Main truthful UI states

原 27 条正向源码字面量断言已替换为行为接缝测试。状态判断进入 `age-gate.ts`、`auth-nav-state.ts`、`feed-load-state.ts`、`optimistic-write-state.ts` 等纯函数；测试验证输入/输出，而不是变量名或组件源码文本。

四条负向全目录扫描继续保留，仍守“假数据不能进入任何渲染路径”，并保留扫描域自检。

### 3.2 Admin canonical lists

原正向 `toContain` 字面量断言已改为 query/empty-state 行为测试。Announcements query 与兼容列表 empty state 使用具名纯函数；负向目录扫描及 feature 数量自检保留。

### 3.3 Main 间歇性测试

- `inventory-provenance.integration.test.ts` 保留 20s 的用例级预算，不全局放大 `testTimeout`；
- `generation-transport-execution.integration.test.ts` 的 cancelled terminal fixture 补齐 `finishedAt`，消除跨测试状态导致的错误握手判定；
- 不把“单独重跑通过”当成全量通过；最终仍以全量 suite 的退出码为准。

### 3.4 最终验证

- 根级 `bun run test`：6/6 package tasks 成功，`454 passed files + 2 skipped files / 3,274 passed tests + 3 skipped tests`；
- 根级 `git diff --check && bun run check`：diff whitespace、lint、typecheck 与 production build 全部通过；
- production build 产出 Main `idream-c5c4ef04-20f8-4fff-ac3c-208ba25e3466`、Admin `idream-4022f2fe-128c-4b6d-ad35-04fc64a15852`，共同 build ID `build-TfctsWXpff2fKS`；
- 重启本地 Main/Admin PM2 开发进程后，`/generate` 与 `/admin/characters` 均返回 HTTP 200；浏览器证据见 §1.3。

---

## §4 明确不做

- 不改既定 moderation provider 取向；
- 不改 `CharacterTemplate` 数据模型；
- 不删除 `docs/design-references/ourdream-safety-docs.json`，只保证它不进入渲染路径；
- 不把未运行的 legacy `pipeline@8091` 检查写成 passing；
- 不把 V1.1 视频生成写成当前闭环。

---

## 下一步

1. 发布系统按 §1.2 执行生产迁移与脚本。

项目上线门禁（不计入本结构债台账）：生产部署后重新执行与 §1.3 同级的 production canary；本地证据不能替代生产证据。
