# Admin Chrome 端到端验收 · 2026-09-05

## 状态

受控本地 Chrome 核心闭环已通过：角色创建与18岁校验、无人工审核的素材采用、真实图片/视频/声音、异常恢复、三图预览、私密候选创建及撤回、草稿归档恢复、CMS、角色权限、普通Chat与失败重试。真实操作中新增发现的资源排队超时、自动结算后迟到产物、Creative批次恢复及发布Manifest残留审核要求已修复。最终检查、证据归档和重启后的只读持久化复核均已完成。

边界：外部文件上传受Chrome工具文件路径限制，未完成该入口的真实上传；公开发布/回滚、购买订阅/充值、客服外发消息和数据擦除未执行。19个额外运营入口仅验证读取、错误和布局；历史空队列由集成测试覆盖。以下不构成公开生产就绪签发。

## 环境与证据边界

真实 Chrome DevTools 浏览器；Admin 127.0.0.1:3001，Main localhost:3000。管理员和 support 使用独立会话；普通测试用户使用第三个隔离会话。
运行 PostgreSQL 为 localhost / idream_runtime_20260812，数据库证据脚本检查主机和库名。测试数据均为受控样本；本轮未公开发布角色或 CMS，没有充值、购买订阅或外发客服消息。

本轮开始由 PM2 wrapper 重启的8个产品服务声明 revision：`idream-worktree-7a195254b464e2a475b1d0e56661fb59586e6d685a9f62acd48190fc044ba5ec`。其后 Admin 修复通过开发模式 HMR 加载；该运行声明不能代表 HMR 后全部文件。进程清单见 runtime-processes.json，重启日志见 runtime-restart.log。末轮将另外记录应用文件摘要与运行边界。

## 已完成旅程

| 旅程 | Chrome 与持久化结果 |
| --- | --- |
| 旧审核入口 | `/admin/characters/review`重定向角色管理；日常导航无人工审核。举报和申诉入口保留。 |
| 空表单与创建 | 三个必填错误可见，焦点回到名字；填写成年28岁角色，跨步骤刷新恢复；保存201后直接进入素材并展开首图创作器。 |
| 首图生成与直接采用 | ComfyUI / redcraft-krea2-redmix3-txt2img真实生成153.2秒，浏览器检查图片；点击设为角色身份，头像、参考身份v1、草稿封面立即建立，无新增CreativeReviewDecision，未上线。 |
| 图片恢复 | 刷新进行中图片自动展开；收起仍有进度入口。轮询交付自动刷新图库与工作区，回归覆盖一次刷新且不额外POST。真实unknown状态修正为生成结果待确认，禁用重复生成并显示恢复入口。 |
| 图片搜索 | 无匹配有明确提示及清除搜索；清空返回已有真实图片；390px无整页横向溢出。全库201张分页覆盖来自后端集成测试，不冒充Chrome大库分页。 |
| Soul与声音 | Soul默认清晰表单、技术证据折叠。系统Pocket TTS / Alba试听6.72秒，audio自然结束、readyState4、error null。 |
| 视频读取 | 既有本地受控Rowan视频真实播放到5.041667秒结束，readyState4、error null。该资产生成属于此前记录，不计为本轮新视频请求。 |
| 私密草稿归档恢复 | Rowan归档后retired，再恢复inactive；Serving version1→3，currentReleaseId仍null。两次归档请求使用同一幂等键并返回同一个命令，未重复执行。 |
| 真实草稿预览 | E2E Admin Ops 0830的3/3素材通过Main签名快照渲染真实发现卡、详情、开场和聊天图；没有虚构QA轮数，无线上修改。 |
| 放弃待发布版本 | 通过真实prepare API准备私密候选（不是公开publish）；Chrome390px点击放弃待发布版本。Release approved/v1→withdrawn/v2，Serving仍inactive/v1且currentReleaseId null；今日工作显示该已解决记录。 |
| CMS编辑 | 创建noindex草稿；字段→JSON回显、JSON→字段回显，保存并刷新后内容保留为“温室运营笔记 · JSON 同步”。发布不足项显示友好字段、最少字符/章节，原始校验折叠；未发布。 |
| CMS只读 | 独立support账号可查看完整文章，字段只读，没有创建/编辑/保存/发布操作。 |
| Case可读性 | support查看既有关闭Case，13条支持请求/消息/解决证据可读，技术证据折叠；证据选择具名；没有发送消息或修改历史记录。 |
| 运营入口 | 今日工作、事故关联、生成任务真实请求/Attempt/transport/ledger、共享角色待准备入口能读取真实数据。历史共享角色队列为空；完整迁移恢复只由集成测试覆盖。 |
| 普通用户下游Chat | 新建独立受控账号并标记audit；打开既有unlisted Mira角色，创建会话、真实回复、刷新保留。Main Turn sent，1条使用额度事实，固定线上Release；18.05秒，模型Ornith-1.5-35B-A3B-Abliterated-MLX-4bit，1560输入/32输出tokens。 |
| 普通用户语音权限 | 免费用户点击回复语音，真实402并明确提示语音需要对应方案，无音频产物；未购买方案。Admin系统试听已单独成功。 |

## 实际标识

- Iris：`620030d5-bb6b-4a10-88c9-2e3041ed9de7`；创建request `0ac8f520-ff84-4f35-8b69-10f46c02658b`，幂等键`710f6ef1-7159-4738-86f8-bee1e522730e`。
- 首图Job `cmto6v0520006v3l7hwn80cuw`，Attempt `cmto6v05k0009v3l7ou3sah77`，Asset `media_w3cv1o1jnngmto6yacy`；预估5币，Admin实际不扣用户Dreamcoins。
- 身份hero Job `cmto7159c000ov3l70eyvcpnk`，Attempt `cmto7159u000rv3l78jtcw3vz`，Comfy prompt `41003306-72b3-486e-984e-1d751788ebdd`；预估7币。Gen300秒等待超时，Comfy331.959秒完成。事故`cmto77m5e0006tel7ak9g7edu`。
- Rowan：`501f68d9-41ef-4f8e-bc39-ea14a88ee142`；归档幂等键`bad213d3-377d-4475-bd9c-fd3a83eb86ec`，命令`cmto71ys6000vv3l7jcjoe740`。
- Withdraw样本：`2414a1d9-74a2-4125-bf7c-92be6368f572`；候选`cmto7by710011v3l7mfxpw91i`；prepare幂等键`7a4c47a6-920b-425d-b089-2acc82be97f9`。
- CMS：`/guides/chrome-admin-e2e-20260905`，draft/noindex。
- Customer audit user：`cmto7go8i001uv3l77l905w5w`；Session `13c1f069-5de5-47a7-a522-987e3f9b7171`；Turn `2925c1e9-cda0-4377-9bc9-de1ac7184100`；模型请求`chatcmpl-f9c30a01`。详情customer-records.json。

## 发现并修复

1. 身份建立后刷新丢失进行中的图片入口；完成后父图库未刷新。
2. 自动检查以外仍有日常“审核”指导残留、动态版本及生成状态翻译遗漏。
3. CMS只读空态误导、直接暴露Zod就绪文案。
4. 图片unknown被同时显示为运行中与生成失败；现按真实requestId/Attempt显示待确认并避免重复提交。
5. 实际身份图332秒超出300秒等待预算；新增独立图片等待配置GEN_IMAGE_TIMEOUT_MS，默认600秒，并恢复原产物，没有重新生成。
6. 恢复终态中的providerRequestIds数组被旧usage合同误拒绝；合同允许有效嵌套JSON，并继续拒绝非JSON数据。
7. Request已恢复成功但图库、发布候选和媒体运营仍按原unknown Attempt拒绝采用；共用严格的原产物恢复证据判定，保留原Attempt历史。
8. 视频在GPU锁外等待时显示正在生成和不可信剩余倒计时；改为任务处理中，保留已耗时和历史平均，明确资源等待可能延长总时长。
9. 素材提交状态暴露character_hero等内部术语；改为双语友好状态，提交和刷新前的锁写保持。

## 检查与限制

第一批Chrome修复后Admin全量183文件1130测试通过；lint、typecheck、standalone构建通过，releaseId `idream-10175639-7b4a-4fd1-9725-80af5eb31b08`。随后unknown展示修复另有定向测试与typecheck，最终检查待收尾。

截图使用工具inline返回并实际查看，不写受工具路径限制的截图文件。Chrome表单填充后有时只改变DOM值而未同步React，已通过真实按键与回显复核；不将自动化输入问题误记为产品数据丢失。

未执行公开发布/回滚；私密候选放弃与草稿恢复已执行。没有用旧媒体生成证明本轮新模型请求成功。没有将空历史迁移队列、mock或页面可点击冒充全链完成。Growth样本事实不足，不构成商业指标可决策或公开上线签发。

## 追加验收 · 10:05 UTC 后

- 原hero恢复成功：同Attempt保留unknown，Main通过已验证的恢复证据将Request置completed/v3；只有一个Attempt、一个delivered artifact。receipt `cmto7o21s00008ll7y3vtfoju`重复ingest被识别为duplicate；恢复命令`dcbee563-5acc-433e-8a7f-c2bf4c5500dd`；无退款、无第二次生成。原图SHA256 `ec2d1f6a771b6f7e610a607bd997af88f702c510f5cf3080aba5a741430cb0a1`。
- 第二次PM2 wrapper成功重启，8产品进程声明 `idream-worktree-c62710f7c31716a05576887c1761976e311ec99e34ae3043c5e3f47774dcb703`。这是新视频开始使用的运行版本；后续恢复来源校验/Creative未知状态修复仍在进行。
- 本轮新视频Job `cmto7v8sk0003r4l7pdckcrua`，Run `cmto7v8sf0001r4l7efagm6ab`，2026-09-05T10:05:01.124Z开始；ComfyUI / redgraft-ltx25-i2v，5秒，预估100币。Chrome生成中刷新后自动恢复同Run和真实进度，没有重发任务。
- 角色创建年龄17的Chrome校验失败，aria-invalid=true，明确提示18到120整数；没有保存任何未成年角色。
- Chat重新生成触发同Turn attempt2，额度事实仍1条。并发视频期间本轮重试发生`provider_first_token_timeout`，Main明确failed，Chrome显示可重试错误。不能将最初成功回复当成重试成功；等待资源恢复后再进行最低一次复验。
- Gen全量25文件287测试通过（gen-final-tests.log）。图片unknown UI变更后Admin183文件1131测试通过；后续Creative状态修改将另计最终检查。

## 追加验收 · 10:26 UTC

- 恢复素材 `media_unknown_1e0b1f08f709df0d8bef64770122a004` 已由Chrome真实选入Iris主视觉，刷新后保留，状态为符合发布要求。图片主肖像和主视觉均已具备，聊天位仍缺；发布页面正确阻止不完整素材包。
- 按产品契约三个展示位必须使用三个不同图片，未通过复用图片或伪造来源绕过约束。Chrome于10:23:15提交唯一聊天图请求：Job `cmto8ioyz000fr4l73zrvo4qz`，Attempt `cmto8iozr000ir4l7t4n9vie0`，Run `cmto8ioyt000dr4l7l4p0w1rt`，ComfyUI / redcraft-krea2-identity-edit，预估7币。
- 图和视频均等待共享GPU；锁持有者为另一任务“评估 DiffSynth 加速 LTX 2.5 INT4”的pid56023，09:53:27开始持锁，仍有真实模型对比执行。没有中断该任务，没有重复提交本轮请求。此前Chat首字超时发生在该共享GPU负载期间，不能仅凭时间关系断定唯一原因。
- 编辑词典期间曾发生一次HMR解析错误和自动轮询500，修正后真实reload恢复同图片Run，控制台无error，未重复POST；这是此次开发编辑产生的瞬时失败，记录而不掩盖。
- 恢复成功authority回归5文件46项通过，Main类型和定向lint通过；Admin全量183文件1132项通过，Shared52文件337项通过；视频等待文案12项mounted通过；双语保存/刷新锁写等4suite21项通过。
- Main standalone构建通过：`idream-7b7ef95c-600d-46b3-b37b-ff6956418917`。Gen构建通过；Admin最后词典变更后正在完成最终check。

## 追加验收 · 10:50 UTC

- Chrome确认运行中的普通图片/视频生成按钮原本仍可点击且会创建新Run，现按同角色/同用途pending或running禁用，并在提交函数再次拦截；查看历史已完成Run不能绕过，完成后恢复可生成；durable intent恢复入口保留。图/视频41项回归通过，Chrome两个按钮均disabled=true。
- 额外19个运营入口只读检查均加载成功、无控制台error、无整页横向溢出，见additional-surface-checks.json；这不代表已执行其中充值、退款、擦除、公开推荐等写入动作。
- 促销页中文兑换码表格原误用邀请表头（6列），实际行有8格。已按稳定scope选列，Chrome确认兑换码8列/8格、邀请6列/6格；en/zh mounted回归均通过。
- 增长诊断提示已简化为数据不可用及当前能做的事，保留D1/D7数值和导出不可用；旧pending_review过滤值仅展示为待发布准备，保留历史查询。
- 长期GPU等待发现实际期限错误：图片Attempt在10:33:15（10分钟），视频Attempt在10:40:01（35分钟）被Main reaper判unknown，此时两者尚在GPU锁外等待，worker仍活跃。Job仍queued，未生成第二Attempt。
- 另一任务完成三轮对比后释放GPU，本视频worker pid59221取得锁；10:47:08读Comfy8188队列确认prompt `e93cbb3d-4e58-43fa-a90c-5f2284a16947`实际running，图片仍在等视频。
- Main原位修复允许exactdispatch且从未记录provider ID/terminal receipt的unknown Attempt，接收原worker迟到成功的追加resolution evidence；不修改原Attempt或Transport。40项回归通过。Gen资源等待/实际执行期限拆分正在隔离副本实现，避免Bun watch编辑重启当前worker。

## 追加验收 · 11:03 UTC

- 新视频Comfy运行10:43:43.914→10:59:39.625，955.711秒，真实status success。Gen原worker完成并写入迟到终态，Main正确追加resolution证据。
- Chrome真实点击采用已恢复成功结果、填写操作原因与目标确认后POST200；command `870b2fcd-9593-4046-a2a1-a4f93db76a8f`，11:01:13.613完成。原Attempt仍unknown，Request completed/v3，refund0，deliveredCount1；资产`media_unknown_eed5b98b6c4ad0fdfa32891af2c68872`保持private。
- 视频图库无需手动刷新即显示新资产。Chrome实际播放5.041667秒自然ended，readyState4、error null，390px无横向溢出；截图已目视检查与原Rowan身份一致。详见video-playback.json。
- Iris聊天场景图已取得GPU，Comfy8189 prompt `dcf1ff06-9edc-4a18-af18-8619ca3d50d9`运行中；仍是原Attempt，未重试。
- 最终Admin全量采用maxWorkers=2控制测试资源竞争：184文件1137测试通过。此前静态扫描5秒超时未提高门槛，单独扫描3项通过；图片tab用例错误模拟响应已修fixture，59项相关回归通过。

## 追加验收 · 11:17 UTC

- Chat在GPU空闲后通过Chrome对同Turn重试，attempt3成功；模型请求chatcmpl-1ed87f08，1189输入/43输出tokens，11:07:39.375 Main sent。刷新后新回复保留，chat_daily_usage_facts仍只有1条；详customer-records.json。
- 原聊天图Comfy8189真实运行11:00:16.406→11:06:25.315，368.909秒成功。但Main已在11:03自动confirm_failed（unknown满30分钟），0实际退款。原图迟到被归档且无采用入口，已定位并在修复，尚未把它计为已交付。
- 资源等待补丁已从隔离副本应用：等待仅记录资源心跳，取得GPU并重新获Main授权后才启动provider计时与不可重放guard。Gen全量25文件294项、Shared52文件338项通过，两包typecheck及Genbuild通过。全并发首次两个计时用例超时，使用maxWorkers=2重跑全量通过，未放宽断言或timeout。新协议尚待真实Chrome复验。
- 迟到成功提示改为打开任务检查恢复资格，不再无依据断言产物已丢弃；12项回归通过。

## 最终版本复验 · 11:28 UTC

- Main/Admin最终lint/typecheck/build均通过；Main release idream-df892582-07f7-422f-b18c-b1ad3f60f8a8，Admin idream-3696f762-8cc0-4a9c-a284-e3afd39a6ec7。标准wrapper重启8服务到同一声明revision idream-worktree-4edb910b8de499a9ffe76c8ab85e0498439924e905003ae7c97f9fb5f88e47c2，详runtime-restart-final.log。
- 新Chrome Rowan主视觉Job cmtoauv6x0003z4l7o8eckhaf，Attempt cmtoauv7l0006z4l7cd6qedkj，Run item cmtoauv6u0002z4l7fyy4lf05；11:28:42.345创建，预估7币，Admin无实际扣款。为验证资源边界，通过正式lease协议注入90秒受控竞争（不是额外模型生成），11:28:40.792取得、11:30:10.796释放；详resource-contention.log。
- waiting快照：同一Attempt queued、startedAt=null、3条30秒间隔resource waiting心跳、零Transport/usage；Chrome刷新恢复同任务且生成按钮disabled，无整页横向溢出，详final-generation-waiting.json。
- 释放后11:30:11.808才写唯一running Transport并启动Attempt；Comfy8189 prompt 1ac29078-6123-438b-b624-61be0a5ed6e1实际执行，pending0；详final-generation-running.json。真实完成尚待核对。
- 原Iris图在新补偿命令尝试时被真实CreativeItem失败态保护拒绝，409 Generation completion cannot rewrite Creative item state，事务完整回滚。新补偿集成样本未建立实际CreativeItem，已补修这一遗漏，不把早先6条绿色测试当作真实下游已通过。

## 闭环结果 · 11:42 UTC

- Iris原聊天图经Chrome同一任务补偿采用200：command 75953a6f-8641-4000-81a4-88d074331c34，11:35:41.639 Request completed/v5、delivered1、refund0。原系统失败命令 c4ec6ed9-2d69-408f-9d29-d0a78b120f8e 和事件继续存在，新采用事件显式引用被补偿事实。原Attempt仍unknown，同Artifact cmtoa28oq0003wil7q7e3d9dj恢复active/valid/delivered，asset media_unknown_73ea9fa77601bc064eda8ba60bfe53ad。详iris-compensation-result.json。
- Creative下游失败投影也在同一事务补偿恢复；真实ContentProductionBatch+Item集成7项、来源fixture调用22项、状态权威守卫43项通过。普通completion仍不能改写failed item，收费已退款/人工决定/伪造命令/旧证据仍拒绝。未放宽状态守卫断言或超时。
- Rowan最终新图正常成功：Comfy实际390.14秒，11:36:43.956 Main completed/v3；Attempt succeeded，一次Transport、一次usage、一份交付，无Dreamcoin ledger。图库自动出现新图，按钮恢复可生成；Chrome目视检查成年Rowan身份、绿色衣服、咖啡馆场景，图片成功加载。详final-generation-completed.json。
- Iris通过Chrome选择恢复聊天图，三个不同资产全部current/releaseReady；三项reviewDecisionId均null。Main签名只读预览实际显示发现卡、详情、开场和聊天图。整页截图的离屏iframe先呈黑色，滚动到可见区域后真实渲染正常并目视确认，未以空黑截图冒充预览完成。详iris-three-slot-authority.json。
- 首次真实Iris候选准备409暴露Shared Manifest仍强制reviewDecisionId。现仅要求run/item/generationJob完整来源，历史reviewID可选；对应11项合同回归通过，缺失真实来源仍拒绝。使用同幂等键aa1f721b-b848-417b-8dfb-490bf69d547a重试prepare200，候选cmtobad4v000jz4l7fi2f3siz自动通过；无人工审核记录。
- Chrome点击放弃待发布版本后，候选withdrawn/v2，publishedAt=null；Iris Serving inactive/v1、currentReleaseId=null，素材包仍ready。创建到素材、真实生成、异常恢复、采用、预览、私密候选和撤回闭环完成。详iris-final-release.json。
- Admin最终全量184文件1138项，Gen25文件294项，Shared52文件338项通过。Main最终为相关集成与状态守卫复验；第一阶段全量结果及后续修正见FIXES.md，不能称为第二次全仓Main全量绿。lint保留既有warning，未作无关清理。

## 最终证据版本与收尾

- 8个产品进程通过标准wrapper重启后声明同一 source revision：`idream-worktree-962a30c6a796892fabc822830ad07b3ff87bde04cdad458c62f4216438e5c478`；进程均online、restart0。证据runtime-processes-final.json和runtime-restart-verified.log。
- 应用文件清单SHA256：`cee2c5c509d467742d3fc75c55da7741062a2eb71fc4691c95d3f1f4392748a2`，共2059个git-visible packages/scripts/根构建文件，见application-source-manifest.json。文档、测试证据及其他任务文件会改变全仓工作树摘要；不把运行声明冒充后续报告修改后的全仓hash。
- 最终Main check通过，构建release `idream-a01b4be8-5593-4ad3-8300-27fc18c938d1`。Admin check通过，最后补齐历史withdrawn中文“已放弃”后20项定向测试和构建再次通过，release `idream-6a0f427d-9d22-4dfd-888d-b2ba41beb373`。Gen294、Shared338、Admin1138全量日志与定向日志均已归档；无新增跳过或放宽验证。
- Chrome重启复核：Iris私密未上线、版本历史显示已放弃；Rowan图库包含两张图片；同Turn的Chat新回复保留；CMS重新打开编辑器，标题与引言准确保留。Iris/Rowan/Chat控制台没有error，390px页面无横向溢出。详final-browser-checks.json。
- 原视频、图片和Chat各自的真实生成证据绑定其执行当时的版本；最终共享契约和Creative补偿修改通过真实候选/恢复操作及定向测试验证，没有用最后一次重启假称所有模型请求重新执行。
- 测试样本留作复核，全部保持私密；没有公开发布、修改线上指针、购买或充值、外发消息、不可逆清理或生产数据库操作。
