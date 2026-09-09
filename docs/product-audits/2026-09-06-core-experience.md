# 核心体验实施报告 · 2026-09-06

状态：本轮工程实现、五角色媒体基线、独立视频与最后编辑回归已完成，测试会话及临时权益已清理。内容质量尚未整体通过，公开生产未认证。

仓库 `/Users/kk/code/idream`，分支 `codex/core-experience-20260906`，基础 HEAD `cbf0499728be84a19d8b9b9ca13b679ce16babe4`。主体媒体运行候选 `idream-worktree-4717c375dc62103afc17dd94e8fa11ad87427aec9b346d5a3dd0dae87b259a43`。已有导航、Today、Voice 工作保留并整合；起始差异在 `baseline-existing.patch`，没有提交或推送。

## 实际改动

| 范围 | 问题与结果 |
| --- | --- |
| Admin | 整合 Character 为中心的导航、Today 工作队列、角色声音来源与系统默认值；声音权威读取采用一致快照，预览与启用保持分开。 |
| Chat 记忆摘录 | 真实召回中 320 字符截断完整标签；改为每条最多 2,000 字符、最多六条，超长内容不截断末尾标识符，并明确需要完整检索。 |
| Chat 图片编辑 | “Edit the picture you just sent” 未被识别为编辑，只有文字确认；补齐明确已交付图片的引用表达；另修复“Do not change anything else. Make the edited picture now.”跨句误判为取消。真实否定/讨论仍不授权。 |
| Main 编辑要求 | 真实Mara样本中模型加入盘发/厨房等原图不存在的要求；新编辑改用Main冻结用户文本，经既有身份规范化。完整方向超预算在附件/扣费前拒绝；旧请求恢复/重播保留。 |
| Chat provider 归属 | JSON 工具兼容路径丢失实际请求编号；保留该真实响应的 request/provider，OpenRouter 两条路径都先校验上游归属。执行策略版本 5。 |
| Gen 缓存与诊断 | 参考图按内容 SHA-256 命名，稳定输入可复用缓存且不同字节不覆盖旧引用；分段耗时进入原有 terminal accounting，由 Main 持久化。 |
| Gen 用量归属 | 首写遗漏角色与用户分类，audit 被默认成 customer；改为使用 Main Job、用户分类和 Main 环境，保留原有会计幂等与历史事实。 |
| 产品指标 | 修复首次与持续物化读取旧值/空值；现有 event-consumer 启动及每 15 分钟刷新，一致快照、单次执行、失败可见。缺合格样本显示原因，不能签发经营结论。 |
| 验证基础 | 固定五个成年 realistic 角色及 Soul/Release/视觉/声音权威；正式 API、DSH、持久化、来源、账本和原键重播可重验；探针只清目标角色明确标记的 Probe 会话。 |

没有新增数据库 schema、第二套 Chat/记忆权威或额外计费写入路径。

## 运行与回归证据

- 最新 `check-attribution-final.log`：全仓检查/构建通过。Main 完整测试 399 文件、3,155 通过、3 跳过；此后 probe 38 项及 generation attribution 55 项定向回归通过。
- Admin 完整测试 185 文件、1,162 通过；Gen 25 文件、301 通过；最新 Chat 26 文件、217 通过，Shared 最终 52 文件、372 通过。详细各轮日志保留，未将旧失败改为通过。
- `chat-full-readiness-core-final.json`：完整 readiness 200/ok。`signed-chat-probe-core-final.json`：签名调用与实际对话通过；六个 Quality 会话在探针前后完全一致，见 `probe-quality-sessions-before.json` / `probe-quality-sessions-after.json`。
- 最后Main编辑权威增量：Main正式构建成功；3个测试文件39项通过，Main typecheck、涉及文件lint和独立driver类型检查通过；此前fixture缺metadata的初轮失败日志保留，修正fixture后重验，未放松产品断言。
- 最终代码候选 `idream-worktree-d6bf7670d1fcd6998ba037a686e81c817dd419bf94d04aded63b03b4e17433ad`：`check-negation-final.log` 的全仓 lint/typecheck/build、完整 Shared 372 项通过；PM2 wrapper 重启、`chat-full-readiness-negation-final.json` 200/ok、Lola 签名真实对话 `signed-chat-probe-negation-final.json` 成功。
- 5e7 中间候选首次 full readiness 曾发生模型首字超时，单次重查与签名对话通过；保留 `chat-full-readiness-edit-authority.json` 和 recheck，不将超时改写为成功。只读检查时生成队列为空、oMLX health 正常，根因未确认，未修改 provider/超时值。
- 当前仍是本机 PM2 开发运行，标记为 `non-certifying-source-watch`；这些证据不是不可变生产部署的批准。

## 实际生成优化

相同 RedCraft Krea2 identity-edit workflow v5、832×1216、8 steps、同一参考图，两个固定 seed 前后比较：

| seed | 改前 | 改后 | 画面差异 |
| --- | --- | --- | --- |
| 12401 | 304.090 秒 | 246.876 秒 | 解码后的像素完全一致 |
| 12402 | 273.845 秒 | 249.812 秒 | 解码后的像素完全一致 |

第二组观察快约 8.8%，样本少且有冷暖状态差异，不能声称普遍提速 8.8%。缓存历史证明稳定引用新增命中 LoadImage 和身份 patch 节点；PNG 元数据不同，像素相同。证据：`benchmark-summary.json`、`image-pixel-comparison.json`。

默认 Qwen Chat 图片的首个新遥测样本：总 182.281 秒，排队 78 毫秒，provider 执行 181.098 秒，包含装载。这个样本指向模型执行/装载；不能把 Main 显示 queued 的整段时间都计为排队。Krea2 对照不是当前默认 Qwen 的性能对照，两者范围分开。

## 五个角色与媒体

原始失败始终保留；独立媒体使用自己的 source 和 key，不将多个版本拼为完整体验。

| 角色 | 原始旅程 | 独立后续 |
| --- | --- | --- |
| Mara / navigator | 完整证据被模型回答改写：idreamrecall 多出一个 d；严格失败 | 独立图片、编辑、Fish 声音技术检查通过；原召回失败保留 |
| Mira / photographer | 召回与图片通过；编辑意图漏识别，无工具/无任务 | 复用原图，新版编辑、Pocket 声音技术检查通过 |
| Alexa / social | 召回通过，图片实际交付；兼容调用缺 request attribution | 复用原图，新版编辑、Pocket 声音技术检查通过；改图质量失败 |
| Leo / gardener | 4717 同一候选完整自动旅程通过 | 主观审阅仍有虚构时间、全图附带重绘问题 |
| Mira / creative | 4717 同一候选完整自动旅程通过 | 图文指代与画作题材衔接待评；见下方 2026-09-07 更正 |

视频是独立的 RedGraft LTX 2.5 正式产品任务：已固定源图和报价，121 帧/24 fps（5.0417 秒），768×1152，含生成音频；已完成 job `cmtqlf1lk002lzxl7bk4mxwjl`，完整解码、来源、实际唯一扣费 100 审计币和未登录下载 403 均通过。Main 总交付 806.836 秒，adapter 806.291 秒，provider 执行 805.261 秒（含装载），resourceWait 0.826 毫秒。此样本的瓶颈明确在执行/装载；provider 法币成本未知，不填零。逐秒五帧显示人物身份和镜头稳定、眨眼/微笑，头像构图未呈现完整阳台活动；不据此认证所有视频场景或音轨听感。

十张图片覆盖五次生成与五次编辑，每张通过 Main 交付、来源及实际账本检查；其中八张在 4717 执行，两张是 24fd 原图。严格跨会话精确标签五例四例通过，但两个完整自动旅程与三个独立媒体范围不能合并成“五个完整质量通过”。

| 角色 | 原图总耗时 | 编辑总耗时 | 声音时长 / provider |
| --- | --- | --- | --- |
| Mara | 83.813 秒 | 150.092 秒 | 55.135 秒 / Fish clone |
| 摄影师 Mira | 146.599 秒 | 258.207 秒 | 12.72 秒 / Pocket Alba |
| Alexa | 105.865 秒 | 136.338 秒 | 14.96 秒 / Pocket Alba |
| Leo | 101.311 秒 | 174.276 秒 | 18.4 秒 / Pocket 既有复制声 |
| 水彩老师 Mira | 83.419 秒 | 155.415 秒 | 17.52 秒 / Pocket Alba |

上述图片时间为 Main Job createdAt→completedAt，涵盖本次低并发受控执行，不是 SLA 或线上 p95。声音请求均一条成功用量事实，按既有/临时权益收费 0 币；回放返回同一资产。Fish 为 44.1kHz，Pocket 为 24kHz，均单声道 PCM。浏览器真实回访验证图片加载与 Pocket 播放状态；视频 Gallery 中的准确资产以静音模式完整播至 ended=true、5.041667秒、readyState=4。未完成全量音频听感审阅。

## 最后一次编辑定点回归

Main 在新编辑中固定用户指令后，5e7 的真实请求没有建立 Job：共享意图正则将“Do not change anything else.”跨句连到“Make the edited picture now.”，误判取消。原失败 `edit-authority-regression.json` 保持原状，Main terminal tools=[]、0附件/0任务/0扣费；不是超时的未知请求。

修正否定跨度并通过58项中英文定向测试后，d6bf 使用独立新 key、完全相同请求及绿色底图 `media_u649hylox1mmtql4zb2` 复验。沿用原来未花费的8审计币，不再补额。`edit-authority-negation-regression.json` 绑定旧失败SHA，实际 Main Job `cmtqn19to0009ycl7p3fwgwml` 已完成：用户指令、底图、d6bf执行源、持久化、audit用量、唯一8币扣费、同键重播及鉴权下载全通过。Main总交付221.029秒，provider执行219.767秒（含装载），实际设备锁等待0.959毫秒。输出 `media_22jve0dhu1ymtqn60d8` 在390px浏览器回访中准确加载，832×1024，文档宽度390无横向溢出。独立技术回归不能修复旧召回错误，也不将五个样本改标为完整质量通过。

已直接比较前后PNG：封面绿变红，脸、盘发、开衫、姿势、厨房/窗框和主构图基本保持；封面波纹图案消失，皮肤、发丝、手指和衣纹仍有重绘。Main指令修复通过，严格局部编辑质量仍不批准，独立观察见 `edit-negation-visual-review.json`。

驱动准备曾因从 package 目录解析到旧 PM2 CLI，读取带版本提示的 jlist 失败；固定到当前 PM2 CLI 后准备成功。该失败在模型提交前，日志保留，不是新的产品任务或额外扣费。

## 明确尚未通过的质量

2026-09-07 评阅更正：水彩场景中的 “I choose a rainy bookshop scene” 结合角色的 “I'll glaze … reflections” 可能是画作题材，并不直接声明人物身处书店。此前将明亮画室判为确定物理位置漂移的结论证据不足，降为图文指代待评。原始对话、图片和 source 报告保持不变；这不撤销摄影师雨天上下文丢失的独立证据。

- igrep 0.1.137 在没有用户撤回请求时生成错误撤回注释；官方 0.1.139 静态实现也未修复。完整证据、调用链和接受标准见 `IGREP_FORGET_FINDING.md`。摘录修复和即时召回答对不能证明长期记忆可靠。
- 模型仍可能改写精确事实、代用户决定动作；图片人物身份可相符，但天气、场景和物件细节有偏差。逐条观察见 `CONTENT_REVIEW.md`。
- 精准改图尚不可靠：Alexa 正确底图与明确保留提示下仍复制头像的服装、背景；Mara 的 Chat 编辑提示还主动加入了原图不存在的盘发、厨房，生成随之改变。Main冻结指令后的独立绿→红样本主要内容保持，但仍有封面纹样丢失及全图重绘；其余样本也有皮肤/衣纹附带重绘。详见 `social-edit-root-cause.md` 与 `CONTENT_REVIEW.md`。
- 五个英文 realistic 受控样本不代表中文、anime、长对话、跨日留存或真实客户吸引力。声音主观适配不能由下载/解码成功代替。
- 旧图片的 raw AiUsageFact customer/null 元数据保留；诊断用 Main Job/User 正确归类，只是只读归因，不能宣称历史原行已修复。

## 资源与清理

只使用受控 audit 用户和本地开发库，有限临时额度与权益有记录；没有充值、购买订阅、真实支付或公开发布。本轮共四笔受控审计赠额180币（原计划164、探针清理修复8、最后编辑回归8），其中已消费余额不反写。13个正式Gen任务总支出196币：五角色10张图片80、早期失败报告实际已交付图片8、默认视频100、最后独立编辑8；差额16来自水彩老师Mira审计账号的既有余额。五条声音按权益计0币。原5e7无工具失败不产生任务或费用。10个精确Quality会话经Main DELETE后GET404，并等待各自记忆重建结束；清理前报告快照保留，原失败状态未改。6项临时权益按原值/来源/到期信息CAS恢复，临时浏览器登录删除1。生成历史、用量和账本不删除，失败证据不覆盖。最终独立只读财务核对143项通过、0失败、0待完成：13个Gen任务/媒体/用量事实、5个Voice请求/媒体/用量事实全部保留，无本任务在途执行或记忆重建，余额seed/Leo/水彩Mira为0/0/114。见 `task-finance-final.json`。

## 后续工作

本轮建立了可重复的真实基线并修复确定性的工程故障；默认体验达到目标的工作仍未全部完成。下一步优先处理用户未撤回事实却被igrep误撤回的链路、精确事实与图文场景保真；精准编辑需要在同一底图/seed/规格下验证保护原图画布或限定编辑区域的配方，不能把换种子碰到成功算修复。继续补中文/anime/长对话和声音实际听感，再用受控试用取得真实跨日回访与成品采用反馈。图片/视频主要时间位于执行/装载，进一步优化应维持画质对照并补冷热、混合负载容量基线。

## 证据入口

本轮原始证据为本机文件；未提交或上传外部服务。

- [五角色产物画廊](/Users/kk/code/idream/.tmp/core-experience-20260906/REVIEW_GALLERY.md)、[内容观察](/Users/kk/code/idream/.tmp/core-experience-20260906/CONTENT_REVIEW.md)、[人物对话评分卡](/Users/kk/code/idream/.tmp/core-experience-20260906/CHARACTER_SCORECARD.md)。
- [视频正式运行](/Users/kk/code/idream/.tmp/core-experience-20260906/video-validation.json)、[浏览器播放结果](/Users/kk/code/idream/.tmp/core-experience-20260906/video-browser-review.json)。
- [igrep 错误撤回证据](/Users/kk/code/idream/.tmp/core-experience-20260906/IGREP_FORGET_FINDING.md)、[Alexa 编辑漂移根因](/Users/kk/code/idream/.tmp/core-experience-20260906/social-edit-root-cause.md)。
- [生成同条件对照](/Users/kk/code/idream/.tmp/core-experience-20260906/benchmark-summary.json)、[像素一致检查](/Users/kk/code/idream/.tmp/core-experience-20260906/image-pixel-comparison.json)。
- [清理前范围审计](/Users/kk/code/idream/.tmp/core-experience-20260906/ledger-closure-notes.md)。其中初始164币赠额只覆盖resource plan，完整本轮还包含两笔独立8币审计修复/回归调整，最终全任务财务核对另列。

- [最终定点编辑运行](/Users/kk/code/idream/.tmp/core-experience-20260906/edit-authority-negation-regression.json)、[视觉复核](/Users/kk/code/idream/.tmp/core-experience-20260906/edit-negation-visual-review.json)、[移动端真实加载](/Users/kk/code/idream/output/playwright/core-experience-20260906/edit-authority-fixed-mobile.png)。

- [最终全任务财务与清理](/Users/kk/code/idream/.tmp/core-experience-20260906/task-finance-final.json)、[清理前快照索引](/Users/kk/code/idream/.tmp/core-experience-20260906/pre-cleanup-snapshots.json)。

最终文档整理发生在d6bf运行验证之后。各实际媒体和失败继续使用原source；最后仅整理进度说明及报告，未重标历史证据。`final-runtime-code-hashes.json` 保留文档收尾前的运行源码摘要供核对。
