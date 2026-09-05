# Meta 模型与成年人虚构露骨文字陪伴：官方来源核查

核查日期：2026-09-05。范围限于已满 18 岁、自愿、虚构的文字角色扮演；本文不是对所有 NSFW 内容的统一判断。未调用任何生成 API，未下载权重，未修改服务或项目配置；模型拒答率、中文角色表现、工具调用、延迟均未实测。以下“没有笼统禁止”是对所读条文的有限解释，不是 Meta 对 iDream 商用的背书。

## 结论

Meta 需要拆成两条路线：官方托管 Muse Spark API 与可自托管的 Llama / Muse Glimmer 权重。**可自托管路线值得验证；不能把 Meta AI 消费端偶尔生成的内容直接当成 API 的稳定产品能力。**截至核查日，Meta 已不只是 Llama：Muse Spark 1.3 于 2026-09-02 上线 Meta Model API，Muse Glimmer 30B 于 2026-08-10 发布 Apache 2.0 权重。[Muse Spark 1.3 官方发布](https://research.meta.ai/blog/introducing-muse-spark-1-3)、[Muse Glimmer 官方发布](https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)

| 路线 | 已确认事实 | 对 iDream 的判断 |
| --- | --- | --- |
| Meta AI 消费端 | Muse Spark 被用于 Meta AI app / meta.ai；消费端和 API 是独立入口 | 不能以消费端体验作为接入授权或 API 行为证明 |
| Meta Model API / Muse Spark 1.3 | 官方确认 2026-09-02 可用；当前服务法律正文在本次访问中要求登录 | 接口存在，高置信度；露骨陪伴商用是否满足 API 专门条款，本次未确认 |
| Llama 3.1 / 3.3 / 4 自托管 | 定制商业许可，附 AUP；原版 Instruct 有安全训练 | 可评估，不能承诺原版持续完成 ERP |
| Muse Glimmer 30B 自托管 | 官方 Apache 2.0 文件，另附 Usage Policy；30B，官方提供 GGUF | 比 Llama 4 更切合本地验证规模；新模型，ERP 与 Agent 完整性仍需实测 |
| 社区 Llama RP 衍生模型 | 真实存在 RP 微调，继承基础模型许可问题 | 应逐个读作者卡、上游许可和量化来源；不能以“uncensored”标签作商用许可证明 |
| 第三方托管 | 聚合商要求同时遵守具体模型供应商条款 | 换托管商不等于取消模型或供应商限制 |

## 1. Meta AI、官方 API 与当前版本

- 2026-07-09，Meta 正式公告 Muse Spark 1.1 及 Meta Model API 公测；同一公告分别介绍 Meta AI app / meta.ai 的 Thinking 模式和开发者 API。因此不能把两者混称为同一个服务。[官方公告](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/)
- 2026-09-02，Meta 公告 Muse Spark 1.3 已在 Muse Code 和 Meta Model API 提供，并着重介绍 agent / coding 行为。公告没有承诺成人色情角色扮演，也没有披露该场景拒答率。[官方公告](https://research.meta.ai/blog/introducing-muse-spark-1-3)
- 官方服务条款地址本次跳转到 `ai.developer.meta.com` 后显示 “Not Logged In”；消费端 AI terms 也跳登录。故本次不能根据旧 Llama AUP、二手条款摘录或消费端体验断言 Spark API 允许该商业场景。[API 条款入口](https://ai.developer.meta.com/legal/terms-of-service)、[消费端 AI 条款入口](https://www.facebook.com/legal/ai-terms)

## 2. Llama 各代：当前 AUP 对 adult / obscene 的真实范围

在 Meta 官方 GitHub 当前 `main` 中，本次读到的 Llama 2、3、3.1、3.3、4 AUP 均未出现对所有成年人色情文本的笼统禁止。`obscene materials` 所在条款具体指向非法向未成年人提供材料，以及没有实施法律要求的年龄限制。它们还禁止儿童剥削、性暴力、人口贩卖、违法活动，并列出 sexual solicitation。这支持“政策文本没有简单把全部成人虚构文字 ERP 一刀切”这一有限结论；不支持“任何情色商业用途都明确获准”。这些是 2026-09-05 读取的现行仓库文件，不是每代发行当日的历史快照。

- [Llama 2 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama2/USE_POLICY.md)
- [Llama 3 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3/USE_POLICY.md)
- [Llama 3.1 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/USE_POLICY.md)
- [Llama 3.3 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/USE_POLICY.md)
- [Llama 4 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama4/USE_POLICY.md)

版本差异仍然重要：本次读取的 3.3、4 文件有禁止故意绕过/移除使用限制或安全措施的条款，3.1 文件没有对应这一项。3.3 / 4 还对其中多模态模型设欧盟主体限制；Llama 3.3 实际发布的 70B 模型是纯文本，而 Llama 4 Scout / Maverick 是多模态。不能用一个模型的许可概括整条 Meta 家族，也不应仅凭第三方声称“去限制”就假定权重改造满足上游条款。[Llama 3.1 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/USE_POLICY.md)、[Llama 3.3 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/USE_POLICY.md)、[Llama 4 AUP](https://github.com/meta-llama/llama-models/blob/main/models/llama4/USE_POLICY.md)

## 3. Llama 商业许可和模型行为是两件事

Llama 3.3（发布日 2024-12-06）和 Llama 4（生效日 2025-04-05）使用定制 Community License，提供使用、修改、衍生与分发权；要求遵守并入许可的 AUP。分发/提供相关产品或服务须满足许可证随附和 Built with Llama 标示等要求；发布衍生模型的命名亦有要求。模型发行日判断的前月 MAU 超过 7 亿主体需另获 Meta 许可。它们不是“只能研究、不能收费”的模型，也不是无条件的 Apache / MIT 权重。[Llama 3.3 LICENSE](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE)、[Llama 4 LICENSE](https://github.com/meta-llama/llama-models/blob/main/models/llama4/LICENSE)

Llama 3.3 官方模型卡明确写有 SFT / RLHF、安全微调和拒答行为；70B Instruct 的目标是通用多语言对话。其官方支持语言名单不含中文。开放下载可以让部署方固定版本并掌握运行环境，但不保证模型本身无拒答或中文 ERP 足够好。[Llama 3.3 模型卡](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/MODEL_CARD.md)

Llama 4 Scout / Maverick 是 MoE：每 token 激活参数约 17B，但总参数分别约 109B / 400B。不能把“17B 激活”当作只需装载 17B 权重的本机模型。仅作量纲估算，总权重理想 4-bit 下限分别约 54.5 / 200 GB，尚未包含量化元数据、KV cache 和运行时；不构成本机可用性或吞吐证明。[Llama 4 模型卡](https://github.com/meta-llama/llama-models/blob/main/models/llama4/MODEL_CARD.md)

## 4. 新的 Muse Glimmer 30B：更值得纳入本地候选

Meta 于 2026-08-10 发布 Muse Glimmer：约 30B dense，面向本地 Agent、工具调用和多模态理解，官方说明为商业和研究用途；模型卡列出 Safety SFT 和 Safety RL。因此它也不是官方“专用色情模型”。[官方模型卡](https://huggingface.co/meta-models/Muse-Glimmer-30B)

许可文件确实是 Apache License 2.0，没有 Llama 许可中的 7 亿 MAU、Built with Llama 或欧盟多模态地域条款。Apache 许可授予商业使用所需的广泛权利，但也保留通知、修改标记、专利、商标等通常要求。[官方 LICENSE](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/LICENSE)

与此同时，仓库单独附带 `USAGE_POLICY.md`。它自称适用于访问/使用 Muse Glimmer，使用 “You should not” 而不是 Llama 的 “You agree you will not”；其中没有笼统禁止所有成人虚构露骨文本，但保留了非法性内容、未成年人材料、性招揽和安全措施绕过等条文。本次未找到 Meta 对此独立政策与 Apache 许可法律关系的直接解释，因此既不能把旧 Llama AUP 直接套过来，也不能声称该文件毫无作用。[官方 Usage Policy](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/USAGE_POLICY.md)

本地可行性方面，Meta 官方 GGUF 卡列出约 16.8 GB 和 19.7 GB 的文本模型量化文件，分别定位 24 / 32 GB 容量档位；要求支持该架构的 llama.cpp 版本（卡中写 build b10353 或之后），并有上下文、模板与 reasoning 注意事项。**权重文件大小不是 iDream 与图片/视频生成同机运行时的全部内存预算。**没有读取本机硬件或运行模型，所以不声称当前机器能在现有负载下稳定承载。[官方 GGUF 卡](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF)

## 5. 社区衍生模型及第三方托管

模型作者的一手资料可证明社区 RP 衍生路线真实存在。例如 Sao10K 的 `L3.3-70B-Euryale-v2.3` 声明基于 Llama 3.3 Instruct，公开训练配置含 RP / creative 数据；作者的 `70B-L3.3-mhnnn-x1` 也声明包含角色扮演数据。作者陈述可支持“针对 RP 微调”，不能支持“比所有原版好”“稳定无拒答”或“已通过 iDream 工具链”。[Euryale 作者模型卡](https://huggingface.co/Sao10K/L3.3-70B-Euryale-v2.3)、[mhnnn 作者 README](https://huggingface.co/Sao10K/70B-L3.3-mhnnn-x1/blob/main/README.md)

选择第三方托管需同时看其服务条款。例如 OpenRouter 2026-08-31 条款明确要求用户及下游用户遵守具体 Model Terms，并说明模型可能移除、模型条款可能更新。聚合接入的存在本身不能确认某一 Meta 模型允许付费 ERP。[OpenRouter 官方条款](https://openrouter.ai/terms/)

## 6. 研究判断与后续验证目标

基于上述证据，我会把 **Muse Glimmer 自托管 + 明确适用于角色扮演的 Llama 衍生模型**列为 Meta 家族的优先评估路径，把 Muse Spark API 留为独立供应商候选。此优先级是结合发布规模、可固定权重和角色用途作出的工程推断，不是效果排名。

实测必须固定模型/权重版本、量化、chat template、runtime、system prompt 与 provider，分别测多轮角色连续性、合理成人场景中的拒答/突然转调、中文、长对话重复、schema/工具调用、首 token 和完整回复延迟；RP 写得好不能代替 Agent 正确调用工具的证据。此次没有开展这些实测。

置信度：官方版本、发布日期、许可证/AUP 条文和参数规模为高；从条文判定全部具体商业 ERP 边界为中等且有未确认项；实际 ERP 质量与拒答率无本次实测证据；Muse Spark API 当前专门内容条款未能读到，不作获准结论。
