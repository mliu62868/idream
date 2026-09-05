# Grok 成人文字陪伴：官方来源复核

核查日期：2026-09-05。仅公开网页和官方文档；没有调用生成 API、修改配置或联系供应商。

## 核心结论

当前 Grok 官方 AUP 未见对“虚构成年人、自愿、露骨文字角色扮演”的整类禁止；这与 Google 的明确色情 / 性满足用途禁令不同。但不能将没有逐类禁止推断为官方承诺稳定 NSFW API，更不能忽略竞争服务限制。[AUP，生效 2026-08-14](https://x.ai/legal/acceptable-use-policy)

对 iDream 最准确的定位是：**Grok 是可进一步评估的托管模型候选；现有公开材料不足以确认该业务已获商用许可，或当前模型可稳定完成露骨多轮剧情。**

## 1. 成人文字用途与边界

- AUP 明确限制儿童性化 / 剥削、侵犯真人隐私或肖像权的色情化、违法内容以及绕过防护。未找到专门全面禁止虚构成年人自愿露骨文本的条文。[AUP](https://x.ai/legal/acceptable-use-policy)
- “未找到 blanket 禁令”是对所查条文范围的判断；不是供应商为 iDream 出具了许可，也不是模型行为实测结果。
- Enterprise Terms 于 2026-08-14 更新；§2 纳入 AUP，并允许供应商对疑似违反规则的特定输入 / 输出限流或拦截。[企业条款](https://x.ai/legal/terms-of-service-enterprise)

## 2. 竞争产品限制：FAQ 确实明确答了 No

- 当前 AUP 仍限制用服务或输出开发直接或间接竞争的模型、产品或服务。[AUP](https://x.ai/legal/acceptable-use-policy)
- Enterprise §1.1 同时允许客户将 API 集成到自己的产品，形成 Bundled Service 并提供给终端用户。因此不能把竞争条文解释成“一切基于 API 的商业产品都不允许”。[企业条款](https://x.ai/legal/terms-of-service-enterprise)
- 官方企业 FAQ 对能否通过 API 运营竞争服务明确回答否；展开正文大意是，不允许自己或让他人通过 API 转租服务，或开发 / 运营与其服务类似或竞争的服务。未发现针对 AI 陪伴网站的进一步分类、明确豁免或许可说明。[企业 FAQ](https://x.ai/legal/faq-enterprise)

关键逐字摘录（合计 17 个英文词，避免大段复制）：

> “No.” … “to develop or run any service similar to or competitive with any SpaceXAI service.”

实际读取方式：普通 web 文本抽取只能看到该 FAQ 问题，不能展开正文；使用 CUA 创建独立 Chrome 标签打开 `https://x.ai/legal/faq-enterprise`，点击竞争服务问题的折叠按钮，随后读取更新后的 accessibility tree。2026-09-05 实际展开所得正文即上述摘录及概述。页面页脚显示 **Last updated: February 25, 2025**；该 FAQ 日期早于现行 2026-08-14 AUP / Enterprise Terms，应作为辅助解释，不应宣称它是现行合同的新增豁免。

推论：iDream 的成人 AI 陪伴业务与该范围如何对应，公开资料仍未解决；商业接入前，应获得针对实际业务的书面确认。此次没有联系 xAI / SpaceXAI。

## 3. Grok 4.6 已正式出现在官方 API

- 官方发布公告日期 **2026-08-12**，声明当日发布 Grok 4.6 并提供 API。[发布公告](https://x.ai/news/grok-4-6)
- 当前官方模型标识为 **`grok-4.6`**；文本 / 图像输入、文本输出，支持 Responses API、Chat Completions、函数调用和结构化输出。[模型页](https://docs.x.ai/developers/models/grok-4.6)、[接入指南，更新 2026-08-21](https://docs.x.ai/developers/grok-4-6)
- 官方定位偏编码、长程 Agent 与知识工作；所查发布公告、型号页和接入指南没有承诺 NSFW 文字角色扮演支持或拒答率。不能用工具调用能力推断成人剧情质量。

## 4. 消费端 NSFW 开关不是文本 API 开关

- 现行网站 / App FAQ 中确有 NSFW 选项说明，但位于 **Image & Video Generation (Grok Imagine)** 章节。该节同时说启用 NSFW 不关闭审核，部分内容始终禁止。[Grok 网站 / App FAQ](https://docs.x.ai/grok/faq)
- 该页面还说明 Companions 当前是 iOS 功能；消费端展示 / 功能不能直接外推到 Grok 4.6 的官方文本 API。
- 已读取当前 Chat / Responses REST API 参考及其完整 Markdown 版本：未发现 `nsfw`、`sexual` 或文本色情模式参数；有关 safety 的字段是用于帮助识别违规终端用户的 `safety_identifier`，不是关闭保护的开关。[API 参考](https://docs.x.ai/developers/rest-api-reference/inference/chat)、[完整 Markdown](https://docs.x.ai/developers/rest-api-reference/inference/chat.md)
- Markdown 获取方式：使用官方页面的 View as Markdown 链接；web 工具拒绝该 MIME 类型后，对同一官方公开 URL 进行只读 HTTP 获取并核对文本。未访问账户或任何带凭据的 API。

## 最终回答应区分的三件事

1. **政策空间**：未见成人自愿虚构露骨文字的全面禁令，但仍有 AUP 与竞争条款。
2. **实际输出**：社区实测能够提供候选信号，必须标型号、日期、入口与版本；这里尚未实测。
3. **长期商用可靠性**：当前公开 API 文档没有 NSFW 能力承诺，不能只凭 Grok 的消费端形象完成供应商决策。
