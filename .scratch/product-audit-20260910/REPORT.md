# iDream 产品完整性与 Chrome 闭环审计

检查日期：2026-09-10 UTC（本地 2026-09-09 晚）。这是产品与受控环境验收报告，不是公开生产上线证书。

**当前结论：不能签发“功能全部完成、无遗漏、可公开上线运营”。** 单角色创建、聊天、图片、视频、语音和客服已有真实闭环，本轮发现的跨会话记忆失效已修复并通过真实新会话复验；完整 PRD 仍存在明确缺口，生产认证也未完成。

## 1. 范围与证据边界

- 产品范围逐项对照 [PRD](/Users/kk/code/idream/docs/product/PRD.md)、[功能覆盖表](/Users/kk/code/idream/docs/product/CURRENT_FUNCTIONAL_COVERAGE.md)、[剩余工作](/Users/kk/code/idream/docs/product/REMAINING_WORK_EXECUTION_PLAN.md) 与当前源码；完整映射见 [产品范围审计](/Users/kk/code/idream/.scratch/product-audit-20260910/product-scope.md)。
- 本次重新读取了 [OurDream 公开首页](https://ourdream.ai/)，确认仍公开提供 Buy Coins、Group Chats、Comics、Affiliate 入口及通话介绍。这证明公开产品范围，不代表本次登录其付费账户验证，也没有用历史预设数量冒充今日数据。
- 基线 HEAD：`9ce5e5da3362dc397eb73b7f72a621141740fd4b`。真实 Gen 的执行 revision 为 `idream-worktree-5484711258bb827314d857531144bfd205bb7a7e529ed6c1f221554496a3f33a`；各持久化报告另记录检查器自身 revision。开发模式的源代码更新与后续修复验证须分别记录，不能统称同一个不可变生产版本。
- Chrome 人工闭环使用 localhost:3000 Main、localhost:3001 Admin、真实 Chat/ComfyUI/Pocket TTS；开发库为 `idream_runtime_20260812`。另行执行的完整 Chrome Playwright 套件使用隔离数据库和 Redis，模型与生成 I/O 为 mock/fixture，不能替代真实媒体证据。
- 普通额度与生成请求属于此次验证；没有购买订阅、充值、转账、向公众发布角色或发布网站。运营 Release 发布只发生在隔离 E2E 测试环境，结束后清理。付费功能使用自有测试账号的临时手工权益，因此不证明真实支付到账。

## 2. 用户旅程实测

| 步骤 | 用户任务 | 本轮观察与状态 |
| --- | --- | --- |
| 1 | 年龄确认、注册、登录与返回原任务 | Chrome 完成两个受控账号注册，主账号重新登录后返回原 Generate URL；历史图片、余额、未完成视频保留，没有自动重提视频。入口按钮及离站链接对比度已修正；通过受控路径，账号验证的完整需求仍列事项 10。 |
| 2 | 创建角色、恢复草稿、选择身份、保存私有角色 | 完成五步创建 29 岁 Rowan，三张真实候选图生成后选定首张，保存私有角色并直接开始聊天。刷新恢复草稿有效。候选等待可达数分钟，提前选择入口已改清楚。 |
| 3 | 私聊、编辑、重新生成、持久化 | 两个角色真实回复；编辑同一用户消息后回复由原场景转为 sunset，重新生成产生新选定回复；刷新仍保留。手机 390px 长回复末尾及操作按钮可达。 |
| 4 | 跨会话长期记忆 | **已修复并真实复验通过。** 首次新会话回答从未告知，根因为记忆投影原文校验 400。修复后旧 outbox 自动补投成功；再创建新会话，仅问名称/位置，准确回答 Cedar/blue kitchen windowsill，wake 与 memory 各 1 次命中。 |
| 5 | 单条语音生成与重播 | Chrome 确认报价后生成 6.32 秒 Pocket TTS 音频；播放请求 201、媒体 206，第二次播放仍只有一个 usage fact、扣费 2 coins。未作完整听感或所有角色声音质量认证。 |
| 6 | 角色图片、原图编辑、2× 增强 | 真实绿色上衣/罗勒/温室图片交付；Image Edit 改蓝色上衣并保留人物、植物与温室主题；Enhance 尺寸严格翻倍，原图保留。每次均通过 Main 交付/终态/单次结算探针。不是像素级局部编辑认证。 |
| 7 | 默认单段视频、离页恢复与播放 | 5.04 秒 768×1152 视频完成，Chrome 播放到结束、无播放器错误，媒体 206；重登录后仍可查看，点赞及下载入口 200。端到端耗时约 14 分 35 秒，需继续优化等待体验和容量。 |
| 8 | Gallery / My AI / Profile | 新建角色与媒体可回访；Gallery 图像/视频切换、视频点赞、下载入口可用。通知深链加载后聚焦 Product updates，延迟加载回归通过。下载接口 200，未检查系统下载目录中的最终文件。 |
| 9 | 用户客服 → 运营回复 → 用户补充 → 解决 | 受控工单 `SUP-KBZ5FPBSLI` 走完双方回复与运营解决；重新加载后 3 条对话和 resolved 状态保持，已解决请求不再显示回复表单。通过真实本地写入路径。 |
| 10 | 其余公开页、账号恢复、社区、运营与异常恢复 | 原 173 项经完整首轮与定向修复复测全部取得通过证据；最后运营 9/9 连续通过，覆盖发布/回滚、客服/事件闭环、深链、409 重试、焦点与桌面/手机/平板键盘、axe 检查。此套件的 provider 为 mock/fixture，不等于全部真实外部服务验收。 |
| 11 | 真实购买、生产年龄服务、对象存储、监控、备份恢复 | 未签发。当前验证环境有 mock 支付/年龄/Blob；没有执行真实购买、生产公共回调或新生产恢复演练。 |

## 3. 实际 provider 与交付、扣费

主测试账号注册奖励 250 coins。本轮实际消费为语音 2、图片 8、视频 100、增强 5、编辑 8，共 123 coins；余额 127。创建预览三张为 0 coins。没有用退款或直接改余额抹平消费。

| 请求 | 实际执行 | 耗时 / 费用 | 权威证据 |
| --- | --- | --- | --- |
| 创建预览 ×3 | ComfyUI `redcraft-krea2-redmix3-txt2img`；profile `profile_image_default_v1` v3 | 128.55 / 108.66 / 101.95 秒；0 coins | draft `cmtutn0ie000bppl74idlrujg`；最终 character `cmtutwafg001dppl7sqersqp6`，选定 asset `media_3r3bx51g1thmtutra9d` |
| 普通聊天 | 自托管 `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit` | 第一条 Lola 长回复约 31.28 秒；Rowan 短回复更快 | Main Turn `3b25209e-4351-49b6-885c-2f7ec955f353`、`fdb92202-aed5-4ede-b817-361b815ff6ac` |
| 图片 Moment | ComfyUI `qwen-image-edit-img2img` v2；`chat-image-edit` v2 | 110.85 秒；8 coins | job `cmtuu1kg60024ppl7ui7t90k1`；[持久化探针](/Users/kk/code/idream/.tmp/product-audit-20260910/image-persistence.json) |
| 默认 Video | ComfyUI `redgraft-ltx25-i2v` v2；`profile_video_redgraft_ltx25_v1` v2 | 875.22 秒；100 coins | job `cmtuu8osg002wppl7r9p7j83r`、attempt `cmtuu8osw0032ppl7t0k0o67w`、asset `media_48mvau5ob9umtuurg42`；[持久化探针](/Users/kk/code/idream/.tmp/product-audit-20260910/video-persistence.json) |
| Enhance 2× | ComfyUI `realesrgan-x2plus-enhance` | 203.90 秒含排队，GPU usage 1.2 秒；5 coins | job `cmtuun5af003qppl7l61gaqkl`；832×1024 → 1664×2048；[持久化探针](/Users/kk/code/idream/.tmp/product-audit-20260910/enhance-persistence.json) |
| Image Edit | ComfyUI `qwen-image-edit-multi-reference` v3；`character-image-variation` v3 | 209.81 秒；8 coins | job `cmtuuybhb0046ppl7j768iu5l`；source `media_dijzb3l4qvhmtuu3xz1` → asset `media_vri2jah1y8mtuv2td7`；[持久化探针](/Users/kk/code/idream/.tmp/product-audit-20260910/edit-persistence.json) |
| Voice Clip | `pocket_tts` | 请求约 1.27 秒，音频 6.32 秒；2 coins | request `voice_clip_request_9e24fb1fc979f44ec1c5264cfeff5970ed8d15d75cc7922bf25d9734097ba782`；一次 usage，重播未再扣费 |

四份生成持久化探针均记录：attempt 1 成功、terminal receipt processed、outbox delivered，transport/artifact/delivery/media/settlement 各 1。完整受控原始快照见 [runtime-snapshot.json](/Users/kk/code/idream/.tmp/product-audit-20260910/runtime-snapshot.json)。这些是本地交付与账本证据，不包含云资源货币账单、峰值并发或所有模型质量证明。

## 4. 本轮缺陷与修复

| 问题 | 根因 / 修改 | 当前验证 |
| --- | --- | --- |
| 已受理生成在其他标签仍提示“请求中断” | hook 只增量读 storage，没消费另一标签的确认删除；现按原 owner/原 payload/原 key 精确删除，并覆盖账号重新确认期间的暂停状态 | 两条原失败回归及暂停边界先红后绿，相关 133 项测试通过；不删除存储不可用时仅保留于内存的请求。修复后以挂载回归验证跨标签事件，没有为同一场景再消费 GPU |
| 创建预览等待时不知道可直接选择现有候选 | 旧按钮只有 Pause checking；现有候选时显示 Choose a ready image，说明不再请求后续图、已排图继续 | 创建 mounted 与 preview flow 共 31 项通过 |
| 角色图片升级文案承诺了不存在的模型选择 | 角色 Moment 付费后仍 Auto；提示改为实际可用的 negative prompt 权益 | 定向 lint 通过；撤销临时权益后 Chrome 确认只提示 Negative prompts are a Premium control。不把文案修正当作模型控制已经实现 |
| 视频采样期间错误显示“正在渲染源图片” | 所有 video/running 都硬编码同一首帧文案；改为准确通用的 Generating video | GeneratorWorkspace 32 项通过；没有伪造精细阶段/进度 |
| Profile 通知深链偶发未聚焦 | 聚焦早于异步偏好完成，控件尚 disabled；改为值就绪后聚焦并清理定时器 | Chrome 实看加载后焦点为 Product updates；显式延迟响应的回归通过 |
| 共享角色创建/转公开的成功说明与发布状态不符 | 创建页仍以已退役 pending_review 判断，自动 approved 后落入通用保存提示；My AI 成功/空态仍提人工审核。现按服务端 visibility 区分私有使用与共享发布准备 | private/unlisted/public 挂载回归先复现后通过，Create 共 22 项通过；共享结果明确等待发布准备，私有保留直接打开，不把 approved 等同于已公开上线 |
| 跨会话记忆投影被拒绝 | 官方 igrep 的 dialogue 是带时间注释的视图，原文在 source_content；现验证严格注释插入形状及完整 Main 原文，保留维护改文拒绝；策略 8→9 | 56 项回归、真实 official ingest 回放及独立审查通过；原 outbox 第 13 次自动 delivered，canonical 保留 4 条准确原文；真实新会话已召回正确事实 |
| 运营端采用 Hero 图片后下一项生成永久禁用 | 无人工审批的请求省略 reviewDecisionId，读取投影为 null，严格比较导致成功回执永不清除；仅归一缺省 ID，保留素材/Run/Item 精确核对 | 挂载回归先红后绿，相关 57 项通过；隔离 Chrome 原完整角色图片包与 Release 发布链路复测通过（生成 provider 为 fixture） |
| 首次入口文字对比度不足 | 14px 白字对粉色渐变为 2.36–3.49:1，12px 离站文字为 3.19:1；只调整前景颜色，保留背景和行为 | Chrome computed styles 复核：主按钮各渐变端点/中点均 ≥5.13:1，离站为 6.68:1；截图与数值均保留，未扩大为整站合规声明 |

排除的误报也保留原因：长文本表单“丢失”来自 Chrome 工具 `fill` 对长字符串的 React 输入事件行为；测试手工写入 `plan: "deluxe"` 导致聊天列表 DTO 拒绝，按正式 `{slug,billingPeriod}` 格式修正 fixture 后恢复。这两项没有向产品加入多余兼容。

入口文字按 [W3C WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) 的普通文字 4.5:1 要求检查，计算基于浏览器报告的前景/背景颜色，不从压缩截图抽样推算。具体数据见 [age-entry-contrast.json](/Users/kk/code/idream/.tmp/product-audit-20260910/age-entry-contrast.json)。

## 5. 仍需完成的产品能力

本轮已按实际用户任务整理为 [9 个待办事项及已验收记忆修复记录](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/README.md)，每项附需求 ID、当前实现边界和真正退出条件。矩阵中全部“部分/缺失/外部前置”均映射到相应退出条件：

1. **P0：Chat → Generate 完整接续**。当前只带角色，未带源 Turn、Scene、冻结角色版本、视觉 brief 与当前图片。内嵌 Chat 图片已有另一条完整 pins 链，不能替代跨页面体验。
2. **P1：多角色与互动控制**。Group Chat、主动消息、完整版本化 conversation profiles 未实现。
3. **P1：聊天视频与双向通话**。Generate Video 和单条 Voice Clip 不等于这两项能力；通话发布费率/额度需要正式规则。
4. **P1：生成控制与供给**。seed、合格角色模型选择、批量深度、多 scene、时长/质量/声音配置等仍不完整；预设及创建 Catalog 需运行目录、声音试听和逐项语义等价证明。
5. **P1：独立 Coin Store**。缺一次性 coin offer、invoice、到账/撤销/退款闭环。现有余额、订阅赠币、兑换与邀请不是独立充值。
6. **P1：创作者作品、内容与经济系统**。Packs/Comics、等级、Studio、作品购买、收益与结算未完整实现；普通媒体合集不能替代购买权益。公开内容族的实际正文、Library/Hub、发现与索引供给也需逐项验收。
7. **P1：Affiliate**。缺商务资格、归因、佣金、撤销与结算；现有 referral 注册赠币只是子集。
8. **P0：公开生产认证**。确定生产环境与真实 provider 后，完成同版本运行、收款、对象存储、监控、恢复和容量验收。
9. **P0：账号验证与恢复契约**。当前一次性恢复码链可用，但不能据此认定验证码验证/重发需求已被正式替代；丢失密码且没有恢复码时的找回能力与失败边界须明确并完成。

其中正式商品、通话费率、创作者/联盟收益与生产连接资料是明确输入缺口；其余可独立研发的部分已经列入事项，不因外部前置而缩减 PRD。

## 6. 上线闸门与验证限制

最终构建后，于 02:13:58 UTC 再次执行 [上线门禁](/Users/kk/code/idream/.tmp/product-audit-20260910/launch-final.json)，仍为 **27 pass / 38 fail**，各检查的通过/失败状态与 01:10:41 的 [基线报告](/Users/kk/code/idream/.tmp/product-audit-20260910/launch-readiness.json) 一致。这不等于 38 个产品 bug：22 项是此次加载的开发配置不满足生产环境/域名/密钥/队列/Blob/Sentry 要求；15 项是缺失、过期或未绑定当前运行版本的探针/恢复证据；1 项是活动会话 Soul pin 的实际旧数据欠账（最终 44 active、1 null pin；另有 31 legacy pins，按当前规则并不阻断）。迁移链精确匹配当前 83 项。见 [逐项分类](/Users/kk/code/idream/.tmp/product-audit-20260910/launch-readiness-classification.md)。

该报告范围为 `LAUNCH_SCOPE=core`，显式不包含 Billing / Age Verification，不能拿它单独签发完整商业上线。既定 `MODERATION_PROVIDER=mock` 保持，不把启用 safety-gateway 列为缺口。

本轮没有证明：完整生产真实收款、公共年龄回调、长周期留存、峰值容量、跨设备完整一致性、全量角色/模型画质、所有声音听感、无障碍全面合规或“零 bug”。已有证据支持哪些路径，就只验收那些路径。

## 7. Chrome 截图

截图按用户旅程排列；创建等待图为修复前证据，记忆失败图为首次失败证据，不能误认作最终修复状态。手机截图只证明当前 390px 视口内动作可达，不代表全部设备或输入法组合。

1. 首次入口修正后：主按钮文字清晰、离站链接可读；确认仍有初始键盘焦点。原低对比度截图也保留于 `01-age-entry.jpg`。

![首次入口修正后](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/12-age-entry-readable.jpg)

2. 创建外观与身份输入。

![创建外观](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/02-create-appearance.jpg)

3. 真实候选生成等待，推动“选择已完成图片”入口改进。

![创建等待](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/03-create-wait.jpg)

4. 手机长回复末尾和操作按钮可达。

![手机聊天](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/06-chat-mobile-bottom.jpg)

5. 真实 Moment：绿色上衣、罗勒与温室。

![真实图片](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/05-generated-moment.jpg)

6. 客服双方跟进后解决并持久化。

![客服闭环](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/07-support-resolved.jpg)

7. 首次跨会话记忆失败现场。

![记忆失败现场](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/08-cross-session-memory-failure.jpg)

8. 视频交付并播放到结束。

![视频交付](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/09-video-delivered.jpg)

9. 原图编辑后上衣改蓝，人物、植物与温室主题保留。

![图片编辑结果](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/10-edited-image.jpg)

10. 修复后第三个自然会话，只询问名称与位置，准确召回原事实。

![跨会话记忆恢复](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/11-memory-recalled.jpg)

## 8. 收尾记录

真实记忆复验 Turn 为 `cde19570-b966-4ff5-9d06-66608fc745e6`，新 session 为 `d2bde3f5-4b42-4fca-bafe-9b7da1fb6acf`，真实模型请求 `chatcmpl-ca0ddbbc`；2026-09-10 01:52:40.965 → 01:52:44.504 UTC，Main 状态 sent，回复 “Cedar. He sits on the blue kitchen windowsill.”。当前运行实例 `36d11741-a3f1-43c0-ad86-fc7f4f3f8c84` 于 01:47:08.860 启动，开发 watch 自动加载源码修复；没有绕过 PM2 wrapper 手工重启，也没有把旧生产认证改签。恢复状态、原文检查和修复文件 SHA-256 见 [memory-live-recovery.json](/Users/kk/code/idream/.tmp/product-audit-20260910/memory-live-recovery.json)。

已于 01:54 UTC 核对开发库后撤销准确 6 项自有临时权益，剩余 0；客服测试账号改为 fixture。保留私有角色/媒体、Turn、已解决客服对话及账本作为受控证据，未改写历史指标事件，也未清理其他账号。记录见 [cleanup.json](/Users/kk/code/idream/.tmp/product-audit-20260910/cleanup.json)。

完整 Chrome 首轮为 146 passed、18 failed、1 flaky、8 did not run；将真实缺陷与已退役流程/旧 locator 的断言漂移分开处理后，原 173 项全部取得通过记录。最后运营 9 项一次连续通过。各轮初始失败截图与 traces 保留；第二轮因根任务并行构建删除共享 `.next` 目录而失效的阶段没有计为产品失败或通过。完整过程及命令见 [验证报告](/Users/kk/code/idream/.scratch/product-audit-20260910/verification-inventory.md:74)。

## 9. 后续实施状态（2026-09-11）

前 8 节保留审计当时的事实。本节记录 2026-09-10、09-11 两轮实施之后，第 5 节各项的当前状态；证据、ID 与命令见 [WORK.md](/Users/kk/code/idream/.scratch/product-improvements-20260910/WORK.md)。全部改动仍在未提交工作区，验证环境为受控 localhost 开发拓扑，不构成生产认证。

1. **Chat → Generate 接续**：已实现，Chat 与 Comic 来源授权统一，并固定版本与媒体 pin。09-10 真实无源图接续与原图接续均已交付；09-11 Chat 生图再次真实交付（`qwen-image-edit-img2img`，129.3 秒，8 币）。
2. **多角色与互动控制**：群聊已实现，两成员真实回复与持久化已验证。发现角色互相复述的质量问题，补提示词无效已撤回，需要产品确认上下文范围并做多样本 A/B。**主动消息只有设计，完整五档 Conversation Profile 未实现**，两者都缺产品输入。
3. **聊天视频与双向通话**：Chat video 已实现。09-11 首次真实请求在生成中遇到合盖休眠，结果变为 unknown，清扫器自动退款一次；随后经产品重试路径真实交付 5.04 秒、768×1152 视频（`redgraft-ltx25-i2v`，约 15.8 分钟，100 币）。原"下载视频"按钮直指返回 JSON 的接口，已修复。**Voice Call 未实现**，费率与额度规则待定。
4. **生成控制与供给**：seed、合格角色模型选择、报价失效与输入合并已实现；批量深度、多 scene、视频时长/质量/声音参数、预设与目录供给仍未完成。
5. **Coin Store**：版本化商品、Admin 发布、发票历史、未知提交恢复、provider 确认后一次入账已实现。09-11 修复了 provider 切换误判 `new_key`、换号竞态，以及过期后晚付的发票经核验 webhook 仍无法入账。**没有真实商品与定价，没有生产支付配置，Coin 退款/冲正与已消费币的处理规则未完成。**
6. **创作者作品、内容与经济**：Comic 草稿、审核、unlisted 阅读、remix 已实现，并在真实浏览器与生成链路中验证；经济系统、Packs、等级、作品购买、收益结算与公开内容供给仍未完成。
7. **Affiliate**：未实现，缺商务资格、归因、佣金、撤销与结算规则。
8. **公开生产认证**：未进行，缺目标环境与真实 provider 配置。
9. **账号验证与恢复**：邮箱验证码验证与找回、重发限流、枚举保护、会话撤销已实现并有集成测试。09-11 修复了"被冷却拒绝的请求仍占用小时额度"，并确认凭据按 userId 唯一读取、多条凭据时失败关闭。**真实邮件服务未配置、从未发送。** Better Auth `/api/auth/*` 挂载点损坏且无人使用，删除还是保留为 OAuth 载体需要决策。

同期运行事件：Next 16.2.1 开发运行时 `RangeError: Map maximum size exceeded` 复现 2 次，PM2 启动器均正确拉起；根因位于 React 开发构建的 async hooks 追踪，未修复。生成链路另修复了"worker stall 后请求永久停在 queued"，真实环境中被卡住的 remix 已据此恢复交付。

这是完整首轮加受影响路径定向回归的合并覆盖，**不是最终单一冻结 revision 上重跑全量 173 项**。所有 E2E 的派生数据库、精确 Redis prefix、运行目录和 3300–3303 端口均已清理；[最后清理证据](/Users/kk/code/idream/.tmp/product-audit-20260910/chrome-e2e-cleanup-a0910006.json) 为 ok=true。

全部 E2E 结束后，最终 `bun run check`（lint、typecheck、build）exit 0，通过；保留 20 条既有 lint warning，没有 error。日志见 [final-verified-check.log](/Users/kk/code/idream/.tmp/product-audit-20260910/final-verified-check.log)。相关挂载/单元回归分别覆盖记忆完整性、跨标签回执、创建预览/共享状态、生成页和运营采用；没有额外运行全仓数据库 coverage 或声称全量 CI 已重新签发。

代码基线、最终工作区 revision、完整修改 patch 与逐文件 SHA-256 记录于 [source-evidence.json](/Users/kk/code/idream/.tmp/product-audit-20260910/source-evidence.json)。真实 Gen 保留其执行时 revision，记忆修复保留其运行实例及源码摘要，各轮 Chrome 保留自身日志与状态；最终审计文档不把不同时间点的证据改写成同一次生产运行。
