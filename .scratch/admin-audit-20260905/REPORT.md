# Admin 产品与实现审计 · 2026-09-05

## 结论

Admin 已有合理的角色中心结构，创建、素材审核、身份采用、草稿、发布和线上版本之间的后端边界也成立。现在最需要的是补齐运营决策材料与失败恢复，再减少技术信息对日常操作的干扰；没有证据支持推倒重建或删除既有运营能力。

本轮共记录 9 项主要问题（P1 两项、P2 七项）。核心包括：已准备发布版本不能放弃；角色审核缺少完整材料；图片库超过 100 张会遗漏，归档后甚至假空；预览保留已废弃 QA 提示；只读 CMS 暴露可提交写操作；媒体进度存在两种相互矛盾的展示口径；废弃草稿及暂停角色的退出路径不完整。

这是分析和验证交付，未修改产品代码、服务配置或启停服务。不要将本报告理解为所有问题已修复，或公开生产验收通过。

## 第一性原理：Admin 应帮助谁完成什么

iDream 的定位是完整的 18+ AI 角色扮演／伴侣平台，覆盖角色发现、创建、聊天、图片／视频／声音、资产与分发、付费和支持。Admin 的价值是持续提供可信、可经营的角色与内容，并能处理用户和交付问题。

运营人员的核心问题只有六个：

1. 这个角色是谁，有什么吸引力，如何与用户互动？
2. 用户实际看到和听到什么，是否一致、质量是否合格？
3. 哪些是草稿，哪些已被用户看到，发布究竟改变什么？
4. 有问题时如何暂停、修正、恢复或回滚？
5. 哪些角色／内容值得继续投入，指标是否足以做决定？
6. 谁可以执行哪些动作，如何追溯结果？

因此建议保留现有「设定／素材／运营」三分组，以及跨工作区的今日工作、客户运营、增长、平台运营、系统工具。前台完整创建需求不能删减；内部运营向导无需机械复制前台的六步顺序。内部入口可以更短，但完整角色能力和版本边界必须保留。

简洁应体现在：默认只展示当前任务必需的信息、给一个明确下一步、所有状态都能解释和恢复。不能以隐藏报错、取消审核材料或合并不同权威动作来换取按钮更少。

## 证据基线与范围

- 起始 HEAD：`bae20386f636bfb59389829d8574063f5339263d`，起始工作树干净。
- 起始 source revision：`idream-worktree-a18c8344ca374deb6c1b957a25206cc6760d10aa0d20275e6917235c1d8a348c`。
- PM2 Main、Admin、Chat、Gen 和辅助 worker 声明相同 revision；Admin 3001 实际 listener 为 PID 78300，Next 16.2.1。它们只是运行身份证据，不是 readiness 认证。
- 运行数据库：本机 `localhost:5433/idream_runtime_20260812`；标准集成测试使用独立 `idream_test` 与 Redis DB 15，BullMQ 前缀按测试库隔离。
- 审计产物与另一任务的研究文档随后成为 untracked 文件。source-revision 脚本包含非忽略未跟踪文件，所以后续整体 hash 改变。不得把运行进程改标为包含本报告的 revision；产品代码是否变化以最终 git diff 核对。
- 阅读产品 PRD、当前覆盖、剩余计划、Admin 导航与权限、角色前后端、Main 预览渲染器和相关测试；静态审核全部工作区，真实浏览器覆盖七类工作区的代表入口。
- 当前范围没有执行支付、公开内容发布、生产部署或既有运营记录的修改。

## 主要发现

### F1 · P1：待发布候选无法放弃，存在恢复死路

发布按钮先 prepare，再提交 durable publish。第一步已提交但第二步中断后会留下 approved 候选。approved 只允许进入 published，不能撤回／替换；它同时锁住图片和参考集修改。

证据：

- `packages/admin/src/features/characters/ReleasePanel.tsx:331`：两个独立请求。
- `packages/main/src/server/modules/admin-v2/shared/state-transition-authority.ts:49`：approved 唯一出口 published。
- `packages/main/src/server/modules/admin-v2/characters/release-lifecycle.ts:140`：拒绝另一待发布版本。
- `packages/main/src/server/modules/admin-v2/characters/asset-studio.ts:111`：禁止换图。
- `packages/main/src/server/modules/admin-v2/characters/reference-set.ts:60`：提示 Withdraw，但没有对应操作。

专用测试库实际调用上述服务，换图、替代候选、withdrawn、superseded、换参考集全部 409；事务最后回滚。详见 `release-recovery-probe.log`。

影响：并非所有发布都会失败；正常候选可继续发布。但发现候选错误，或其固定依赖失效且不能恢复时，运营没有可用的替代路径。

建议：增加有审计的「放弃待发布版本」，保留不可变历史，再允许修正和准备新版本。验收 prepare 成功 → publish 失败 → 放弃 → 修正 → 新版本发布。

### F2 · P1：角色审核的决策材料不足

审核队列只提供名称、性别、风格、截断简介、举报数和日期，直接提供通过／拒绝。没有可打开的完整角色、图片、年龄、Soul 与举报正文。确认窗口也没有补齐这些依据。

证据：`packages/admin/src/components/admin/ReviewQueueView.tsx:252`、`:435`、`:582`；Main `packages/main/src/server/modules/admin-v2/content/review.ts:35` 的投影也没有完整资料。当前运行队列为空，因此完整行的缺陷来自源码，不能冒充本轮在真实待审核行上完成了审核。

建议：先展示可展开的角色与举报详情，再选择决策；图片、成年人资料与实际用户可见内容应就近出现。保留既定内容配置，不增加新的审核政策讨论。

### F3 · P2：角色图片库遗漏旧素材，并会出现假空库

`packages/main/src/server/modules/admin-v2/characters/image-sources.ts:112` 先取最新 100 张，再过滤 archived。列表契约无 cursor；图片库与展示位选图共用接口。

专用测试库实证：101 张可用图片只返回 100；归档最新 100 后仍有一张可用图，却返回 0。详见 `library-limit-probe.log`，fixture 全部回滚。

影响：长期运营后无法找到或选择旧优质素材，用户看到「没有图片」却不知是查询截断。

建议：先在数据库过滤归档，再采用游标分页；搜索也应覆盖整个库，不能仅筛当前 100 张。

### F4 · P2：上线预览仍展示不存在的五轮 QA 要求

真实浏览器中 Mira 的 Live／Draft 预览各出现五个占位回合，写着必须补响应证据后才能发布；但发布页可进入发布动作，现有简化发布已移除 CharacterQaRun。

证据：`packages/main/src/app/internal-preview/characters/[token]/page.tsx:41`–`:52` 硬编码五轮；`packages/main/src/server/modules/admin-v2/characters/simplified-release.test.ts` 明确确认旧 QA 存储／流程退役。

影响：运营无法判断这是待办、错误还是演示内容，也无法在该面板完成所谓的证据提交。

建议：预览展示真实卡片、详情、开场和聊天图片；取消失效占位要求。若需要真实试聊，单独提供受控试聊和明确结果，不能把占位内容当作行为验证。

### F5 · P2：只读 CMS 表单让用户填完才被拒绝

真实用 seed-support-user 登录 CMS，填写页面路径、标题、正文和原因后「创建草稿」可点击；提交后得到 `Missing admin permission`，没有创建页面。

证据：`packages/admin/src/components/admin/nav-config.tsx:241` 只要求 content.read；`CmsView` 不接收写权限；Main `packages/main/src/server/modules/admin-v2/cms/pages.ts:138` 要求 content.cms.write。

建议：只读人员看到浏览面与明确只读提示，写按钮按能力显示；所有拒绝返回可理解的中文原因。后端权限正确有效，不将此问题定性为权限绕过。

### F6 · P2：同一视频同时显示运行中与排队中

本轮实际视频在创作器显示「正在生成视频」，同页「最近媒体生产」仍显示「排队中」。数据库 GenerationAttempt／Transport 为 running，GenerationJob 为 queued。

刷新页面后创作器默认关闭，首先看到「还没有视频／生成视频」；重新打开创作器才恢复原任务进度，没有额外创建 Job。应在有进行中任务时显示显著的继续查看入口。

证据：`packages/main/src/server/modules/admin-v2/characters/character-media-operations.ts:270` 直接输出 job.status；`packages/admin/src/features/characters/CharacterMediaOperationsCard.tsx:106` 用其显示摘要。视频创作器另用执行状态。

建议：共同采用一个明确的用户可见状态投影；若同时显示请求与执行阶段，应给出不同标签，不能让两个同名状态相互冲突。验证 queued → running → completed 在视频页、最近生产和刷新后保持一致。

### F7 · P2：创建完成后缺少显著的下一步

创建确认页说下一步是建立肖像，但成功后进入概览，主要内容是资料、计数、标签与聊天工具；没有主按钮引导创建首张身份肖像。只有最近素材旁的小「查看全部」链接和素材分组。

证据：本轮完整创建浏览器旅程；`packages/main/src/server/modules/admin-v2/characters/creation.ts:121` 返回默认工作区链接；`packages/admin/src/features/characters/CharacterOverview.tsx:187` 的入口是 View all。

建议：创建成功直接打开首张肖像任务，或在概览给出一个明确的主要按钮。其余工作区不需要增加一层流程页。

### F8 · P2：技术材料仍挤占日常运营界面

角色 Soul 页默认露出 schema、compiler、tokens、完整 fingerprint，并同时展开两份近乎相同的 SOUL.md／compiled prompt。图片审核后的主按钮仍是 `Set as identity anchor`，执行中出现多条英文恢复文案。Case 的证据区域主要是内部 ID；CMS 直接要求编辑 JSON。

证据：`packages/admin/src/features/characters/CharacterSoulPanel.tsx:114`、`:128`、`:274`；本轮浏览器 Soul、图片审核、Case、CMS 页面。

建议：日常界面只保留设定、当前版本、未发布变化和动作；编译结果与标识折叠到技术详情。把主按钮统一为清晰中文；Case 显示可阅读的来源证据并支持选择，CMS 提供字段编辑。无需为此删除高级能力或版本追溯。

### F9 · P2：废弃草稿和暂停角色缺少直接退出路径

角色工作区仅在 live 时显示退休；executor 也要求当前存在 published Release 且 serving 为 live。因此暂停角色必须先恢复上线才能退休，未发布的 private/inactive 草稿无法正常归档。

证据：`packages/admin/src/features/characters/ReleasePanel.tsx:655`；`packages/main/src/server/modules/admin-v2/characters/release-executor.ts:625`、`:633`。状态机虽声明 inactive/paused → retired，但实际执行并不支持。通用 content 状态接口拒绝官方角色，违规下架不能作为正常废弃的替代流程。本轮未发布角色展开「回滚与线上操作」也只有禁用的历史回滚。

建议：提供明确的草稿归档／恢复，以及暂停后直接退休；保持既有历史、素材引用和审计约束，不让用户为了下线先上线。

本轮样本因此保持私有停用，待生成完成后保留依赖素材与证据；没有绕过产品接口手改 deletedAt、Serving 或 activeKey，也没有声称已归档。

## 正确实现，应保留

- 角色是常驻主入口；低频工具放工作区菜单下，没有默认铺开所有后台功能。
- 三步创建只创建 private/draft/inactive；空字段会逐项提示并定位首个错误；刷新恢复输入。
- 创建幂等、原子持久化、原始请求键恢复及版本锁有实质后端实现。
- 图片生成 → 人工审核 → 身份采用是不同动作；审核不自动发布。
- 设定编辑生成新内容版本，不覆盖历史版本；本轮 v1 与 v2 开场均保留。
- 三个展示位要求不同合格图片；本轮缺图时明确提示补素材，无资格图片不会出现在选图列表。
- Live／Draft 使用 Main 的真实卡片和详情组件及签名快照；草稿不会隐式改变线上版本。
- 视频具备持续更新与耗时显示，系统继承声音可直接试听。
- 390px 图片工作区实测无横向溢出；字段错误有焦点定位，页签方向键切换正常。

## 验证记录

| 范围 | 本轮证据 | 边界 |
| --- | --- | --- |
| Admin 自动验证 | 183 文件／1116 测试通过；typecheck 通过；lint 0 error／8 warnings | 部分测试有 happy-dom teardown AbortError 日志，未计失败；不代替真实网络 |
| 角色后端 | Main 45 文件／267 测试通过 | 独立测试 DB，provider 为测试配置 |
| 角色外运营后端 | Main cms/content/cases/incidents/support 30 文件／187 测试通过 | 标准隔离测试，一次运行，58.71秒 |
| 发布恢复 | 五个真实服务调用返回 409 | 最小 fixture；未重演生产故障 |
| 图片库容量 | 101→100、归档100后剩1→0 | 真实查询，事务全部回滚 |
| 全局运营 | Today、审核、运营素材、Case、Growth、Incident、Approvals 真实加载 | 未替真实人员审批、回复、收费或公开发布 |
| 受控角色创建 | `501f68d9-41ef-4f8e-bc39-ea14a88ee142`，private/draft/inactive | 仅本地测试样本 |
| 设定维护 | v1→v2，修改开场，刷新恢复与数据库核对 | 没有发布新版本 |
| 图片 | Job `cmto3qnou000og6l7qsadk6h9`，1 attempt，ComfyUI／Krea 2 RedMix3，512×640，约88秒 | 审核85分为本样本人工判断，不是模型总体质量认证 |
| 图片身份 | 审核后另行采用，形成 visual v1 与一个 reference | 保持未上线 |
| 成本 | 图片估算5梦币；Admin生产实际客户账本扣款0 | 这是运营成本估算，不是供应商现金成本，也非漏扣费 |
| 声音 | Pocket TTS／Alba，7.2秒系统试听，浏览器 audio readyState4 且可播放 | 没有进行 Fish 克隆、声音发布或 Chat Voice Clip 计费链 |
| 视频 | Job `cmto3wvg60018g6l78rd26elg`，RedGraft LTX2.5，1 attempt，约17分7秒，5.04秒MP4，刷新后可播放 | 估算100梦币，实际客户扣款0；不等于全模型质量认证 |
| CMS 权限 | support 实际提交→Missing admin permission | 预期拒绝，没有创建 CMS 记录 |
| 浏览器控制台 | 角色创建/素材/声音无 error；预览2条LCP优化 warning | CMS权限拒绝单独记录，不与意外错误混算 |

Impeccable 静态检测器本轮结果为 `[]`；它没有发现上述产品流程问题，因此不能把检测器无输出理解为可用性全部通过。未做全站 WCAG 认证、性能基准或生产构建；不凭静态 tokens 或一次窄屏截图给全后台虚假的合规分数。

当前 Growth 页明确显示 15/15 指标不可用于决策，主要因为源事实为空或权威不可用。它诚实地显示降级，但本地样本不能支持「运营指标已能指导经营」的结论。历史真实发布、Chat 和模型验收记录仍是历史证据，不改标为本轮执行。

## 最小改进顺序与验收

1. 先补发布候选的放弃恢复路径、角色审核详情、图片库分页与归档过滤，以及草稿／暂停角色的退出路径。
2. 再统一只读权限和媒体状态，清除错误 QA 提示。
3. 最后收敛创建成功后的下一步、Soul 技术详情与中文动作文案。

完成标准：一个新运营人员无需知道 Project、Run、hash 或内部 evidence ID，就能创建角色、获得并筛选素材、确认真实展示、发布明确变化、处理失败并回到可编辑状态。低频专家能力仍可找到。

## 后续结果补录

Admin + Main 所列范围共 1,570 项测试通过（1116 + 267 + 187，前序34项纯测试是子集，不重复计数）。

视频终态：

- 08:14:18.678Z 创建，08:31:25.738Z 完成交付，总计约 1027.06 秒。
- Provider：ComfyUI；workflow `redgraft-ltx25-i2v` v2；profile `profile_video_redgraft_ltx25_v1` v2。
- Attempt `cmto3wvgq001bg6l7ibv4p56f`，attemptNo=1；provider request `3c85df61-f6eb-461e-9b9b-11c4a41942bb`，transport succeeded。
- Asset `media_ruh96f3a52bmto4ivxf`；唯一 delivery `generation_delivery_df179f5fe75e04d7807262c51f2d5ebe` 为 delivered。
- ffprobe：H.264＋AAC，768×1152，24fps，121帧，5.041667秒，1,209,137字节。文件 SHA-256 `272eebe9ddfe4595501dd5962e85ba6d158c38df8641ad8a00747d32e82f9e9f`。
- 浏览器完整播放至 ended=true，currentTime=5.041667；刷新后仍在素材库，控制台无 error。五张抽样帧可见同一人物自然表情变化，没有观察到明显多脸或大幅构图跳变；这只是单样本抽检。
- 原始状态见 `video-records.json`，容器证据见 `video-ffprobe.json`，抽样见 `video-sample-frames.jpg`。

最终运行库核对见 `runtime-records.json`：恰好两个生成 Job（一图一视频），各一个 succeeded attempt，均唯一交付；相关用户扣款账本为0。角色仍 private/draft/inactive，无线上 Release；两版不同开场内容都保留。没有遗留本轮活跃生成请求。官方草稿归档入口缺失，因此保留这个可识别样本及其依赖素材，没有将其公开或破坏审计链。CMS 权限测试没有新记录，隔离缺陷探针的 fixture 已回滚。

最终 `git diff --check` 通过，tracked 产品代码 diff 为空；仅本轮 `.scratch/admin-audit-20260905/` 与另一任务研究文档为 untracked。没有重启服务或执行构建。本轮没有走完整公开发布→普通用户 Chat→暂停／回滚的真实浏览器写入链，也没有做 Fish 克隆、支付或生产就绪认证；这些边界不能被上述测试通过替代。
