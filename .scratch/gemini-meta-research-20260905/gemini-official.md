# Google 模型用于成人陪伴聊天：官方资料核查

核查日期：2026-09-05。范围：仅官方公开资料；没有调用生成 API、评测拒答率或修改项目配置。以下判断聚焦成年人、自愿、虚构的露骨文字角色扮演，不将普通恋爱聊天与色情文字混为一类。

## 结论

Gemini 消费端、AI Studio / Gemini Developer API、Cloud 托管 Gemini 均不应作为 iDream 露骨成人聊天的已获许可、稳定能力。Developer API 与 Cloud 的公开条款仍纳入色情 / 性满足内容限制；关闭可配置过滤器不修改合同，也不消除模型自身拒答。没有查到 Vertex / 现 Gemini Enterprise Agent Platform 对普通商用成人角色扮演的一般性例外。[Google PUP](https://policies.google.com/terms/generative-ai/use-policy)、[API 条款](https://ai.google.dev/gemini-api/terms)、[Cloud 服务条款 §20(c)](https://cloud.google.com/terms/service-terms)、[过滤器说明](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/configure-safety-filters)

但是不能把这个结论泛化成“Google 所有可下载模型都不适合”。**Gemma 4 于 2026-04-02 改用 Apache 2.0**；旧 Gemma Terms 明确将 Gemma 4 排除并指向新许可。自托管 Gemma 4 可以作为另一个待评测方向，但原版仍接受抑制露骨输出的安全训练，未证明其成人聊天表现。[旧条款适用范围](https://ai.google.dev/gemma/terms)、[Gemma 4 许可](https://ai.google.dev/gemma/apache_2)、[发布公告](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)、[模型卡](https://ai.google.dev/gemma/docs/core/model_card_4)

## 分服务事实

| 服务 / 模型 | 已核验的事实 | 对 iDream 的含义 |
| --- | --- | --- |
| Gemini App | 产品指引明确不生成露骨性行为 / 身体部位描写，包含色情与情色；考虑教育、纪录、艺术、科学语境。页面未显示生效日期；2026-09-05 读取。[产品指引](https://gemini.google/policy-guidelines/) | 消费端不是成人剧情支持的承诺，也不能据它推断 API 合同。 |
| AI Studio / Gemini Developer API | 条款生效 2026-03-23，页面更新 2026-04-28；明确纳入 PUP，较宽松安全设置可能被审查。[API 条款](https://ai.google.dev/gemini-api/terms) | 不能将付费、18+ 用户或 OFF 参数解释为成人聊天许可。 |
| Cloud 托管 Gemini（原 Vertex AI） | 当前 Cloud Service Specific Terms 最后修改 2026-07-29，§20(c) 将 Google PUP 纳入 AUP；§20(o) 已称 Gemini Enterprise Agent Platform API，注明 formerly Vertex AI API。[Cloud 服务条款](https://cloud.google.com/terms/service-terms) | 单纯切换到 Vertex 接入不改变露骨成人用途的基础限制；本次未发现针对该场景的专门许可。 |
| Gemma 1–3 等旧许可模型 | 2026-04-01 版条款 §3.2 纳入 Gemma PUP，适用于附录模型。PUP 最后修改 2024-02-21，明确禁止为色情 / 性满足生成内容，直接举 sexual chatbots。[旧条款](https://ai.google.dev/gemma/terms)、[旧 PUP](https://ai.google.dev/gemma/prohibited_use_policy) | 可下载与自托管不自动移除模型许可限制。 |
| Gemma 4 自托管 | 官方改用 Apache 2.0；该许可无旧 PUP 那种针对色情用途的条款。官方模型卡仍把抑制 sexually explicit content 列作安全评估目标，并说明测试是在没有外部安全过滤器时进行。[许可](https://ai.google.dev/gemma/apache_2)、[模型卡](https://ai.google.dev/gemma/docs/core/model_card_4) | 许可比旧 Gemma 明显宽松；仍需评估原版 / 适当微调版的行为、质量和部署成本。第三方托管服务另有条款，不能从自托管许可推断其 API 许可。 |

## 精确的政策边界与反证

Google 通用 PUP（最后修改 2024-12-17）禁止的范围包括以色情或性满足为目的的内容；限制并非只针对未成年人或不自愿场景。末尾的教育、纪录、科学、艺术与重大公共利益是 **Google 可以作出例外** 的语义，不是“凡虚构故事即自动获豁免”。本次没有找到 iDream 这类一般商用成人陪伴剧情被明确纳入例外的官方依据。[PUP](https://policies.google.com/terms/generative-ai/use-policy)

过滤器是一个独立技术层。Developer API 的 2026-09-04 文档说明 `OFF` 关闭可配置过滤器、`BLOCK_NONE` 不按该分类概率拦截，并保留不可调整的核心保护。Cloud 文档进一步明确，过滤器阻止输出但不直接改变模型行为；`OFF` 不返回该过滤器的评分元数据，`BLOCK_NONE` 保留评分以便客户自定规则。这解释了“社区有人生成成功”与“别人设置 OFF 仍被拒绝”能够同时发生；两者均不构成修改使用条款的证据。[Developer API safety settings](https://ai.google.dev/gemini-api/docs/safety-settings)、[Cloud safety filters](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/configure-safety-filters)

API 的执行风险也有官方证据：2026-06-09 更新的 Abuse monitoring 文档说明自动与人工流程会审查包括露骨内容在内的疑似滥用；可调整额度或响应模型、暂停、最终关闭访问。这里应表述为官方保留的处置方式，而非声称某次成人请求一定封号。[Abuse monitoring](https://ai.google.dev/gemini-api/docs/usage-policies)

## 当前型号只作定位

2026-09-05 官方模型目录列出 Gemini 3.8 Flash stable、3.7 / 3.6 / 3.5 Flash，以及 Gemini 3.1 Pro preview；旧社区讨论中的 Gemini 1.5、2.5 或 3 Pro preview 不应当作这些当前型号的拒答率证据。模型升级不解除前述服务条款。[当前模型目录](https://ai.google.dev/gemini-api/docs/models)

Gemma 4 发布时提供 E2B、E4B、26B MoE、31B Dense，并有 function calling 与结构化 JSON 支持；这些是 Agent 候选能力，不是已通过 iDream 工具链验证。[2026-04-02 公告](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)

## 建议用于最终答复的短句

“Gemini 官方 API 不适合承诺露骨成人聊天：Google 的公开条款明确限制色情 / 性满足用途；社区能跑出的例子只证明某个版本某种配置可能输出，不等于获得商用许可。Meta 则必须另分消费端和 Llama 开放权重。另一个值得注意的新变化是 Gemma 4 已改 Apache 2.0，可以自托管评测，但不要沿用旧 Gemma 或 Gemini 的结论，也不要把宽松许可当成原版不会拒答。”

所有引用来源均于本次实际打开；没有把搜索摘要中的第三方判断当作官方许可依据。未引用获取失败的 Google Open Source Blog（HTTP 429），其许可事实由官方条款、Apache 页面、Google 产品公告三者交叉确认。
