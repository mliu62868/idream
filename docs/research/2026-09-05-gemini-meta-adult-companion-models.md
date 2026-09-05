# Gemini 与 Meta 模型：成人陪伴聊天的政策、许可和社区证据

核查日期：2026-09-05。

范围：iDream 的成年人、自愿、虚构、露骨文字角色扮演，以及同一 Agent 所需的角色连续性和工具调用。没有发送模型生成请求、下载权重、修改配置或切换服务；本文没有拒答率、中文质量或本机吞吐的实测结论。

## 结论

**Gemini 官方 API 不宜作为露骨成人聊天主链路；Meta 的开放权重路线可以纳入评估，但不能用品牌名判断是否支持。**目前 Meta 已有 Muse Spark 托管 API 和 Muse Glimmer 开放权重，不能只讨论旧 Llama。Google 的 Gemma 4 也发生了许可变化，应与 Gemini 服务分开。

本报告区分四项：服务/模型许可允许什么、平台是否过滤、模型是否拒答、最终是否产生合格的陪伴与 Agent 行为。社区成功案例只能为后两项提供有限线索，不能修改前两项的条款。

| 路线 | 官方政策或许可证据 | 社区与模型行为证据 | 对 iDream 的判断 |
| --- | --- | --- | --- |
| Gemini Developer API / AI Studio | API 条款纳入 Google PUP，限制色情与性满足用途。[API 条款](https://ai.google.dev/gemini-api/terms)、[PUP](https://policies.google.com/terms/generative-ai/use-policy) | 社区确有生成成人文本的报告，也有拒答、重复和角色出戏报告 | 不选作露骨聊天生产主模型 |
| Google Cloud 托管 Gemini（原 Vertex AI） | Cloud 服务条款 §20(c) 同样纳入 PUP；未发现一般商用 ERP 豁免。[Cloud 条款](https://cloud.google.com/terms/service-terms) | 可配置过滤阈值，不能据此推断合同豁免或消除内生拒答 | 换到 Vertex 不解决这一根本限制 |
| Meta Model API / Muse Spark 1.3 | 官方确认 2026-09-02 上线；本次 API 法律正文要求登录，内容条款未核实。[发布说明](https://research.meta.ai/blog/introducing-muse-spark-1-3)、[条款入口](https://ai.developer.meta.com/legal/terms-of-service) | 社区对 1.1–1.3 的成人输出及角色表现评价分裂，版本之间不能直接类推 | 保留候选；不作已获成人商用许可结论 |
| Llama 3.3 / 4 自托管及衍生模型 | 定制 Community License 和 AUP；当前 AUP 没有笼统禁止所有成年人虚构露骨文字。[3.3 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/USE_POLICY.md)、[4 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama4/USE_POLICY.md) | 原版安全训练仍可能拒答；RP 衍生模型需要逐个核实和评测 | 可以评估，不能承诺原版无拒答 |
| Muse Glimmer 30B 自托管 | Apache 2.0 权重，另附独立 Usage Policy；两者不能只取其一。[LICENSE](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/LICENSE)、[Usage Policy](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/USAGE_POLICY.md) | 有本地成人 RP 成功和短回复、文风干燥、拒答等不同反馈 | Meta 家族值得纳入本地候选；未证明优于当前模型 |
| Gemma 4 自托管 | 2026 年改用 Apache 2.0，旧 Gemma 条款明确排除它。[适用范围](https://ai.google.dev/gemma/terms)、[许可](https://ai.google.dev/gemma/apache_2) | 官方仍披露抑制露骨输出的安全目标；许可宽松不代表原版无拒答 | Google 家族里应另行评测的开放权重路线 |
| Gemma 1–3 等旧许可模型 | 旧条款纳入 Gemma PUP，后者直接限制色情内容及 sexual chatbots。[旧 PUP](https://ai.google.dev/gemma/prohibited_use_policy) | 自托管不取消上游许可 | 不能套用 Gemma 4 的 Apache 结论 |

## Gemini：社区能生成，不等于适合商用主链路

Google 通用 PUP 当前页面标为最后修改于 2024-12-17，限制以色情或性满足为目的生成内容。Gemini API 条款（生效于 2026-03-23）及当前 Cloud 服务条款均引用该政策。艺术、教育等例外由 Google 保留判断空间，不能自行把商用情色陪伴统称为艺术豁免。[PUP](https://policies.google.com/terms/generative-ai/use-policy)、[API 条款](https://ai.google.dev/gemini-api/terms)、[Cloud §20(c)](https://cloud.google.com/terms/service-terms)

`OFF` / `BLOCK_NONE` 是可配置过滤器的控制，不是取消使用条款的授权。官方 Cloud 文档明确区分过滤器与模型行为；模型仍可能自然语言拒答，也有不可配置的保护。因此，“关掉设置后有人能聊”与“相同型号仍有人被拒绝”能够同时成立。[Safety settings](https://ai.google.dev/gemini-api/docs/safety-settings)、[Cloud safety filters](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/configure-safety-filters)

本次官方目录已列 Gemini 3.8 Flash stable，API ID 为 `gemini-3.8-flash`；Gemini 3.1 Pro 仍标为 preview。下面同时保留近期和旧版讨论，但不把旧版经验直接归到新版。[模型目录](https://ai.google.dev/gemini-api/docs/models)

| 社区讨论 | 使用者实际报告 | 证据的限制 |
| --- | --- | --- |
| 2026-09-02：[Gemini 3.8 Flash is out now](https://www.reddit.com/r/SillyTavernAI/comments/1w5dda0/gemini_38_flash_is_out_now/) | 有评论称成人内容可以输出，随后澄清走 OpenRouter；也有拒答反馈 | 早期体验；未固定实际 upstream，不能等同官方直连 |
| 2026-09-04：[Gemini 3.8 Flash is awesome](https://www.reddit.com/r/SillyTavernAI/comments/1w70mo6/gemini_38_flash_is_awesome/) | 正面标题下仍有频繁重生成、涉及性内容时过滤不稳定的评论 | 不能只用标题概括口碑，也没有足够多轮数据 |
| 2026-07-30：[Gemini keeps refusing](https://www.reddit.com/r/SillyTavernAI/comments/1vb946x/gemini_keeps_refusing/) | 原作者明确走官方免费 API + SillyTavern；普通 NSFW 可以，更黑暗的剧情会拒绝 | 不能把对更极端内容的拒绝当成“所有成人内容都无法输出” |
| 2026-04-10：[Gemini 3.1 experience](https://www.reddit.com/r/SillyTavernAI/comments/1shklcr/whats_ur_experience_with_gemini_31/) | 同帖有人称无拒答，有人称限制严重；另有重复、角色过度理性化及多角色规则错误反馈 | 角色卡、推理配置、平台和上下文不统一；不是受控 A/B |
| 2026-08-17：[Best roleplaying model discussion](https://www.reddit.com/r/SillyTavernAI/comments/1vqshjg/whats_the_best_for_roleplaying_right_now_i_dont/) | 有使用者长期偏好 Gemini 3.1 Pro 并称自己的配置未遇拒答 | 保留反证：不能写成“社区一致认为 Gemini 不能 RP” |

这些报告支持的结论是：Gemini 确有成人文本生成能力和满意用户，稳定性及使用边界仍不足以支撑本项目的生产承诺。它们不支持“Google 偷偷降智”“某个内部词表必然导致拒绝”等社区因果猜测。

## Meta：先分托管 Spark 与可自托管权重

### Muse Spark API

Meta 于 2026-07-09 公告 Muse Spark 1.1 和 Meta Model API 公测，并于 2026-09-02 上线 Muse Spark 1.3。1.3 公告聚焦 Agent 和编码能力，开放权重仍列在后续路线中。因此 Muse Spark 不能与已经可下载的 Muse Glimmer 30B 混称。[1.1 发布](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/)、[1.3 发布](https://research.meta.ai/blog/introducing-muse-spark-1-3)

本次官方 API 条款入口访问要求登录，没有取得现行专门内容条款正文。这是资料访问的缺口；不能推断为允许，也不能武断断言禁止。消费端体验和 Llama AUP 都不能代替 Spark API 的服务合同。

社区在 [7 月的 Spark 1.1 体验贴](https://www.reddit.com/r/SillyTavernAI/comments/1us8zl0/muse_spark_11_testing_for_rp_early_access_and/) 中报告较少限制和较好的规则遵循，同时批评人物对白、情感理解与角色一致性。[9 月 2 日的 1.3 发布讨论](https://www.reddit.com/r/SillyTavernAI/comments/1w5jzva/meta_muse_spark_13_is_here/) 中也有好坏两种反馈；其中部分评论明确回顾 1.2 或尚未试用 1.3，不能全部标为 1.3 的实测。少拒答与好的陪伴体验仍须分开。

### Llama 开放权重和 RP 衍生模型

本次读取的 Llama 3.3 / 4 当前 AUP 中，`obscene materials` 出现在非法向未成年人分发及法定年龄限制的语境。把这一条翻译成“所有成人色情都禁止”会扩大原文范围。但它们仍有具体用途和安全措施限制，商业部署须遵守定制许可；不能因为权重开放或模型被称为 uncensored 就忽略上游要求。[Llama 3.3 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/USE_POLICY.md)、[Llama 4 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama4/USE_POLICY.md)、[3.3 LICENSE](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE)

Llama 3.3 Instruct 有安全训练，官方支持语言列表也不能当成中文 ERP 的质量保证。[官方模型卡](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/MODEL_CARD.md) 社区专门 RP 微调确实存在，例如 `Sao10K/L3.3-70B-Euryale-v2.3` 的作者卡说明其训练用途，但这不是对其商业许可、零拒答或工具正确性的认证。[Euryale 作者卡](https://huggingface.co/Sao10K/L3.3-70B-Euryale-v2.3)

社区实例也互相矛盾：[2026-07-21 的使用者](https://www.reddit.com/r/SillyTavernAI/comments/1v276dn/looking_for_other_rp_options/) 喜欢 OpenRouter 上的 Llama 3.3 70B Instruct，称成人 RP 限制少；[2025-12-21 周帖中的使用者](https://www.reddit.com/r/SillyTavernAI/comments/1pskcra/megathread_best_modelsapi_discussion_week_of/) 则称 Nvidia NIM 上的 Llama 3.3 约三条消息后就拒绝继续。两条的时间、上游、角色卡都不同，只能反驳“一切 Llama 天然无拒答”，不能给出统一排名。

Llama 4 Scout / Maverick 的约 17B 指每 token 激活参数，总参数分别约 109B / 400B。不能因此把它们当成小型本机替换品；新版本号和通用榜单也不是角色扮演质量证据。[Llama 4 模型卡](https://github.com/meta-llama/llama-models/blob/main/models/llama4/MODEL_CARD.md)

### Muse Glimmer 30B

Glimmer 30B 于 2026-08-10 发布，权重使用 Apache 2.0，官方说明其本地 Agent 用途，并披露安全训练。[发布与模型卡](https://huggingface.co/meta-models/Muse-Glimmer-30B)、[LICENSE](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/LICENSE)

模型仓库另有独立 Usage Policy，措辞为 should not，列有违法性内容、性招揽和安全措施绕过等限制。本次未找到其与 Apache 许可法律关系的官方解释。它没有笼统禁止成年人虚构露骨文字，但不能因此声称没有任何使用条件。[Usage Policy](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/USAGE_POLICY.md)

[2026-08-10 的本地体验贴](https://www.reddit.com/r/SillyTavernAI/comments/1vkpv1w/thoughts_on_muse_spark_30b/) 标题把模型写成 Spark 30B，正文已经更正为 Glimmer。作者明确报告 KoboldCpp、Q6_K_XL、32k 上下文，觉得限制较少但回复偏短；索引收录的其他评论则有思考阶段拒答和文风干燥的意见。这是待复验线索，不是 Apple MLX 或 iDream 的运行证据。

## Google 开放权重的例外：Gemma 4

Gemma 与 Gemini 是不同模型路线。Google 于 2026-04-02 发布 Gemma 4，旧 Gemma Terms 已明确将它排除并引向 Apache 2.0。因此不能把旧 Gemma PUP 的 sexual chatbots 禁令直接套用到 Gemma 4 自托管。[官方条款范围](https://ai.google.dev/gemma/terms)、[Gemma 4 许可](https://ai.google.dev/gemma/apache_2)、[发布说明](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)

但 Gemma 4 官方模型卡仍把抑制露骨内容列为安全目标，并说明有关测试没有使用外部过滤器。这说明自托管可以脱离服务层过滤，原版模型自身的拒答倾向仍然存在。选择第三方托管时又要另看托管服务合同。[模型卡](https://ai.google.dev/gemma/docs/core/model_card_4)

## 对 iDream 的实际建议

1. **当前不切换主模型。** 本轮仅完成资料研究，没有任何候选通过同一角色与 Agent 任务的实测。
2. **自托管评测优先覆盖 Gemma 4、Muse Glimmer 30B，再按文风需要选一个许可明确的 Llama RP 衍生模型。** 这是基于许可与部署控制的候选优先级，不是效果排名，不构成下载或部署决定。
3. **Gemini 官方服务不纳入露骨聊天生产候选；Spark API 留作内容条款待核实的供应商。** 已有社区成功案例不能替代这一差别。
4. **模型评测至少同时看交付和质量。** 固定模型版本、provider 或权重/量化、模板、采样、上下文，观察服务层拦截、自然语言拒答、淡化、断流、重复、角色连续性、替用户行动；再单独看记忆与图片工具的参数、执行、重试及副作用。测首 token、完整回复耗时和单轮成本。
5. **用当前模型作同条件对照。** 候选必须对核心中文/英文用户场景、长对话和工具链产生可见收益，才值得替换；通用榜单、单次漂亮回复、下载量都不能证明这一点。

## 研究局限

- 社区是定向样本，以 r/SillyTavernAI 为主，不是市场调查；日期来自搜索索引，部分页面正文保留缓存相对时间。
- 已实际打开所引用的可访问政策、官方模型卡和主要讨论页；部分 Reddit 评论仅被搜索索引收录而未在正文抓取中展开，已在对应段落注明。
- Meta Spark API 法律正文未取得；未因缺失而作许可推断。
- 没有调用模型，无法给出拒答百分比或宣称某模型在当前机器上可稳定运行。没有更改项目既定审核配置。

