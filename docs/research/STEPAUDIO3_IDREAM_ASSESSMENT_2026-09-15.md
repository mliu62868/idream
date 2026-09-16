# StepAudio 3 与 iDream 适配评估

核查日期：2026-09-15。以下基于当日实时官方文档、官方组织模型/仓库目录；没有进行模型 API 或音质实测。搜索引擎缓存仍可能显示 2.5，应以实时页面为准。

## 一手资料结论

StepAudio 3 已有开放平台 API 文档。适合纳入技术候选，但当前托管服务条款与 iDream 明确的成人色情角色扮演业务不匹配，不能仅凭音质宣传切换主链路。ASR Max 的文本流式返回不能等同于麦克风双向实时识别。没有查到这一代公开可下载权重、自托管许可证及部署硬件要求。

### 模型、接口和费用

| 模型 | 已文档化接口/状态 | 国内站价格 | 国际站价格 |
| --- | --- | --- | --- |
| `stepaudio-3-tts` | `POST /v1/audio/speech`；WebSocket `/v1/realtime/audio` | 2.5 元/万计费字符 | $0.36/万计费字符 |
| TTS 音色克隆 | 正式复刻成功收费；试听仅收合成费用 | 9.9 元/音色 | $1.50/音色 |
| `stepaudio-3-asr-max` | `POST /v1/audio/asr/sse`；整段上传，SSE 返回识别文本 | 2.8 元/音频小时 | $0.24/音频小时 |
| `stepaudio-3-realtime-preview` | 持久 WebSocket，全双工对话 | 限时免费 | 限时免费 |
| `stepaudio-3-chat-preview` | Chat Completions 语音/文本输入，文本回复 | 限时免费 | 限时免费 |
| `stepaudio-3-gen-preview` | `POST /v1/audio/generate` | 限时免费 | 限时免费 |
| `stepaudio-3-music-preview` | 音乐生成预览 | 限时免费 | 限时免费 |

计费字符规则：一个汉字算一个字符，两个英文字母或两个标点算一个字符。国内外价表不同，不能直接按汇率换算。免费预览结束后预览模型将退役并引入正式收费版本；目前不能确定长期单位成本。V0 标准 API 表列并发 5、RPM 10；需核实具体账户和 Realtime 的实际配额。

来源：[国内价格](https://platform.stepfun.com/docs/zh/guides/pricing/details)、[国际价格](https://platform.stepfun.ai/docs/en/guides/pricing/details)、[Realtime](https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-realtime)、[Gen](https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-gen)。

### 能力与边界

- TTS：官方强调语境控制、笑声、呼吸、犹豫、自我修正、低延迟流式生成。单次文本上限 1,000 字符，3 代全局 instruction 上限 500 字符；支持括号中的不朗读指令。WebSocket 默认累计到完整句子才生成，可发 `tts.text.flush` 强制输出已有文本。未见可据以承诺生产 p95 的量化延迟或 SLA；这些能力描述不是我们的端到端实测。
- ASR：官方称支持语境、专名、中英混说、低声耳语与复杂背景音；宣称耳语测试 CER 3.97%。这是官方基准结果，不能代替目标用户、口音和成人对话词汇实测。3 代 Max 只核实 HTTP/SSE；当前双向识别 API 支持列表仍是 `stepaudio-2.5-asr-stream`。
- 语言：官方总览列 TTS/ASR 中文、英语、日语、韩语、法语、西班牙语；中英文之外为 preview。Realtime 列中英文。
- Realtime：包含语音理解、轮次管理、打断、附和识别、推理与工具调用；它是对话执行栈，不能当成只替换 TTS 的接口。
- Gen：支持多角色、语音、环境音、音效、背景音乐一体生成；当前 HTTP audio/SSE，无双向 WebSocket。更接近异步场景音频资产生产。

来源：[模型总览](https://platform.stepfun.ai/docs/en/guides/models/audio)、[TTS](https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-tts)、[TTS WebSocket](https://platform.stepfun.ai/docs/en/api-reference/audio/ws-audio)、[ASR](https://platform.stepfun.ai/docs/en/guides/models/stepaudio-3-asr)、[双向 ASR](https://platform.stepfun.ai/docs/en/api-reference/audio/asr-stream)、[Gen 论文](https://arxiv.org/abs/2609.12945)。

### 开源与自托管

当日读取官方 GitHub 组织仓库 API 和 Hugging Face 模型 API，存在 Step-Audio、Step-Audio2、Step-Audio-EditX、Step-Audio-R1 等旧代项目，没有列出 StepAudio 3 的模型权重或推理仓库。已发布 StepAudio 3 Gen 技术报告及演示，不等于已发布权重。

所以本次结论是「未核实到 3 代可自托管」，不是断言其未来不会开源。旧 Step-Audio-TTS-3B 的 8 GB 显存要求、旧代仓库 Apache/其他许可证，均不能移植到 StepAudio 3。3 代参数规模、量化支持、显存、吞吐、独立部署许可都应保留为未知，不编造 GPU 成本。

核查入口：[官方 GitHub](https://github.com/stepfun-ai)、[GitHub 仓库 API](https://api.github.com/orgs/stepfun-ai/repos?per_page=100)、[官方模型目录](https://huggingface.co/stepfun-ai/models)、[模型 API](https://huggingface.co/api/models?author=stepfun-ai&limit=100)、[Gen 技术报告](https://arxiv.org/abs/2609.12945)。

### 服务条款是当前实际阻断

国际站 API 服务条款生效于 2026-08-07。§3.2(v) 明确禁止生成露骨性内容，范围包括性行为、性癖/性幻想、色情及旨在性唤起的内容；不是仅禁止未成年内容。中文站 2026-05-25 版协议也禁止散布淫秽色情。不能把模型宣传的情感陪伴场景理解为允许色情伴侣业务。

国际站 §4.1 对输入、输出、API 调用日志授予广泛使用权，并明确涵盖模型训练和微调；§1.4/4.4 又讨论早期访问与特定计划。不能承诺默认零留存或不训练。对用户私密语音，需要另行核实适用 DPA 和书面商业约定，而非依据免费试用推断。上述为公开条款的工程接入判断，不是对所有可能私有商业合同的结论。

来源：[国际服务条款](https://platform.stepfun.ai/docs/en/agreement/userservice)、[中文服务协议](https://platform.stepfun.com/docs/zh/agreement/userservice)、[数据处理协议](https://platform.stepfun.ai/docs/en/agreement/dataprocess)。

## 验证状态

已核对当日实时官方文档与官方开源目录；未调用收费 API、未试听质量、未测地区网络延迟、未确认实际账号可用性、未核实书面成人业务许可或私有化商业部署。不能把文档里的能力、价格和限速当成项目已有的运行证据。

## iDream 当前实现与接入判断

本节为当前工作树静态读取结论：HEAD `bd42bcd0b1772bd579b2c2229c4c3e236b5a39f9`，工作树有未提交变更。没有改业务代码，也没有执行模型效果或端到端测试。

项目证据：[产品定位](../product/PRD.md)、[当前语音覆盖](../product/CURRENT_FUNCTIONAL_COVERAGE.md)、[provider 构造](../../packages/main/src/server/providers/voice/factory.ts)、[语音接口与重放不变量](../../packages/main/src/server/providers/types.ts)、[Pocket 能力](../../packages/main/src/server/providers/voice/pocket-tts.ts)、[通话实现](../../packages/main/src/server/modules/chat/voice-call.ts)。

现有 voice factory 支持 `mock`、`pocket_tts`、`fish_audio`。`VoiceClipPort` 返回完整 `Uint8Array` 和 `durationMs`，要求同 key 重放；它不是流式音频端口。Pocket 当前返回 `sceneApplied:false`。`voice-call.ts` 的 `startVoiceCall` 始终抛错，因此 StepAudio Realtime 不能通过替换 provider 就把当前项目变成已完成的实时语音通话产品。

TTS 的 instruction 可映射我们已有 tone/scene，但 Fish 的 delivery 表达不能原样透传。若以后接入，需固定 voice profile、provider 和版本，保留历史重播及扣费契约；还要处理 1,000 字符长度限制、括号正文被当作不朗读指令、云请求超时后结果未知。增加缓存本身不能证明外部请求与费用 exactly-once，也不能破坏同 key 重放承诺。

建议：不替换主链路。TTS 在自然语气、场景控制和价格方面值得用自有授权音色做非露骨脚本 A/B；ASR Max 可针对耳语、名字、口音和中英混说建立小型验证集，但不应以它代替已文档化的双向流式 ASR。Realtime 属于另一个完整接入工程；Gen/Music 暂属低优先级场景资产探索。成人核心业务应先取得明确覆盖业务及数据使用的书面许可，或等这一代开放权重与许可证并重新评估自托管，不能因技术能力匹配而跳过现有条款冲突。

## 适用期限

本文是 2026-09-15 的评估快照。模型由 preview 转正式、模型 ID/接口/价格变化、权重或许可证发布、服务条款或专属商业合同变化时，应重新核验。当前材料不足以给出真实音质排名、端到端 p95 延迟或自托管成本结论。
