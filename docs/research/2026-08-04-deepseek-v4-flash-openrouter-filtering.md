# DeepSeek V4 Flash 与 OpenRouter 成人陪伴内容过滤边界

日期：2026-08-04

范围：DeepSeek 官方 API、模型发布与服务条款；OpenRouter 官方模型目录、路由、错误处理、Guardrails 与服务条款；OpenRouter 当前部分实际上游 provider 的官方条款。只使用一手来源。

本轮没有取得或使用 DeepSeek / OpenRouter API key，没有发送成人 prompt，也没有测量实际拒答率。本文区分：**合同允许范围、平台标注、模型内生拒答、线上实际执行结果**。它们不是同一件事。

## 结论

1. **精确模型存在。** DeepSeek 官方 API ID 是 `deepseek-v4-flash`。OpenRouter 的 2026-04-23 固定版是 `deepseek/deepseek-v4-flash`，当前另有 2026-07-31 版 `deepseek/deepseek-v4-flash-0731`；不要只写“V4 Flash”而不固定版本与 provider。
2. **DeepSeek 官方直连不适合作为露骨成人陪伴主链路。** DeepSeek Terms of Use 明确禁止生成或推广“pornographic, obscene, or sexually explicit”内容或聊天机器人，并直接举例 `sexual chatbots`；Open Platform 条款要求开发者及其终端用户一并遵守。DeepSeek 同时保留建立风险过滤机制和审查使用行为的权利。故即便个别 prompt 偶尔通过，也不构成可持续的产品授权或稳定性保证。
3. **OpenRouter 当前没有把这个模型标成统一审核模型。** 2026-08-04 实查 OpenRouter `/api/v1/models`，`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-flash-0731` 及 latest alias 的 `top_provider.is_moderated` 都是 `false`。这表示 OpenRouter 当前目录没有对其标注“应用内容审核”，**不等于**模型一定不拒答、所有上游都不拦、或成人产品已获准使用。
4. **OpenRouter 默认路由会让结果随 provider 改变。** `deepseek/deepseek-v4-flash` 当前有 21 个上游 endpoint，0731 版有 16 个。OpenRouter 默认在优先 provider 间负载均衡并允许 fallback；输入也可能由用户配置的 Guardrail 在到达 provider 前以 403 拦截。上游还可能返回 moderation error 或在流式输出中途触发 output content filter。
5. **上游 provider 的条款确实不同。** DeepSeek 与 Fireworks 的官方条款都覆盖或禁止露骨/性暗示内容；Parasail 当前公开条款未发现成人内容类别禁令，只禁止非法或未授权用途；Mancer 官网宣称“no filters”，但其 Terms 又要求输入/预期输出不能是 obscene、lewd、offensive 或由公司认定 objectionable。不能用“OpenRouter 上显示 unmoderated”替代逐 provider 的合同与运行验证。
6. **产品决策：不要把未锁 provider 的 OpenRouter V4 Flash 当作成人主模型。** 若只做技术候选评测，至少固定模型 revision、`provider.only` 和 `allow_fallbacks: false`，再用同一套成人对话集测拒答、淡化、断流、HTTP 403、provider error 与角色出戏率。生产主链路若必须稳定承载露骨成人内容，开放权重自托管仍是更可控的边界；DeepSeek V4 Flash 权重为 MIT，但自托管仍需实测模型自身的对齐拒答，不能从许可证推断生成行为。

## 1. 精确身份

| 路径 | 精确 ID / 版本 | 当前证据 |
| --- | --- | --- |
| DeepSeek 官方 API | `deepseek-v4-flash` | DeepSeek 官方 API 文档列出的有效 `model` 值；1M context，支持 thinking / non-thinking |
| OpenRouter 固定 0423 | `deepseek/deepseek-v4-flash` | 模型页名称为 `DeepSeek V4 Flash 0423`，发布于 2026-04-24 |
| OpenRouter 固定 0731 | `deepseek/deepseek-v4-flash-0731` | 模型页名称为 `DeepSeek V4 Flash 0731`，发布于 2026-07-31 |
| OpenRouter latest alias | `~deepseek/deepseek-v4-flash-latest` | OpenRouter Models API 当前将其指向 `deepseek/deepseek-v4-flash-0731`；alias 会漂移，不适合可重复评测 |
| 开放权重 | `deepseek-ai/DeepSeek-V4-Flash` | DeepSeek 官方 Hugging Face 发布，MIT license |

来源：[DeepSeek V4 发布说明](https://api-docs.deepseek.com/news/news260424/)、[DeepSeek Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)、[OpenRouter 0423 模型页](https://openrouter.ai/deepseek/deepseek-v4-flash)、[OpenRouter 0731 模型页](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)、[OpenRouter Models API](https://openrouter.ai/api/v1/models)、[DeepSeek 官方权重](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash)。

需要特别避免两个混淆：

- DeepSeek 官方 API 的 `deepseek-v4-flash` 是服务端型号名；OpenRouter 要用 `deepseek/...` 命名空间。
- OpenRouter 的无后缀型号当前是 0423 固定版，不是 0731；需要新版就显式写 `-0731`，不要依赖 latest alias。

## 2. DeepSeek 官方直连：条款明确排除 sexual chatbot

[DeepSeek Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)（Last Update: 2026-03-27）有两个直接相关的约束：

- 第 3.3 节：DeepSeek 有权使用技术手段审查用户使用行为，包括建立风险过滤机制和非法内容特征库。
- 第 3.4(5) 节：不得使用服务生成、表达或推广 pornographic、obscene、sexually explicit 内容或 chatbot，并明确以 `sexual chatbots` 为例。

[DeepSeek Open Platform Terms](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)（Effective: 2026-04-29）第 3.1 节进一步要求 API 开发者确保自己和终端用户都遵守上述 Terms of Use。

因此对本项目要分两类判断：

| 场景 | 文档层判断 |
| --- | --- |
| 普通陪伴、恋爱、非露骨暧昧 | 官方没有按该名称一概禁止，但实际边界和拒答率未发布，必须实测 |
| 露骨成人角色扮演、以性聊天为产品功能 | 官方条款明确不允许；不能作为稳定生产主链路 |

DeepSeek API [Rate Limit & Isolation](https://api-docs.deepseek.com/quick_start/rate_limit) 还明确说明 `user_id` 用于 “Content Safety Isolation”。这证明官方 API 存在按终端用户标识处理内容安全的服务层能力，但官方文档没有公开 V4 Flash 的成人类别阈值、响应码或逐类拒答表。因此准确表述是：**有明确禁止和技术处理权，实际每条请求是否拦截未知**；不能说“100% 每次都会拦”，也不能把偶尔通过解释成允许。

## 3. OpenRouter 平台层：当前标成 unmoderated，但不是豁免层

### 当前目录标注

2026-08-04 对 [OpenRouter Models API](https://openrouter.ai/api/v1/models) 的只读查询结果：

| OpenRouter model | `top_provider.is_moderated` |
| --- | --- |
| `deepseek/deepseek-v4-flash` | `false` |
| `deepseek/deepseek-v4-flash-0731` | `false` |
| `~deepseek/deepseek-v4-flash-latest` | `false` |

OpenRouter 官方 [Models 文档](https://openrouter.ai/docs/guides/overview/models) 对 `is_moderated` 的定义是 “Whether content moderation is applied”。这是有价值的当前元数据，但只够支持“OpenRouter 当前未把该模型标成统一审核模型”。它不能证明：

- 模型后训练没有内生拒答；
- 每个 provider endpoint 都没有自己的输入/输出审查；
- OpenRouter 永远不会筛选输入；
- 当前用例符合 Model / Provider Terms。

OpenRouter [Terms of Service](https://openrouter.ai/terms) 第 5.5、5.8、7 节明确写明：适用的 Model Terms 仍然约束用户；OpenRouter 不修改、豁免或限制这些条款，并可因违反或可能违反 Model Terms 而暂停模型或服务访问。第 6.7 节也保留筛选、移除、编辑或阻止输入的权利。

### 三种仍可能发生的拦截

1. **用户自己配置的 OpenRouter Guardrail**：官方 [Guardrails 文档](https://openrouter.ai/docs/guides/features/guardrails/overview) 支持自定义正则 content filter；`Block` 会在请求到达模型前直接返回 403。它不是 V4 Flash 的默认成人过滤证据，但组织默认 Guardrail 或 key/member Guardrail 可能让同一模型在不同账户表现不同。
2. **实际上游 provider moderation**：[错误处理文档](https://openrouter.ai/docs/api/reference/errors-and-debugging) 规定 input 被标记时可能返回 403，并在 metadata 里给出 `provider_name`、`model_slug`、`reasons`；流式输出也可能因 output content filter 在中途返回错误。
3. **模型自身拒答**：即使没有 HTTP 403，模型也可能输出自然语言拒绝、淡化为非露骨内容或中断角色。这不会被 `is_moderated:false` 排除。

## 4. Provider 层：同一模型不是同一种服务边界

OpenRouter [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) 说明，默认会在多个 provider 间路由，并且 `allow_fallbacks` 默认为 `true`。2026-08-04 实查公开 endpoints API：

- `deepseek/deepseek-v4-flash`（0423）：21 个 provider，包括 DeepSeek、Fireworks、Parasail、Venice、Mancer 2、DeepInfra 等。
- `deepseek/deepseek-v4-flash-0731`：16 个 provider，包括 DeepSeek、Fireworks、Parasail、Venice、Mancer 2、DeepInfra 等。

这些列表和默认优先级会随时变化，不能视为长期清单。

| Provider | 官方一手证据 | 对成人陪伴的准确判断 |
| --- | --- | --- |
| DeepSeek | [Terms](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html) 禁止 sexually explicit content / sexual chatbots，并保留风险过滤 | 不适合露骨成人主链路；可能有服务层过滤 |
| Fireworks | [Terms](https://fireworks.ai/terms-of-service) 第 3.3(g) 要求 User Content 不含 nudity 或 sexually suggestive content，并保留移除 User Content / Output 的权利 | 合同边界不适合；是否逐请求技术拦截未公开 |
| Parasail | [Terms](https://parasail.io/legal/terms-of-service) 当前公开限制主要是 illegal / unauthorized purpose，未发现单列成人内容禁令 | 条款相对宽，但“未发现禁止”不等于明确授权或无过滤；仍需 provider 确认与实测 |
| Mancer 2 | [官网](https://mancer.tech/) 宣称 “No filters / No guidelines / No constraints”，但 [Terms](https://mancer.tech/terms) 又要求输入及预期输出不能是 obscene、lewd、offensive 或由公司判断 objectionable | 官方材料存在张力，不能只依据“unfiltered”营销承诺投入商业生产 |
| Venice | [API Docs](https://docs.venice.ai/api-reference/api-spec) 宣称 uncensored/private inference；但 [Terms](https://venice.ai/legal/tos) 要求 User Content 不应被合理认定为 pornographic，并保留 block/filter 权利 | 同样存在“uncensored”产品描述与合同限制的张力，不是无条件成人商业授权 |

这张表的目的不是为某个 provider 背书，而是证明：**OpenRouter 上的 provider 名称是成人可用性的一部分，不能被隐藏在统一 `model` 字段后面。**

## 5. 若要评测，必须固定路由

最小可归因请求应固定模型版本与 provider，并关闭 fallback：

```json
{
  "model": "deepseek/deepseek-v4-flash-0731",
  "messages": [{ "role": "user", "content": "<evaluation prompt>" }],
  "provider": {
    "only": ["<provider-slug>"],
    "allow_fallbacks": false
  }
}
```

`provider.only` 和 `allow_fallbacks` 的语义见 [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)。应从响应或 generation metadata 持久化：精确 model、provider、HTTP 状态、OpenRouter error metadata、finish reason、首 token 前失败/流中失败、完整自然语言拒答。

评测集至少覆盖：

1. 普通陪伴；
2. 恋爱和非露骨暧昧；
3. 成年人合意但露骨的角色扮演；
4. 多轮逐步升级而非单条直白 prompt；
5. 长期关系记忆与角色一致性；
6. 同 prompt × 多 seed / temperature × 多 provider 的拒答与出戏方差。

本轮未执行上述测试。故目前能下的结论是条款与架构判断，不是实际成人通过率。

## 最终判定

| 问题 | 答案 |
| --- | --- |
| DeepSeek V4 Flash 会不会拦成人聊天 | 官方直连有明确禁止和风险过滤机制，实际逐 prompt 拦截率未知；露骨成人主链路不应依赖它 |
| OpenRouter 会不会额外拦 | 当前目录把 V4 Flash 标为 `is_moderated:false`，没有证据表明它默认统一加了成人审核；但 Guardrail、provider moderation、模型自身拒答都仍可能发生 |
| OpenRouter 上不同 provider 是否不同 | 是。路由、条款、外部审核和数据处理边界都不同；默认 fallback 还会让实际 provider 变化 |
| 选一个“unfiltered provider”就能稳定生产吗 | 不能从名称或营销文案得出；先解决条款授权，再做固定版本、固定 provider 的真实多轮评测 |
| 是否还需要开放权重/自托管 | 对稳定露骨成人主链路，仍需要。DeepSeek V4 Flash 权重是 MIT，可避免外部 API provider gate；但模型内生拒答仍需本地实测 |

