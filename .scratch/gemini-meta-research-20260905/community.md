# Gemini / Meta 成人角色扮演社区反馈摘记

检索日期：2026-09-05。用途：为 iDream 模型选型提出可验证假设。未发送生成请求，未复现任何帖子结果。

## 证据边界

- 来源以 r/SillyTavernAI 的使用者原帖和评论为主；不是随机抽样，不能代表全体用户，也没有可计算的拒答率。
- 同时检索 r/LocalLLaMA、SillyTavern GitHub issues。通用编码、模型发布热度、推测性评价不作为成人聊天能力证据。
- 下列日期为搜索索引显示的帖子日期。Reddit 正文抓取有时保留缓存中的相对时间，因此不据此推断精确评论时间。
- 模型版本、服务入口、实际 upstream provider、角色卡、上下文和参数没有完整固定；跨帖比较不是受控 A/B。
- 社区所说 NSFW 有时涵盖非露骨暧昧，有时还混入暴力等不同内容。只将与成年人自愿虚构文字角色扮演相关的观察用于本项目；不复述绕过措施或原始色情场景。

## Gemini

| 日期 / 来源 | 作者报告了什么 | 对 iDream 的意义和限制 |
| --- | --- | --- |
| 2026-09-02：[Gemini 3.8 Flash is out now](https://www.reddit.com/r/SillyTavernAI/comments/1w5dda0/gemini_38_flash_is_out_now/) | 索引收录的评论有人称成人内容可输出，随后澄清走 OpenRouter；也有人反映拒答。正文可见的写作评价有正有负。 | 属于新版早期反馈；实际 upstream 未固定，不能等同 Google 官方 API 的统一表现。 |
| 2026-09-04：[Gemini 3.8 Flash is awesome](https://www.reddit.com/r/SillyTavernAI/comments/1w70mo6/gemini_38_flash_is_awesome/) | 帖子评价积极，但评论中有人报告经常需要重新生成，有人称涉及性内容时过滤不稳定。 | 能写出好回复和持续可靠交付是不同指标；帖子标题不能代表整串反馈。 |
| 2026-07-30：[Gemini keeps refusing](https://www.reddit.com/r/SillyTavernAI/comments/1vb946x/gemini_keeps_refusing/) | 原作者明确自己使用官方 API 免费层及 SillyTavern；普通 NSFW 未拒绝，向更黑暗情节发展时会拒绝。评论最初误把入口理解为消费端，作者后来澄清。 | 不能把这个标题简化为“Gemini 禁止所有 NSFW”；它也展示了社区如何把消费端与 API 混淆。 |
| 2026-04-10：[What's ur experience with gemini 3.1](https://www.reddit.com/r/SillyTavernAI/comments/1shklcr/whats_ur_experience_with_gemini_31/) | 同帖有人报告拒答严重，有人说 NSFW 未被拦。另有使用者报告重复、角色过度理性化、多角色游戏规则混乱；正面评价包括情节理解和细节。 | 老版本的明确矛盾证据；不能用于估算 3.8 的拒答率，也不能证明 Google 暗中更换模型。 |
| 2026-08-17：[What's the best for roleplaying right now](https://www.reddit.com/r/SillyTavernAI/comments/1vqshjg/whats_the_best_for_roleplaying_right_now_i_dont/) | 有用户将 Gemini 3.1 Pro 作为默认 RP 模型，称自己的配置没有拒答；其他人强调角色卡和输入质量。 | 证明社区存在长期偏好 Gemini 的用户，防止仅采集负面案例。并非平台支持成人商业产品的证据。 |

判断：不能声称 Gemini 在实践中完全不能生成成人文本；也不能因个人成功就称其适合生产。模型自身表现与 Google 服务条款必须分开判定。“厂商偷偷降智”“特定词触发内部规则”等说法没有官方或受控证据，本报告不采信这些因果解释。

## Meta 托管 Muse Spark

| 日期 / 来源 | 作者报告了什么 | 对 iDream 的意义和限制 |
| --- | --- | --- |
| 2026-07-10：[Muse Spark 1.1 Testing for RP](https://www.reddit.com/r/SillyTavernAI/comments/1us8zl0/muse_spark_11_testing_for_rp_early_access_and/) | 原作者称较少限制、规则遵循好、文风有区别，同时认为人物对白、情感理解和角色一致性不足。评论有不同看法。另有 NanoGPT 接入参数错误报告。 | 少拒答不保证陪伴体验；参数报错也不是内容过滤。1.1 结论不能直接移植到 1.3。 |
| 2026-09-02：[Meta Muse Spark 1.3 is here](https://www.reddit.com/r/SillyTavernAI/comments/1w5jzva/meta_muse_spark_13_is_here/) | 评论中对 1.2 的回顾互相冲突：有人称未遇到拒答，有人抱怨严重限制；索引收录的新版本体验也有“能输出成人内容但文风机械”的意见。 | 这是 1.3 发布初期讨论，部分发言明确尚未试 1.3，不能把所有负面回顾归给 1.3。实际 API 上游多数未写明。 |

判断：当前证据不支持“Muse 绝对不能 ERP”，也不支持“Meta 官方 API 已支持稳定 ERP”。它应是一个独立待验证的托管候选，不能与 Llama 权重路线混为一谈。

## Meta 开放权重

| 日期 / 来源 | 作者报告了什么 | 对 iDream 的意义和限制 |
| --- | --- | --- |
| 2026-08-10：[Thoughts on Muse Spark 30B](https://www.reddit.com/r/SillyTavernAI/comments/1vkpv1w/thoughts_on_muse_spark_30b/) | 标题写错，作者已明确更正为 Muse Glimmer 30B；报告本地 KoboldCpp、Q6_K_XL、32k 上下文，认为限制较少但回复偏短。索引收录的其他评论有思考阶段拒答和文风干燥等不同意见。 | 比纯品牌评价更接近可复验配置，但不是 Apple MLX 证据，不保证所有量化版本一致。 |
| 2026-08-10：[Muse Glimmer 30B - Meta released new model](https://www.reddit.com/r/SillyTavernAI/comments/1vkhl24/muse_glimmer_30b_meta_released_new_model/) | 发布贴大量评论尚未测试；一个报告具体量化的使用者认为 prose 有特点，但 agent 能力不如其对照模型。 | 仅为测试假设，不把发布贴和下载链接当成能力认证。 |
| 2026-07-21：[Looking for other RP options](https://www.reddit.com/r/SillyTavernAI/comments/1v276dn/looking_for_other_rp_options/) | 原作者报告使用 OpenRouter 上的 Llama 3.3 70B Instruct，认为成人 RP 限制少。评论有人觉得其 RP 能力落后；原作者仍认可自己的体验。 | 是成功案例，但 OpenRouter 实际上游未固定，不能归因为自托管原版 Llama 的确定行为。 |
| 2025-12-21 周帖：[Best Models/API discussion](https://www.reddit.com/r/SillyTavernAI/comments/1pskcra/megathread_best_modelsapi_discussion_week_of/) | 一位用户报告通过 Nvidia NIM 使用 Llama 3.3 70B，约三条消息后拒绝继续。 | 较老反例，足以反驳“所有 Llama 天然无拒答”；不是与上条在同环境的直接对照。 |

判断：自托管移除了外部推理平台的逐请求过滤依赖，但没有自动消除权重内的拒答，也没有取消许可证义务。社区的 ERP 微调名称不能代替核对基础权重与衍生许可。不能用 Llama 4 的参数规模或最新发布日期直接推断其更适合角色扮演。

## 建议转化为产品测试的维度

以下是评测设计建议，尚未执行：

1. 在相同成年虚构角色与会话脚本下分别记录服务层拦截、自然语言拒答、自动淡化，以及正常完成；不把所有失败统一叫“过滤”。
2. 同时观察角色身份、性格与关系连续性，是否替用户行动，是否重复模板或偏离用户意图；一次成功不能替代多轮表现。
3. 对 Agent 单独记录记忆读写、工具参数正确性、明确图片请求完成情况与重试副作用；文笔和工具可靠性不能互相替代。
4. 固定权重或 API ID、托管方、量化、prompt 模板、上下文长度与推理参数；在可固定 provider 的路由上关闭自动换上游，保证结果可归因。
5. 内容样本由产品侧使用受控、已授权数据确定，不把社区贴的极端样本复制进真实用户历史。

