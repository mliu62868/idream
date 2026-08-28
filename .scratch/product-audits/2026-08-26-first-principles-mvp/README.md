# iDream 第一性原理 MVP 审计

日期：2026-08-26  
范围：主站、Admin 角色运营、Chat、DSH Agent 运行边界  
证据边界：当前本地运行态 + 当前未提交工作树；不是公开生产环境结论

## 结论

iDream 的 MVP 不是“通用 AI 创作平台”，也不是“通用 Agent 平台”。它只需要稳定完成一个闭环：

```text
发现合适的角色
  -> 开始一段有角色连续性的陪伴聊天
  -> 在聊天内或生成页得到同一角色的成人图片
  -> 回到聊天继续关系
  -> 为持续聊天和生成付费
```

唯一一级产品对象是 **Character**。Soul、视觉身份、开场白、聊天记忆、生成资产、Release 和 Serving 都是这个角色在不同生命周期下的权威，不应在 UI 中变成彼此竞争的“产品模块”。

当前 Explore、角色详情、Chat、Generate、Create 和 My AI 共同构成已经存在的产品。**本轮不改变主站页面、导航或用户流程**；主站只作为 Admin 优化必须服务、且不能破坏的回归基线。用户随后明确授权单独修复 Chat / Agent 当前故障，因此运行时修复限定在 Chat Agent 的最终输出、native tool calling 和成人陪伴策略边界，不改主站 UI。

## 第一性原理产品边界

用户真正购买的是两件事：

1. **角色连续性**：她是谁、如何说话、记得什么，跨轮次不能随机漂移。
2. **角色视觉兑现**：用户要求照片时，系统能可靠调用图片工具，产出同一角色，而不是拒绝、假装已生成或暴露工具载荷。

因此 MVP 的核心指标应直接围绕这条闭环：角色详情到首条消息转化、首个有效回复、显式图片请求成功率、图片回到聊天后的继续对话率、7 日回访，以及聊天/生成收入。Feed、Community、复杂 Agent 能力和泛创作工具都不能比这些指标优先。

## 主站边界：保持现状

### 保留

- Explore：角色发现、筛选、搜索和高质量角色卡。
- 角色详情：Chat 与 Generate 两个主动作。
- Chat：历史会话、重新生成/编辑、记忆开关和聊天内图片。
- Generate：Character 模式、角色视觉身份 pin、异步任务、失败恢复、Gallery。
- Create / My AI：创建私有角色、编辑、管理和发布。
- Upgrade / dreamcoin：为持续聊天和生成收费。

### 本轮不做

- 不调整主站一级导航，不移动 Feed/Community，不删除或隐藏任何现有入口。
- 不修改 Explore、角色详情、Chat、Generate、Create、My AI、Profile、Feed 或 Community 的功能与流程。
- 不修改 Chat 会话列表、主站生成任务展示或用户角色创建器。
- 浏览器中观察到的主站问题只保留为独立证据，不进入 Admin 优化 backlog；需要处理时另开明确范围。

## Admin：只围绕角色生产任务组织

运营人员的核心工作不是管理“项目”，而是把一个角色从想法变成稳定可聊天、可生成、可上线的产品：

```text
创建角色
  -> 定稿 Soul 与开场白
  -> 固定视觉身份并完成核心图片位
  -> 预览和 QA
  -> Release
  -> Serving 后观察并修复
```

底层仍应保留生成、审核、草稿资产包、QA、Release、Serving 这些不同权威阶段。它们防止“审核通过”等同于“已经上线”，不是过度设计。

但当前 Admin 把角色工作区拆成 Overview、Soul、Visual identity、Images、Video、Voice、Launch preview、Release、Live monitoring 九个 tab，并同时显示五步 Production journey，形成两套导航。建议只改信息架构，不改后端权威：

1. **Overview**：状态、阻塞原因、唯一下一步。
2. **Character**：Soul、开场白、视觉身份。
3. **Media**：Images 为主，Video/Voice 作为条件能力；不要求每个角色都走完。
4. **Release**：预览、QA、审批、发布。
5. **Live**：当前 Serving、表现和需要修复的异常。

Admin 左侧导航默认只突出 Today、Characters、Character Review。Starters、Taxonomy、Creative Runs、Library、Placements 和技术运维页面保留给相应工作模式/权限，避免角色运营人员面对三十多个入口。技术标签（模型 profile、`chat-image-edit`、revision id）放进诊断抽屉，不作为主流程语言。

当前角色列表还混入明显的 audit/test/fixture 命名数据。此处只标记数据治理问题，不执行删除；应先标注 fixture/owner/visibility，再由运营决定隐藏或清理。

## Chat / Agent：已修复的最小运行边界

正确的 MVP 边界是：

```text
Chat 组装 PreparedTurn
  -> 单一 Companion Runtime 生成回复或发出工具意图
  -> Chat 执行工具和持久化
  -> 只提交一个用户可见的最终回复
```

`PreparedTurn`、pinned Soul、签名 BFF、SSE、终态 CAS、outbox、图片工具幂等和 no-memory 隔离都在保护真实一致性，应继续保持封装。DSH 是 Chat 内部的 runtime adapter；Admin 不增加 Agent 选择、Agent 工作流、Agent 插件市场、人格 DSL、通用工具编排或多 Agent 管理。

真实 Chat 界面观察到两个问题：

1. 明确成人图片请求被当前模型拒绝，产品定位没有兑现。
2. 普通“给我一张照片”请求把类似图片载荷的 JSON 当成文本发给用户，且没有图片附件。

代码原因与现象一致：runtime policy 没有明确成人请求属于正常陪伴路径；sidecar 又把每个执行步骤的 `assistant/chunk` 立即送进产品 SSE，并累计成最终消息。模型打印的前置拒绝或伪工具 JSON 因而会直接进入用户可见消息。

本轮最小修复：

- Runtime 只把最终 assistant candidate 送入 SSE 和终态提交；工具前 prose 不再跨产品边界。
- 若最终 candidate 仍是未执行的图片工具 JSON，sidecar 以稳定、可重试的 `unexecuted_tool_payload` 失败收口，不把 JSON 当聊天内容。
- OpenAI-compatible 请求在存在工具时显式发送 `tool_choice: "auto"`，不依赖不同 server 的默认值。
- runtime policy 明确角色与用户均为成人，不得仅因请求带有性/露骨内容而拒绝。
- 没有增加 planner、fallback Agent、模型路由层或新工具；Chat 仍只拥有生成新图和编辑上一张图两个角色图片工具。
- DSH 图片工具探针改用有权读取 `message_versions` 的 `chat_service` 请求连接；不为探针扩大 `chat_projector` 的最小权限。

真实验证中，成人文本 Chat -> Agent -> SSE -> 持久化 -> memory settle 全部通过，回复长度 1104，未命中拒答特征，清理成功。图片请求也已观察到真实 `generate_image_async` 调用和 Chat 工具 reservation；后续 Main 正确返回 `payment_required`，因为专用 audit 用户当前余额为 0。未获授权进行充值或账本调整，因此本轮不把付费图片生成/编辑链路声明为绿色。

## Soul：只优化 Admin authoring，主站行为保持不变

当前工作树把 Soul 收口为 schema v3，删除关系字段。这种产品简化合理，但本轮只允许优化 Admin 的 authoring 心智模型和页面，不以此改变主站聊天功能。

产品尚未上线，因此当前测试会话和 fixture 没有真实用户历史承诺，不值得长期保留 v0/v1/v2 运行兼容层。应把这次变化定义为一次明确的 pre-launch cutover，而不是历史兼容：

- v3 可以成为唯一 authoring 契约，Admin 不再暴露 relationship 字段、Badge 或阶段编辑流程。
- 现有测试角色、ContentVersion、Release、Session 与评测 fixture 一次性重建或迁移到 v3；不在每次读取时动态重编译历史。
- 若以后执行跨包切换，文档、Admin 展示、Shared compiler、Main Release、Chat PreparedTurn 和评测器必须在同一目标中对齐，并证明主站行为没有被破坏。
- 切换完成后删除不再需要的 v0/v1/v2 运行适配器；只有确实还需要导入旧测试数据的离线工具可以保留转换逻辑。
- 正式发布前重新生成最终角色 Release，并从这个发布点开始执行 immutable pin。

因此，Soul v3 本身不是 Admin 优化的阻塞项；本轮不借 Admin 重构之名修改 Main/Chat 运行语义。

## 优先级

### P0：只收口 Admin 角色工作流

1. 把角色工作区九个 tab 收口为 Overview / Character / Media / Release / Live；先做前端分组，不删除后端能力。
2. Overview 只给一个权威下一步，消除 Journey、状态卡和资产完成度互相矛盾的问题。
3. Media 以角色图片资产为主；Video/Voice 条件展示，Generic Creative Studio 不进入角色主流程。
4. 保留生产、审核、draft asset pack、QA、Release、Serving 的独立决策，审批不自动发布。
5. 所有 Admin 改动必须通过现有主站 Explore、详情、Chat、Generate、Create 回归，证明产品功能未变。

### P1：减少运营认知负担

1. Admin 默认导航只突出 Today / Characters / Review，其余按工作模式折叠。
2. 技术 revision、profile、workflow 与内部 route 名称收进诊断抽屉。
3. 建立角色 fixture/测试数据标记和可见性规则，不做未经确认的数据删除。
4. Soul v3 只在 Admin authoring 页面收口；跨包运行切换另立范围。

### 暂缓

- Group Chats、Packs、复杂 Community/Feed 排序。
- 多 Agent、Agent 模式选择、通用工具市场、可视化工作流。
- 关系等级、好感度 Badge、关系策略 DSL。
- 强制每个角色完成 Voice/Video。
- AI 会话自动命名和通用项目管理层。

## 不破坏主站的实施护栏

1. Admin 优化默认源码范围限定为 `packages/admin/**`；本轮 Chat / Agent 修复由用户另行明确授权，并保持主站 UI 不变。
2. 不删除或改名主站路由、API、导航、功能开关和用户数据语义。
3. Character 的 Release/Serving pin、资产审核和已发布 placement 不改变。
4. 每次 Admin 改动后，用同一角色回归主站：Explore -> 详情 -> Chat -> Generate -> Create/My AI。
5. 每次只改一个 Admin 工作问题，浏览器证明后再进入下一项；不在同一轮重做 Agent 或主站架构。

## 运行与测试证据

- 本地运行：Main `:3000`、Admin `:3001`、Chat `:3100`、Chat Agent `:3101` 进程存在；浏览器审计使用 1280×720 当前界面。
- Chat Agent engine + OpenAI adapter：31 个测试通过；Chat Agent typecheck 通过。
- Shared runtime policy：5 个测试通过；Shared typecheck 通过。
- Chat 图片工具 / PreparedTurn / prompt：31 个测试通过；Chat typecheck 通过。
- Main 内部 DSH 图片工具探针：7 个测试通过；Main typecheck 通过。
- 真实成人文本闭环：SSE start/delta/done、assistant sent、memory attempt 收敛、无拒答特征、清理全部通过。
- 真实图片工具链：Agent tool call 与 Chat reservation 已证实；Main 因 audit 余额 0 返回 `payment_required`，未执行充值，未声称生成完成。
- 没有修改任何主站组件、页面、路由、导航或用户流程；Main 的唯一源码变更是内部运营探针选择正确的只读审计连接。

## 截图索引

1. `01-explore.png`：Explore，核心角色发现链健康。
2. `02-character-detail.png`：角色详情，Chat/Generate 主动作健康。
3. `03-chat-list.png`：会话列表，全部空标题是明显失败。
4. `04-chat-session.png`：真实历史聊天，拒绝成人请求并泄露伪工具 JSON。
5. `05-generate.png`：Generate，Completed jobs 压过主动作。
6. `06-create.png`：Create，五步结构基本可用。
7. `07-admin-characters.png`：角色列表，任务卡方向正确但混有测试数据。
8. `08-admin-character-overview.png`：角色概览，下一步可见但存在双导航。
9. `09-admin-soul.png`：Soul，运行态仍显示旧 schema 与 v3 compiler 混合，说明一次性切换尚未收干净。
10. `10-admin-images.png`：Images，角色专用生产方向正确，技术术语仍偏多。
