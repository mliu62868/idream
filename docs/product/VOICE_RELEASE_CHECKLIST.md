# 语音能力与发布检查

更新日期：2026-10-04

本文承载 [PRD](PRD.md) CH-07/14/15 与 CR-02/06 的声音要求。Chat/Turn见 [Chat契约](CHAT_SERVICE_PRD.md) 与 [ADR-21](../architecture/21-companion-chat-deep-runtime.md)，费用见 [经济契约](ECONOMY_AND_PRICING.md)，实际provider、设备/语言与发布资格见 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)。

## 1. 三种用户结果

| 能力 | 完成条件 | 计量边界 |
|---|---|---|
| Voice Clip / CH-07 | 对已完成角色回复明确Play，接受报价后听见该条回复，刷新可重播 | 固定selected reply attempt、声音和接受条款；优先计划分钟，再按clip兜底Dreamcoin |
| 麦克风输入 / CH-15 | 录音→可编辑转写草稿→明确Send | 转写不建Turn、memory或媒体，不消费币、消息额度或TTS分钟；Send后走普通Turn |
| 双向Voice Call / CH-14 | 接受预算与时长后能听说、静音、中断、断线恢复和结束 | Main持有Call/utterance与语音身份/结算；连接时间和生成音频时长分别记录，连接时间免费 |

三者分别验收。当前Call是English turn-based的录音→ASR→Chat→TTS；语言目录可用不代表已获Call或设备资格，也不代表双工流式音频已实现。

## 2. Voice Clip

1. 只朗读用户有权访问的Main已发送selected reply；session与精确reply attempt必需。客户端不能用自由文本借角色声音合成任意内容。
2. 新合成先报价，明确Play接受最高成本；免费用户可按币使用系统默认声音。计划权益决定分钟与角色声音资格，不能把所有Play都限制为订阅用户。
3. 普通文本完成不自动触发付费TTS。已有内部prewarm只用计划分钟，不消费币、不自动恢复paid Play授权。
4. 接受时固定回复、provider、voice/profile version、delivery和账务条款；重试、租约接管和运营默认变化不得替换它们，费用不超接受上限。
5. Main持久保存产物、交付与唯一usage/ledger fact后才播放；重复点击和刷新重播复用结果，不再次消费。
6. provider、编码/存储失败或响应丢失须有明确状态与恢复；仅在provider可安全重放时接管。旧owner、旧reply或跨账号迟到结果不覆盖新事实。
7. 消息内Play/loading/stop与错误/费用状态可用；余额、能力或权益不足由服务端给出准确恢复入口，已有合法交付仍可重播。

具体输入、single-flight、接受报价与provider恢复协议由 [Voice Clip实现](../../packages/main/src/server/modules/ourdream/voice-clip.ts) 与 [报价实现](../../packages/main/src/server/modules/ourdream/voice-clip-quote.ts) 承载，本文不维护第二套API字段表。

## 3. 角色声音身份

- Create与Admin可选择并试听可用catalog声音；有明确需求和provider能力时可用参考音频创建声音候选。语言、声音数和克隆能力来自实际runtime，不复制固定目录数量或模型路径。
- 候选、预览与激活分开。试听不改当前角色声音；明确激活后固定provider、voice/profile version与delivery，保留审计与回退边界。
- 多个角色复用一个catalog声音也应拥有各自durable身份；系统默认声音mapping与角色override分别有权威，不能因默认provider变化静默改写角色或旧Clip。
- 无角色profile时使用已审定的系统默认声音；不兼容/不可用的精确profile失败明确，不静默换声音。
- 角色tone与provider实际支持的delivery控制保持一致；不把未应用的情绪/采样控制宣称为已生效。

当前生产模板默认Pocket English，Fish可承担已配置的参考音频身份需求。实际支持、运行配置与固定依赖见 [Main生产模板](../../packages/main/.env.production.example)、[Voice provider实现](../../packages/main/src/server/providers/voice) 和运维入口；模板默认不等于目标环境已运行。

## 4. 麦克风草稿输入

- 单聊和群聊均支持最多60秒录音，转写后用户可编辑，明确Send才形成消息。
- 取消、切后台、录音中改草稿/收件人、账号切换与迟到权限/结果都不能自动发送；候选归属与发送对象明确。
- 录音设备、tracks、上传和在途请求及时释放；无语音、超限和转写失败给准确原因，不丢失可恢复草稿。
- 英语与已明确的欧洲目标语言逐语验证普通、噪声、真实耳语及关键意义。WER与人工意义/听感共同判断；真实设备和浏览器链路单独验收。
- Send前Turn、memory、资产和账本不变，Send后仅一个权威Turn与正常消息用量。

## 5. Voice Call

- 明确接受Call预算、时长和声音条款后连接，Main固定Call与utterance归属，用户能查看状态、已用额度/音频时长和结束原因。
- 同一用户的活跃Call和控制tab有唯一租约；静音、interrupt、断网与resume不能由旧tab抢占或重复提交utterance。
- 录音转写、Chat回复和TTS分别绑定精确Turn/attempt；只有已发送且未被替换的回复可成为通话声音。
- 停止、断开、超时、预算或时长到限时终止新接纳，处理中请求收敛；重连不把已经失败/取消的语音轮自动变成新付费请求。
- 结束后持久状态、实际连接/音频时长与唯一结算可刷新读取。连接时间不当TTS用量，生成失败不虚增交付；Call复用Clip账务不产生第二次消费。

具体Call状态、lease与恢复由 [Voice Call实现](../../packages/main/src/server/modules/chat/voice-call.ts) 承载。

## 6. 发布检查

| 检查 | 必须得到的证据 |
|---|---|
| 配置与运行 | 目标环境provider/语言/模型依赖固定，runtime健康、目录和精确声音可用；相关PM2进程ownership正确 |
| 身份闭环 | 创建候选→试听→明确激活→真实Clip/Call使用；默认切换和候选runtime故障不改旧请求声音 |
| Clip完整链 | quote→明确Play→真实合成→自然播放结束→刷新重播；分钟内、分钟耗尽和免费按币路径分别唯一计量 |
| 输入完整链 | 实际麦克风录音→转写→编辑/取消→Send；角色/草稿/账号变化、资源释放与不提前计量均验证 |
| Call完整链 | 真实听说→静音/interrupt→断网/resume→预算/时长边界→结束；旧lease、重复音频和失败恢复无重复消费 |
| 故障与语言 | 报价过期、权益变化、进程/存储失败、接管、迟到结果、逐语质量、真实设备与听感独立通过 |
| 发布门禁 | fresh voice-model probe与目标环境launch gate通过；仅开启feature flag不能授予发布资格 |

服务启停和模式切换使用 [README的PM2 wrapper](../../README.md)，安装、配置、依赖与复杂恢复按 [运维手册](../architecture/10-operations.md)。数据迁移/初始化遵循目标环境发布流程，不因改catalog重写已购offer。Pocket probe证明catalog→preset身份→合成→删除；配置Fish身份时另证明clone→合成→删除。

验证命令以根与Main的package.json为准：

```sh
bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json
bun run check:launch
```

每项记录所测source revision、用户/角色/selected reply attempt、ClipRequest或Call/utterance、实际provider/model/voice/profile、接受上限、时长、产物/交付与分钟/币前后差额。检查自然播放和刷新恢复，另判语言、内容、可懂度、角色声音与截断。recorded upload、有效文件、非零时长或单个English样本不能替代真人设备人声、真实耳语、多语或公开生产资格。
