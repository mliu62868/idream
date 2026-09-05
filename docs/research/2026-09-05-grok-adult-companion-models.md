# Grok：成人陪伴聊天的官方政策与社区证据

核查日期：2026-09-05。

范围：iDream 的虚构成年人、自愿、露骨文字角色扮演。本文是公开资料研究；没有调用生成 API，没有测量拒答率、中文质量、长聊表现或 Agent 工具调用，也没有修改运行配置。社区帖子中的版本、平台及体验均为使用者自述。

## 结论

**Grok 值得进入托管 API 的评测名单，但现有证据不足以把它定为稳定支持露骨成人聊天的生产主模型。**社区存在明确的成人文字成功反馈，也存在相反反馈。当前官方模型目录已列出 `grok-4.6`，因此不能直接把 Grok 4.1–4.5 的口碑当作当前表现。[官方模型页](https://docs.x.ai/developers/models/grok-4.6)

这里需要分别回答：内容政策是否允许、具体调用是否拒答、角色扮演质量是否合格，以及商业产品是否符合服务条款。社区报告主要帮助确定评测重点，不能充当商用授权。

## 官方政策与商业边界

2026-08-14 生效的 AUP 适用于消费者、开发者和企业。本次读取未发现一条笼统禁止所有虚构成年人自愿露骨文字的规则；仍有儿童性内容、真人隐私与肖像性化、绕过安全措施等限制。不能把“未发现全面禁止”写成“官方承诺支持所有 NSFW”。[AUP](https://x.ai/legal/acceptable-use-policy)

同一 AUP 禁止利用服务或输出开发与服务商直接或间接竞争的产品或服务。企业 FAQ 的竞争服务问答明确回答不可以，涵盖开发或运营相似、竞争服务；该 FAQ 标注日期为 2025-02-25，本次通过真实 Chrome 展开正文核对，不能只看网页文本提取中的问题标题。[AUP](https://x.ai/legal/acceptable-use-policy)、[企业 FAQ](https://x.ai/legal/faq-enterprise)

另一方面，2026-08-14 企业条款 §1.1 明确允许 API 集成进客户产品并交付终端用户。对 iDream 的判断是：API 集成本身有依据，但成人 AI 陪伴是否落入竞争产品限制，需要服务商针对实际业务澄清；现有公开文字不足以断言必然获准或必然被禁。[企业条款](https://x.ai/legal/terms-of-service-enterprise)

官方将 Grok 4.6 定位于编程、Agent 任务和知识工作，列出工具调用与结构化输出能力。这能说明接口层面的候选资格，不能证明成人角色扮演表现或 iDream 集成已经通过验证。[模型页](https://docs.x.ai/developers/models/grok-4.6)、[API 入门](https://docs.x.ai/developers/grok-4-6)

官方消费端 FAQ 的 NSFW 开关说明位于 Imagine 图像 / 视频章节；本次核对 Chat / Responses API 参考未发现对应的文本 NSFW 开关。因此不能把消费端功能当作文字 API 的支持承诺。[消费端 FAQ](https://docs.x.ai/grok/faq)、[API 参考](https://docs.x.ai/developers/rest-api-reference/inference/chat)

## 社区的一手反馈

日期依据检索返回的帖子日期；部分正文只显示相对时间。以下是有明确出处的定性样本，不是随机抽样或统计测评。

| 日期与讨论 | 版本和调用平台 | 实际反馈 | 能支持什么判断 |
| --- | --- | --- | --- |
| 2026-07-08 起：[Anybody used Grok 4.5???](https://www.reddit.com/r/SillyTavernAI/comments/1ur6dga/anybody_used_grok_45/) | Grok 4.5；一位评论者明确写 NanoGPT | 该用户肯定文笔，同时认为过度主动引入性内容、情绪理解差；其他评论报告 OOC 指令混入人物对话，也有人喜欢其节奏 | 成人内容开放度和情绪、人设质量是两项独立指标；不能归为官方直连实测 |
| 2026-08-12：[Grok 4.6 Dropped Quietly via API is Now on OR](https://www.reddit.com/r/LoveGrok/comments/1vmjtym/grok_46_dropped_quietly_via_api_is_now_on_or/) | Grok 4.6；作者明确通过 OpenRouter API 与自有客户端聊天 | 作者对聊天体验满意，感觉比 4.5 受限少；另有评论认可回复投入程度 | 提供 4.6 的正面 API 体验；没有完整成人场景或上游路由记录，不能换算拒答率 |
| 2026-08-14：[Grok can still RP](https://www.reddit.com/r/LoveGrok/comments/1voiwrx/grok_can_still_rp/) | 一位用户同时使用 4.5 API 和 App，另试过 OpenRouter 上的 4.6 | 该用户喜欢 4.5 的温度与细节，觉得 4.6 较差；另有评论者称仍可写露骨成人故事，也有平淡、重复、角色知识串线的抱怨 | API/App 的角色扮演好评和成人故事成功反馈来自不同评论者，不能合并成一次确定的成人 API 测试 |
| 2026-08-29–30：[How is Grok 4.6 So far??](https://www.reddit.com/r/LoveGrok/comments/1w1qd6b/how_is_grok_46_so_far/) | Grok 4.6；正面评论者明确提到此前数周使用 API，未注明直连或聚合商 | 回答成人内容是否被禁时，该用户称文字仍可用；另一位认为仍能输出但描写较旧版保守 | 当前版本仍有成人文字可用的使用者报告；同帖结论并不一致，也没有请求日志可复现 |
| 2026-09-01–02：[Grok 4.5 4.6 Roleplaying](https://www.reddit.com/r/grok/comments/1w3so24/grok_45_46_roleplaying/) | 4.5/4.6；有旧会话与 App 使用语境，多数未明确 API provider | 多位用户抱怨新版角色扮演退步、成人剧情被拒绝；也有人称仍可正常扮演 | 近期版本变化值得测试，但这些抱怨不能直接当作官方 API 对全部自愿成人内容的拒答结论 |

选择三个社区是为了保留不同使用场景：SillyTavern 的角色扮演用户、Grok 通用用户及 LoveGrok 的陪伴用户。它们都存在自选择偏差；赞数不代表测评质量。部分负面帖子混合图片审核、黑暗剧情及成人文字，本报告没有把图片拒绝率移植为文字 API 拒绝率。也不采纳“编程训练必然导致角色扮演退步”等未经验证的因果解释。

## 对 iDream 的具体建议

保留当前已配置的模型，把 Grok 作为小规模对照候选。正式接入前需要两类证据：服务商对成人陪伴业务及竞争条款的明确答复；固定 API 型号和渠道的实际表现。没有必要凭 App 口碑先切换生产主链路。

后续评测应固定官方直连或聚合商与实际上游、请求返回的模型标识、相同角色和上下文。记录明确拒答、委婉跳过、普通聊天被强行色情化、人设与事实一致性、重复，以及中文情绪表达。再核对 Agent 的工具调用、流式完成和失败恢复。一次成功输出只能证明那次请求成功。

该建议是根据公开政策与相互矛盾的社区经验作出的选型判断，不是 Grok 相对其他模型的实测排名。
