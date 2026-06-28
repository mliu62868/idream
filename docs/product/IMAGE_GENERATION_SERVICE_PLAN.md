# 图片生成服务产品与实现方案

更新日期：2026-06-27

## 1. 文档目的

本文档定义 iDream 图片生成服务的产品功能、后台边界、前端工作台、异步 worker、provider 接入和验收标准。它承接现有 `PRD.md`、`BackendFeatureSpec.md`、`CHAT_SERVICE_PRD.md` 和 `docs/research/SERVICE_INTEGRATION.md` 的生成域设计，作为后续工程实现入口。

本轮产品策略已经确定：

- **图片优先**：先把图片生成、图库、计费、安全和真实 provider 闭环做稳。
- **参考后差异化**：学习目标站 `/generate` 的结构，但做成更清晰、安全、可解释的创作工作台。
- **Pipeline API 接入**：沿用当前 Redis + BullMQ + `packages/gen` worker 拓扑，接内部 OpenAI-compatible 图像 pipeline。
- **引擎隔离**：产品侧不直接绑定 MLX 或 `stable-diffusion.cpp`；它们只能作为内部 Pipeline Service 的 runner。P0 生产 runner 优先 `stable-diffusion.cpp`，MLX 作为 Apple Silicon 本地实验/高保真验证 runner。
- **后台可配置**：模型档位、prompt 模板、preset 片段、价格、权益、灰度和开关必须能在内部管理后台配置和审计，而不是每次改代码部署。

视频生成保留 API contract、付费门和 worker 骨架，但**第一期不发布为用户可用功能**——原因是视频生成耗时过长、产出体验暂不达标，正式排入 V1.1（见 `docs/architecture/12-roadmap.md` 的 2026-06-27 范围决策）。第一期内 `VIDEO_PROVIDER`/`GEN_VIDEO_PROVIDER` 保持 `mock`、`video_gen` 功能位保持 `false`。

## 2. 当前基线分析

### 2.1 已具备能力

当前仓库不是空白生成器，已经有完整的业务骨架：

| 能力 | 当前状态 |
| --- | --- |
| 数据模型 | `GenerationJob`、`GenerationPreset`、`MediaAsset`、`MediaLike`、`MediaCollection`、`Plan`、`Entitlement`、`DreamcoinLedger` 已存在 |
| API | `/api/v1/generation/jobs`、`/api/v1/generation/presets`、`/api/v1/media`、`/api/v1/dreamcoins` 已接入主站 service |
| 权益与扣费 | Premium/Deluxe gate、dreamcoin 余额校验、生成前扣费、失败退款逻辑已有基础实现 |
| 队列 | `ai.image.generate`、`ai.video.generate`、`app.ai.finalize` 已在 shared contracts 和 BullMQ adapter 中定义 |
| worker | `packages/gen` 已有独立 image/video worker 骨架，`packages/main` 有 `gen-finalizer` 进程 |
| 前端 | `/generate` 已有基础 Image/Video toggle、角色选择、prompt、图库和轮询逻辑 |
| 测试 | 已有 generation、pipeline、billing、authz、E2E 流程测试 |

### 2.2 关键缺口

| 缺口 | 用户影响 | 工程影响 |
| --- | --- | --- |
| 请求内同步 drain 队列 | 用户看不到真实排队/运行/失败过程，刷新恢复弱 | Next route handler 承担了 worker 工作，生产边界不成立 |
| 仅 mock provider | 无法生成真实图片 | `IMAGE_PROVIDER=pipeline` 在 env 中允许，但 provider registry 未实现 |
| mock blob 与展示 URL 混用 | 下载、私有访问、防盗链不可上线 | `MediaAsset.url` 不是稳定私有对象 key |
| 状态事件缺失 | 前端只能显示粗糙 status，无法解释排队、审核、退款 | 排障和客服无法还原任务生命周期 |
| 图片参数表达不足 | preset、比例、数量、模型、负面提示词难以扩展 | `controls` 可存 JSON，但缺少服务端 config 和校验 SSoT |
| Gallery 管理浅 | 用户不能可靠筛选、批量处理、恢复失败任务 | media API 有基础能力，前端体验和分页不足 |

### 2.3 设计原则

1. **生成任务一旦 accepted，就必须可靠进入队列**。浏览器连接断开不影响任务完成。
2. **主站拥有业务状态**：鉴权、权益、dreamcoin、`GenerationJob`、`MediaAsset` 和审核结论都在主站。
3. **gen worker 不读写主站 DB**：只消费自包含 payload、调用 provider、写 blob、投递 finalize。
4. **媒体必须先审核后释放**：output moderation 通过后才创建可展示的 `MediaAsset`。
5. **余额只从 ledger 派生**：生成前 reserve，失败或 blocked refund，重复执行不重复扣退。
6. **客户端 plan 不可信**：Premium/Deluxe gate 只由服务端 entitlement 判定。
7. **生成配置服务端权威**：前端只能读 `generation/config`；模型 profile、prompt 模板、preset allowlist、价格和权益由后台配置发布，所有变更必须有版本和审计。

## 3. 产品范围与非范围

### 3.1 P0 范围

| 功能 | 说明 |
| --- | --- |
| 图片生成 | 用户选择角色或 Freeplay，配置基础 preset、比例、数量，提交异步任务 |
| 角色选择 | 支持公开角色、用户自建角色和 Freeplay；未选择时不可提交 |
| 基础 presets | 支持 built-in background、pose、outfit；用户/社区 preset API 保留 |
| 成本预估 | 提交前显示本次 dreamcoin cost、余额、余额不足 CTA |
| Premium gate | custom prompt、negative prompt、高级模型由服务端强制 gate |
| 任务状态 | 展示 queued、moderating_input、running、moderating_output、completed、failed、blocked、refunded（对齐 BackendFeatureSpec §4.3） |
| 失败与重试 | 展示失败原因、是否退款、是否可重试；重试创建新任务 |
| Gallery | Images、Liked、下载、like/unlike、delete、基础 filter |
| 安全 | 输入文本审核、输出图片审核、未成年/真实人物等高风险政策代码留证 |
| Pipeline provider | `packages/gen` image worker 接内部 Pipeline API，mock provider 保留测试 |
| 管理后台配置 | Admin 能管理模型 profile、prompt 模板、preset、feature flag、价格、权益和生成任务排障 |

### 3.2 发布门槛

本方案里的 P0 需要拆成三个产品门槛，避免把内部验证、封闭测试和公开上线混成一个范围：

| 门槛 | 目标 | 必须具备 | 允许暂缓 |
| --- | --- | --- | --- |
| Internal Alpha | 团队能跑通闭环 | Auth、age gate、seed 角色、mock/sandbox 图片生成、dreamcoin reserve/refund、私有 media、admin job detail | 真实支付、第三方年龄验证、复杂 prompt 配置 |
| Closed Beta | 小范围真实用户可用 | 真实 Pipeline API、私有 BlobStore、基础 output moderation、Premium gate、失败/退款 UI、admin 配置回滚和任务排障 | 视频、public feed、community preset、高级批量管理 |
| Public Launch | 面向公网真实流量 | 辖区年龄验证策略、真实支付、举报/申诉闭环、审计和监控 | 复杂 image edit、社区创作市场、推荐算法 |

公开上线前，年龄验证策略、真实支付、举报/申诉和后台审计不能用 mock 替代。

> 涉未成年素材的自动检测与法定上报由**合规/法务侧独立负责，不在本设计范围**；本服务只在 input/output moderation 命中硬政策时拦截并留证（见 §8.1）。

### 3.3 关键产品决策

| 决策 | P0 默认 | 原因 |
| --- | --- | --- |
| 免费用户能否生成 | 能，通过 signup bonus 或每日小额度生成基础模型 | 用户必须先看到质量，才有升级动机 |
| Premium 差异 | 解锁 custom prompt、negative prompt、更高 count 或高级 preset | 让升级和“可控性”直接相关 |
| Deluxe 差异 | 解锁 premium model、更高 monthly coins、更高并发或更长历史权益 | 与 Premium 拉开质量和容量差 |
| Video | 可展示 locked/beta，不提交真实任务 | 保留需求信号，不引入 P0 成本和安全复杂度 |
| Public feed | P1，P0 生成媒体默认 private | 降低二次审核和社区治理压力 |
| Community preset | P1，P0 只 built-in + user private | 降低 UGC 审核压力 |
| Image edit | P1/P2 | 输入图、mask、来源追踪和安全审核更复杂 |

### 3.4 本轮非范围

| 非范围 | 原因 |
| --- | --- |
| 可用视频生成 | 视频成本、安全审核和时长处理更复杂，本轮只保留接口与付费门 |
| 256 张批量生成 | 需要 batch job、分页结果和更细粒度结算，不适合首发 |
| Image Edit / 局部重绘 | 需要上传输入图、mask、来源追踪和更强安全审核 |
| 社区 preset 发布 | 需要审核、排行、举报和创作者归属流程 |
| 公共 media feed | 需要公开可见性、二次审核、分享页和社区治理 |
| 自动多 provider 路由 | 首发只接一个内部 Pipeline API；后台可配 profile，但不做复杂自动 fallback |

## 4. `/generate` 工作台设计

### 4.1 信息架构

`/generate` 应从“表单 + 静态图库”升级为创作工作台：

```text
Generate workspace
  ├─ Header: mode, balance, upgrade CTA
  ├─ Composer panel
  │   ├─ Character / Freeplay selector
  │   ├─ Preset controls
  │   ├─ Prompt controls
  │   ├─ Advanced settings
  │   └─ Cost preview + Generate CTA
  ├─ Active jobs
  │   ├─ Queued / running cards
  │   ├─ Failed / blocked cards
  │   └─ Retry / view details actions
  └─ Gallery
      ├─ Images
      ├─ Videos gated / beta
      └─ Liked
```

桌面端保留左配置右结果的高效布局。移动端使用分段 tabs：`Create`、`Jobs`、`Gallery`，底部固定 Generate CTA 只在配置完整时启用。

### 4.2 生成前体验

| 控件 | P0 行为 |
| --- | --- |
| Mode | 默认 Image；Video 展示 locked/beta 状态，不直接提交 |
| Character | 必选 Character 或 Freeplay；选择后显示头像、名称、风格、年龄和安全状态摘要 |
| Background | built-in presets + Custom locked state |
| Pose | Image mode 可选；Freeplay 可用通用 pose，角色模式可用角色一致性提示 |
| Outfit | built-in presets + Custom locked state |
| Prompt | 免费用户显示锁定说明；Premium 可编辑 custom prompt |
| Negative prompt | Premium/Deluxe gated |
| Orientation | `1:1`、`4:5`、`3:4`、`9:16`、`16:9` |
| Count | 首发 `1..4`，显示每个数量对应 cost |
| Model | 免费默认模型；Premium/Deluxe 模型 gated |

### 4.3 生成中体验

任务提交成功后，前端立即把 job 插入 Active Jobs：

| 状态 | 用户看到 |
| --- | --- |
| `queued` | 已进入队列，展示预计等待文案 |
| `moderating_input` | worker 已取出任务，正在做输入审核（prompt/preset）；命中硬政策直接转 `blocked`（退款），否则进 `running`（见 §6.3、06 §异步流水线） |
| `running` | 正在生成，展示 provider/model 和 elapsed time |
| `moderating_output` | 正在安全检查，解释图片通过后才进入图库 |
| `completed` | 展示结果缩略图，并自动刷新 Images |
| `failed` | 展示错误原因、是否已退款、Retry CTA（retry = 新 job 重新扣费，见 §5.3.1） |
| `blocked` | 展示安全政策原因（policy code，§8.1.2），不展示原始输出，**无 Retry CTA**，引导改 prompt 或申诉 |
| `refunded` | 展示退款金额和余额更新 |

### 4.4 Gallery 管理

P0 Gallery 操作：

- Images：按创建时间倒序，cursor 分页。
- Liked：只展示当前用户 like 的媒体。
- Download：调用 signed URL，不暴露私有存储写入口。
- Delete：软删除 `deletedAt`，不立刻物理删 bytes。
- Like/Unlike：立即更新 UI，失败回滚。

P1 再补：

- 批量选择、批量删除、批量 visibility。
- Collection 收藏夹。
- Remix into Generate。
- 公开分享和 feed 发布。

## 5. API 与数据模型改造

### 5.1 新增或调整 API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/generation/config` | 返回 entitlements、balance、价格表、比例、模型、可用 preset 分类 |
| `POST` | `/api/v1/generation/jobs` | 创建异步图片任务，返回 `202` 与 queued job |
| `GET` | `/api/v1/generation/jobs` | 拉取当前用户任务列表，支持 `status`、`mode`、`cursor` |
| `GET` | `/api/v1/generation/jobs/:id` | 查询 job、assets、events、cost/refund 摘要 |
| `POST` | `/api/v1/generation/jobs/:id/retry` | 仅对 provider failed 任务创建 derived new job（`derivedFromJobId`），按当前费率重新扣费；blocked 任务拒绝（见 §5.3.1） |
| `GET` | `/api/v1/media` | 增加 cursor 和 `type=image|video`、`liked=1`、`visibility` filter |
| `GET` | `/api/v1/media/:id/download` | 返回短时 signed URL |

### 5.2 `generation/config` 响应形状

```json
{
  "entitlements": {
    "premium_controls": true,
    "video_generation": false,
    "premium_models": false
  },
  "dreamcoins": {
    "balance": 250
  },
  "pricing": {
    "image": {
      "baseCost": 5,
      "maxCount": 4
    }
  },
  "image": {
    "orientations": ["1:1", "4:5", "3:4", "9:16", "16:9"],
    "models": [
      {
        "id": "image-default",
        "label": "Default",
        "profileId": "profile_image_default_v1",
        "entitlement": null
      },
      {
        "id": "image-premium",
        "label": "Premium",
        "profileId": "profile_image_premium_v1",
        "entitlement": "premium_models"
      }
    ]
  },
  "video": {
    "enabled": false,
    "requiredEntitlement": "video_generation"
  }
}
```

前端只能用这个 endpoint 渲染权限和价格提示。最终 gate 仍在 `POST /generation/jobs` 服务端执行。

> 价格字段（`baseCost`、`maxCount`、模型倍率）由 `PricingRule` / `ModelProfile` 后台配置动态填充，数值 SSoT 在 ECONOMY §1.1/§1.2（图片基础 5 币/张，`cost = ceil(base × count × model_mult)`）。本文不复述费率数值，上面 JSON 仅为形状示例。

### 5.3 `POST /generation/jobs` 请求

```json
{
  "mode": "image",
  "characterId": "char_...",
  "freeplay": false,
  "prompt": "optional premium prompt",
  "negativePrompt": "optional premium negative prompt",
  "controls": {
    "backgroundPresetId": "preset_...",
    "posePresetId": "preset_...",
    "outfitPresetId": "preset_...",
    "orientation": "4:5",
    "model": "image-default"
  },
  "presetIds": ["preset_..."],
  "outputCount": 2
}
```

> 形状对齐说明：BackendFeatureSpec §5.5 早期示例把 `negativePrompt` / `outputCount` 放在 `controls` 内。本服务以上面这份**扁平形状为准**（顶层 `negativePrompt`、`outputCount`、`freeplay`），更利于服务端 entitlement gate 与 zod 校验；落地时同步更新 BackendFeatureSpec §5.5 示例，避免漂移。

服务端规则：

1. `mode=image` 才开放；`mode=video` 无 entitlement 或 beta flag 时返回 402/403。
2. `characterId` 与 `freeplay` 必须二选一。
3. `prompt`、`negativePrompt`、premium model 必须检查 entitlement。
4. `outputCount` 首发限制为 `1..4`。
5. `controls` 只接受 allowlist 字段，未知字段进入 validation error。
6. 输入审核在 worker 取出任务后、调用 provider 前执行（job 进 `moderating_input` 状态，06 §异步流水线）：命中硬政策则**不调用 provider**，job 转 `blocked` 并退款（`sourceId=jobId` 幂等）。POST 可做廉价同步预过滤，但权威的输入审核结论以 `moderating_input` 阶段为准。
7. **余额预留原子、无竞态**：`balance ≥ cost` 校验与 `-cost` 预留在同一 `POST` 事务内完成（ECONOMY §1.3），下单瞬间余额即被占用，“下单时够、排队中被并发花掉”不会发生。此竞态已在经济模型定稿，本服务**不重新设计**，只复用 reserve/refund 幂等（`sourceId=jobId`）。余额不足返回 402 + `insufficient_coins{ required, balance }`，不入队、不写 reserve。
8. **提交幂等（防双击/重发）**：客户端在 `Idempotency-Key` header 传一次性 key；服务端按 `(userId, idempotencyKey)` 去重，重复请求返回**同一** job（200/202）而非新建，避免双扣。无 key 时退化为普通创建（仍受限流约束）。
9. **每用户在途并发上限**：同一用户处于非终态（`queued`/`moderating_input`/`running`/`moderating_output`）的 job 数受 `MAX_INFLIGHT_JOBS_PER_USER` 限制（config，默认 3；Deluxe 可配更高）。超限返回 429 + `too_many_active_jobs{ active, max }`，不入队、不 reserve。

### 5.3.1 重试任务的扣费与可见性（决策）

> **决策：retry = 全新 job，按当前费率重新扣费；blocked 任务不可 retry；旧 job 事件链永久可见。**

| 情形 | 行为 |
| --- | --- |
| provider 失败的任务 | 失败已触发 auto-refund（币已退回，ECONOMY §1.3）。retry 创建 **derived new job**，按**当前费率**重新 reserve 扣费（不是“免费重跑”，因为上次已退款）。新 job 复制原参数，`derivedFromJobId` 指向旧 job。 |
| 用户主动 retry blocked（审核拦截）任务 | **不允许**。blocked 是安全决策，重跑同内容只会再次命中硬政策。前端不显示 retry CTA，服务端拒绝（403）。用户应改 prompt 重新提交（即一个普通新 job），或走申诉入口（07 §5）。 |
| 重试限额 | 同一原始 job 最多 3 次用户触发 retry（§8.3）。 |

- **可见性**：retry 不修改旧 job，旧 job 的 `GenerationJobEvent` 链（created→…→failed→refunded）在 history 中**永久保留可见**，便于用户理解和客服排障。新旧 job 通过 `derivedFromJobId` 关联，前端可展示 “由上一次失败重试而来”。
- **扣费语义**：因为失败/blocked 已全额退款，retry 不存在“重复扣”问题——它就是一笔在当前余额、当前费率下的新消费。若中途调过价，retry 按新价（锁价发生在新 job 的 POST 事务）。

### 5.4 数据模型补充

建议新增 `GenerationJobEvent`：

| 字段 | 说明 |
| --- | --- |
| `id` | 事件 ID |
| `jobId` | generation job |
| `type` | `created`、`reserved`、`queued`、`moderating_input`、`running`、`provider_completed`、`moderating_output`、`moderation_passed`、`completed`、`failed`、`blocked`、`refunded` |
| `message` | 给客服和内部排障看的简短说明 |
| `metadata` | provider code、attempt、queue job id、refund amount 等 |
| `createdAt` | 事件时间 |

建议扩展 `MediaAsset`：

| 字段 | 说明 |
| --- | --- |
| `storageKey` | 私有对象存储 key |
| `contentType` | `image/webp`、`image/png` 等 |
| `width` / `height` | 图片尺寸 |
| `providerAssetId` | provider 侧 asset id |
| `sourcePromptHash` | 可选，用于排障和重复生成分析，不暴露原文 |

建议扩展 `DreamcoinLedger`：

| 字段 | 说明 |
| --- | --- |
| `idempotencyKey` | `generation:{jobId}:reserve`、`generation:{jobId}:refund` 等唯一键 |

建议扩展 `GenerationJob`：

| 字段 | 说明 |
| --- | --- |
| `derivedFromJobId` | 可选，指向被 retry 的原始 failed job（§5.3.1），用于审计和前端“由上次失败重试而来”展示 |
| `errorCode` | 终态失败/blocked 时的稳定码（provider category 或 policy code），驱动 UI 文案与退款 |

如果不立即迁移 schema，首轮可把 provider 资产字段放入 `MediaAsset.metadata`，但 `storageKey` 与 ledger 幂等键应尽快提升为一等字段。

## 6. 队列、Worker 与 Provider

### 6.1 目标拓扑

```text
Browser
  -> Main Site POST /api/v1/generation/jobs
  -> GenerationJob(status=queued) + ledger reserve
  -> BullMQ ai.image.generate
  -> packages/gen image worker
  -> input moderation (moderating_input; blocked -> finalize blocked + refund)
  -> Pipeline API
  -> private BlobStore
  -> BullMQ app.ai.finalize
  -> gen-finalizer
  -> output moderation
  -> MediaAsset + GenerationJob(completed) + ledger settle/refund
  -> Browser polls /generation/jobs/:id and /media
```

### 6.2 主站职责

主站 `service.ts` 负责：

- 解析和校验请求。
- 查询 user、age gate、age verification、character、entitlements。
- 根据 pricing SSoT 计算 cost。
- 在事务内创建 `GenerationJob`、写 `GenerationJobEvent`、reserve dreamcoin。
- 入队 `ai.image.generate`。
- 返回 queued job，不等待 worker。

主站不做：

- 调用 Pipeline API。
- 处理媒体 bytes。
- 在请求内 drain queue。
- 信任客户端传入的 plan、cost 或 provider 状态。

### 6.3 `packages/gen` image worker 职责

`packages/gen` 负责：

- 消费 `ai.image.generate`。
- 使用 shared zod schema 校验 payload。
- 输入审核（`moderating_input`）：调用 `Moderation.checkText`（prompt/negative/preset labels），命中硬政策则投递 `app.ai.finalize(generation.blocked, policyCode)`，不调用 provider；由主站 finalizer 退款并写 `GenerationJobEvent(blocked)`。
- 调用 `PipelineImageModel.generate`。
- 把 provider 输出写入 BlobStore。
- 投递 `app.ai.finalize(generation.completed)`。
- 对 retryable provider error 直接 throw，让 BullMQ 重试。
- 对 terminal provider error 投递 `generation.failed`，由主站 finalizer 退款。

### 6.4 Pipeline API adapter

新增 `PipelineImageModel`，配置建议：

| Env | 说明 |
| --- | --- |
| `GEN_IMAGE_PROVIDER=pipeline` | 开启真实图片 provider |
| `PIPELINE_API_URL` | 内部 pipeline endpoint |
| `PIPELINE_API_TOKEN` | 服务端 token |
| `PIPELINE_IMAGE_MODEL_DEFAULT` | 默认模型 |
| `PIPELINE_IMAGE_SIZE_DEFAULT` | 可选本地 smoke 尺寸覆盖；生产优先后台 profile 尺寸 |
| `PIPELINE_PROFILE_DEFAULT` | 默认生成 profile id；真实参数仍来自后台配置 |
| `PIPELINE_TIMEOUT_MS` | 单次 provider 调用超时（默认 60_000） |
| `PIPELINE_MAX_ATTEMPTS` | provider adapter 内部轻量重试次数（建议 1，重试主要交给 BullMQ，见 §6.4.2） |

生产门禁：`APP_ENV=production` 下 `packages/gen` 图片 worker 会拒绝
`GEN_IMAGE_PROVIDER=mock`；当 provider 为 `pipeline` 时，缺
`PIPELINE_API_URL` 也会拒绝启动。具体模型文件（例如本地 ComfyUI
Z-Image safetensors）由 Pipeline Service/runner 加载，产品层 worker
不直接加载大模型文件。

接入真实 Pipeline API 后，先在 `packages/gen` 跑一次 provider 探针，
它会走 `PipelineImageModel -> BlobStore -> app.ai.finalize payload`，
但不会连接 Redis 或主站 DB：

```bash
SDCPP_IMAGE_PORT=8091 \
SDCPP_IMAGE_MODEL_ID=pornmaster-zimage-turbo \
SDCPP_CLI=/Users/kk/code/sdcpp/sd-cli \
SDCPP_DIFFUSION_MODEL=/Users/kk/Downloads/pornmasterZImage_turboV35Bf16.safetensors \
SDCPP_LLM=/Users/kk/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
SDCPP_VAE=/Users/kk/.localai/models/z-image-components/split_files/vae/ae.safetensors \
SDCPP_STEPS=1 \
SDCPP_MAX_COUNT=1 \
SDCPP_TIMEOUT_MS=300000 \
bun run --filter @idream/gen serve:sdcpp-image
```

另开一个 shell：

```bash
GEN_IMAGE_PROVIDER=pipeline \
PIPELINE_API_URL=http://127.0.0.1:8091 \
PIPELINE_API_TOKEN=local-pipeline-token-0123456789 \
PIPELINE_IMAGE_MODEL_DEFAULT=pornmaster-zimage-turbo \
PIPELINE_IMAGE_SIZE_DEFAULT=512x512 \
BLOB_ROOT=/Users/kk/code/idream/.tmp/probe-blob \
bun run --filter @idream/gen probe:image -- \
  --prompt "cinematic portrait" \
  --count 1 \
  --report .tmp/launch-image-probe.json

bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

探针必须返回 `ok: true` 且 `finalize.kind=generation.completed`，并由
`bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env`
读取同一份 `PIPELINE_IMAGE_PROBE_REPORT`、`BLOB_STORAGE_PROBE_REPORT`、
`WEB_SURFACE_PROBE_REPORT`、
`CHAT_SERVICE_PROBE_REPORT`、`CHAT_MODEL_PROBE_REPORT`、
`PRODUCT_CONFIG_PROBE_REPORT`、
`PAYMENT_PROVIDER_PROBE_REPORT`、`VOICE_MODEL_PROBE_REPORT`、
`AGE_VERIFICATION_PROBE_REPORT` 和
`SAFETY_GATEWAY_PROBE_REPORT` 后，才进入主站 E2E。
`WEB_SURFACE_PROBE_REPORT` 还必须证明未登录 admin 页面只显示 protected state，且
`/api/v1/admin/dashboard` 按 401 fail-closed。
`.tmp/production-launch.env` 应来自 secret manager 导出，或由
`packages/main/.env.production.example` 复制后填入真实生产值；其中必须包含
`APP_ENV=production`、`PIPELINE_IMAGE_PROBE_REPORT=.tmp/launch-image-probe.json`
、`WEB_SURFACE_PROBE_REPORT=.tmp/launch-web-surface-probe.json`
、`CHAT_SERVICE_PROBE_REPORT=.tmp/launch-chat-service-probe.json`
、`CHAT_MODEL_PROBE_REPORT=.tmp/launch-chat-probe.json`、
`PRODUCT_CONFIG_PROBE_REPORT=.tmp/launch-product-config-probe.json`、
`VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json`、
`BLOB_STORAGE_PROBE_REPORT=.tmp/launch-blob-probe.json`、
`PAYMENT_PROVIDER_PROBE_REPORT=.tmp/launch-payment-probe.json`、
`AGE_VERIFICATION_PROBE_REPORT=.tmp/launch-age-probe.json` 和
`SAFETY_GATEWAY_PROBE_REPORT=.tmp/launch-safety-probe.json`。
返回 `generation.failed` 时按 `finalize.error.code` 修 Pipeline，而不是把产品层
降级回 mock。

#### 6.4.1 runner 选择与 fallback（决策）

> **决策：单一生产 runner，无自动路由，无静默降级。**

1. **生产 runner 唯一**：P0 生产由内部 Pipeline Service 固定使用 `stable-diffusion.cpp` runner（§6.6）。产品层（主站 / `packages/gen`）只看到一个 Pipeline API，**不感知 runner**，更不做 runner 间路由。
2. **Pipeline 不可用 = fail fast**：当 Pipeline API 不可达、超时耗尽重试、或返回 5xx/`internal` 时，**直接判任务 failed，不静默切换到任何备用 runner**。失败任务按 §6.4.3 退款。绝不在生产把流量降级到 MLX。
3. **MLX 永不进生产**：MLX 仅是 Apple Silicon 本地实验 / 高保真验证 runner（模型试验、prompt 评估、离线 benchmark），不承担线上容量、不接生产流量、不作为故障 fallback。这是产品级硬约束，不是临时取舍。
4. **为什么不做自动 fallback**：成人内容平台的安全、计费与质量都依赖确定性的 runner 行为。静默切 runner 会让审核口径、成本倍率（`ModelProfile.costMultiplier`）与产物风格漂移，且故障被掩盖、难以排障。宁可 fail fast + 退款 + 告警，也不静默降级。
5. **真正需要扩容/容灾**时，由 Pipeline Service 在其内部做多节点/多实例的同 runner 水平扩展或排队，**对产品层透明**；产品层永远只依赖 Pipeline API 的稳定 contract。

#### 6.4.2 Provider 错误重试策略（决策）

> **决策：可重试性由 Pipeline 返回的结构化错误类别决定，service 据此映射为 `retryable: bool`，而不是靠 HTTP 状态码猜。**

- **契约**：Pipeline API 在错误时必须返回结构化错误体 `{ category, message, retryAfterMs? }`，`category` 取自 §6.4.4 错误码表。`packages/gen` adapter 把 `category` 映射为 `retryable`：
  - 可重试（transient）：`rate_limited`、`overloaded`、`timeout`、`internal`。
  - 终态（terminal）：`content_blocked`、`invalid_params`。
  - `partial_success` 不算错误，按 §6.4.3 部分结算。
- **退避**：指数退避 + jitter，`delay = min(base * 2^attempt, cap) * (0.5 + rand*0.5)`，建议 `base=2s`、`cap=60s`。`retryAfterMs` 存在时取 `max(退避值, retryAfterMs)`。
- **最大尝试**：`ai.image.generate` BullMQ `attempts=3`（即首跑 + 2 重试）。adapter 内部不再叠加重试（`PIPELINE_MAX_ATTEMPTS=1`），避免重试次数相乘放大 GPU 负载。
- **dead-letter**：超过 `attempts` 仍失败 → BullMQ 进 failed/死信，投递 `app.ai.finalize(generation.failed, errorCode)` 让主站退款并落 `GenerationJobEvent(failed)`，保留 `lastError` + payload 供 admin 重放（§6.8 Queue Controls）。
- **幂等**：所有重试共享同一 `generationJobId`，reserve/refund 按 `sourceId=jobId` 去重（ECONOMY §1.3），重试不会重复扣或重复退。
- **终态错误不重试**：`content_blocked` / `invalid_params` 直接终态 failed/blocked，不进退避循环。

#### 6.4.3 Provider 结果统一映射

| Provider 结果 | 系统处理 |
| --- | --- |
| 成功，返回 image bytes 或 asset URL | 写 blob，finalize completed |
| `rate_limited` / `overloaded` / `timeout` / `internal` | retryable error，按 §6.4.2 退避重试；超 attempts → failed + 退款 |
| `content_blocked` | terminal blocked，留 `ModerationEvent`，主站退款 |
| `invalid_params` | terminal failed，记录 provider error，主站退款 |
| `partial_success` | 按成功 asset 数 finalize，失败份额退款（ECONOMY §1.3 部分退）；前台展示 “已生成 N 张，已退还 M 张费用” |

#### 6.4.4 Pipeline API 错误码映射表

> Pipeline 返回 `category`，service 据此决定 HTTP 语义、是否重试、用户文案与退款行为。**这是 service ↔ Pipeline 的错误契约 SSoT。**

| category | HTTP-ish | retryable | 终态 | 用户可见文案（方向） | 退款行为 |
| --- | --- | --- | --- | --- | --- |
| `rate_limited` | 429 | ✅ | 重试耗尽才终态 | “服务繁忙，正在自动重试” | 仅重试耗尽后 failed → 全额退 |
| `overloaded` | 503 | ✅ | 同上 | “生成节点繁忙，正在重试” | 同上 |
| `timeout` | 504 | ✅ | 同上 | “生成超时，正在重试” | 同上 |
| `internal` | 500 | ✅ | 同上 | “出了点问题，正在重试” | 同上 |
| `content_blocked` | 422 | ❌ | 立即终态 `blocked` | 展示政策码 + 申诉入口，不复述违规 prompt（§8.1.2 policy code） | 全额退（用户无产出） |
| `invalid_params` | 400 | ❌ | 立即终态 `failed` | “参数有误，请调整后重试” | 全额退 |
| `partial_success` | 207 | — | 非错误 | “已生成 N 张，已退还 M 张费用” | 未产出份额按比例退（ECONOMY §1.3） |

错误码映射的单测见 §10.1（provider：retryable / terminal / timeout / partial）。

#### 6.4.5 卡死任务与任务级超时（决策）

> **决策：单次 provider 调用超时 ≠ 任务级超时。任何非终态 job 超过 `JOB_STALE_TIMEOUT_MS` 仍未到终态，由 reconciler 兜底判 failed + 退款，杜绝“币被永久 reserve、job 永远转圈”。**

- **两层超时**：`PIPELINE_TIMEOUT_MS`（默认 60s）管单次 provider 调用；`JOB_STALE_TIMEOUT_MS`（config，默认 10min）管整个 job 的墙钟寿命，覆盖 worker 进程崩溃、finalize 丢失、moderation 卡住等“无人推进”场景。
- **reconciler**：定时任务（cron / `media.cleanup` 同侧）扫描 `updatedAt` 超过 `JOB_STALE_TIMEOUT_MS` 的非终态 job → 投递 `app.ai.finalize(generation.failed, errorCode=stale_timeout)` → 主站退款 + 写 `GenerationJobEvent(failed)`。退款仍按 `sourceId=jobId` 幂等，与 worker 真完成赛跑也不会双退。
- 前端对停留过久的 job 展示“仍在处理”，到终态后按 `failed`/`refunded` 文案收敛。

### 6.5 BlobStore

首发应接 S3-compatible/R2/Vercel Blob 私有存储：

- gen worker 只 `putPrivate(key, bytes, contentType)`。
- main web 只 `signGetUrl(key, ttl)`。
- 浏览器只拿短时 GET URL。
- 删除先软删 DB，物理清理由 `media.cleanup` 后台任务处理。

**签名 URL TTL（决策）：**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `SIGNED_URL_TTL` | **15 min（900s）** | `GET /media/:id/download` 与 gallery 缩略图签名链接默认有效期；config 项，可后台调 |

- **TTL 取舍**：15 分钟足够下载/查看，又短到 URL 泄漏后很快失效。缩略图列表可用更短或同一 TTL，按需配置。
- **重新下载行为**：每次 `GET /media/:id/download` 都对**同一 asset（同 `storageKey`）重新签发新 URL**，不延长旧 URL，不改变底层对象。旧 URL 到期即失效，是预期行为。
- **防盗链**：bytes 走独立私有媒体域（07 §8），签名 URL 不可枚举（key 含随机段）、不进 public feed、不被 SSR 内联到 HTML 缓存；签发前在 service 层校验请求者对该 asset 的所有权（owner guard）。这些 URL 仅供持有者短时访问，不构成稳定外链。

### 6.6 生成方式决策：MLX、stable-diffusion.cpp 与 Pipeline Service

本项目的产品接口应固定为内部 Pipeline API，而不是让主站、Next route handler 或 `packages/gen` 直接加载模型。MLX 和 `stable-diffusion.cpp` 是 pipeline 内部 runner 选项，不是产品层 provider。

本地验证结论：`pornmasterZImage_turboV35Bf16.safetensors` 不是完整的
OpenAI-compatible model id，也不能直接作为 LocalAI `model` 字段使用。它是
Z-Image diffusion model，必须配套 Qwen3 4B text encoder 和 Flux/Z-Image
VAE。当前本地 smoke 通过 `serve:sdcpp-image` 把已验证的 `sd-cli` 命令包装成
Pipeline API；产品层只使用 `PIPELINE_API_URL` 和 `pornmaster-zimage-turbo`
alias。

| 选项 | 适合场景 | 不适合场景 | 本项目定位 |
| --- | --- | --- | --- |
| MLX | Apple Silicon 本地研发、Mac mini 验证节点、设计/模型实验、离线 benchmark | Linux GPU 生产集群、跨平台部署、统一运维和弹性扩容 | P1 实验 runner，不作为 P0 生产默认 |
| `stable-diffusion.cpp` | 自托管开源模型推理、GGUF/量化模型、Linux/Mac/Windows 多平台、CPU/CUDA/Vulkan/Metal 等后端 | 复杂工作流编排、多节点租户隔离、运营级 A/B 和审核闭环 | P0 生产 runner 首选，但必须包在 Pipeline Service 后面 |
| Python/ComfyUI 类工作流 | 多节点工作流、ControlNet/LoRA/IP-Adapter、复杂后处理、可视化调参 | 极简部署、低依赖二进制分发 | P1/P2 高级模型和复杂生成工作流候选 |

结论：

1. `packages/gen` 只实现 `PipelineImageModel` HTTP adapter，不引入 MLX 或 `stable-diffusion.cpp` runtime。
2. 内部 Pipeline Service 暴露稳定的 OpenAI-compatible `/images/generations` 风格接口，也可以补充内部 `/profiles/:id/generate` 接口。
3. Pipeline Service 内部先接 `stable-diffusion.cpp` runner，原因是它跨平台、依赖少、支持量化和多后端，生产运维比 MLX 更通用。
4. MLX 保留为本地 Apple Silicon 实验 runner，用于模型试验、prompt 评估和低成本开发验证，不承担线上容量。
5. 未来如果需要复杂 ControlNet/LoRA/角色一致性链路，可以在 Pipeline Service 内加入 ComfyUI/Python runner；产品 API 和主站数据模型不变。

参考依据：[Apple MLX](https://opensource.apple.com/projects/mlx/) 官方说明将 MLX 定位为面向 Apple Silicon 的机器学习框架；[MLX examples](https://github.com/ml-explore/mlx-examples) 包含 FLUX、Stable Diffusion/SDXL、Wan2.1 等示例。[`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp) 官方 README 说明它是基于 ggml 的 C/C++ diffusion 推理实现，支持 SD/SDXL/FLUX/Qwen Image 等模型、CPU/CUDA/Vulkan/Metal/OpenCL/SYCL 等后端；其 [quantization and GGUF 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/quantization_and_gguf.md) 说明了 GGUF 与量化权重形态。

### 6.7 适合 iDream 的生成流水线

推荐流水线分三层：

```text
Main Site / packages/gen
  -> PipelineImageModel HTTP adapter
  -> Internal Pipeline Service
     -> request normalization
     -> prompt compiler
     -> runner selection by model profile
     -> inference runner (stable-diffusion.cpp first; MLX/ComfyUI optional)
     -> image post-process / metadata
     -> return bytes or private staging asset
  -> gen worker writes private BlobStore
  -> app.ai.finalize
  -> main finalizer output moderation + MediaAsset release
```

职责边界：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Main Site | 用户、权益、价格、ledger、任务状态、审核结论、media 归属 | 加载模型、调 GPU、长时间生成 |
| `packages/gen` | 消费队列、调用 pipeline、写私有 blob、投递 finalize | 读写主站 DB、决定权益、释放媒体 |
| Pipeline Service | prompt 编译、runner 选择、模型推理、低层重试、性能指标 | 用户鉴权、dreamcoin、最终安全判定、图库权限 |
| Runner | 执行具体模型推理 | 产品策略、计费、安全政策 |

P0 输入给 Pipeline Service 的 payload 应包含：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `requestId` / `generationJobId` | 主站 | 排障和幂等关联 |
| `profileId` | `generation/config` + 服务端校验 | 后台发布的模型档位 |
| `promptBundle` | 主站根据模板版本编译，或 Pipeline Service 根据模板版本编译 | 包含 positive、negative、style、preset fragments |
| `orientation` / `width` / `height` | 后台 allowlist | 避免客户端任意尺寸打爆 GPU |
| `count` | 服务端校验 | P0 `1..4` |
| `seed` | 服务端生成 | 支持重现和客服排障 |
| `safetyContext` | 主站 | age gate、character status、policy hints，不含可被客户端伪造的 plan |

### 6.8 后台可配置项

需要管理后台。原因不是“方便改 prompt”，而是生成服务有成本、安全、权益和质量风险，必须有服务端可审计的控制面。

P0 至少管理：

| 配置 | 示例字段 | 发布规则 |
| --- | --- | --- |
| Model Profile | `id`、label、runner、base model、default size、steps、sampler、cost multiplier、entitlement、enabled | draft -> active，保留历史版本 |
| Prompt Template | character/freeplay 模板、style block、negative base、preset 拼接顺序、版本号 | 版本化，旧 job 保留 template version |
| Preset Library | background/pose/outfit、prompt fragment、safety tags、可见范围、是否 Premium | built-in 由 admin 发布，user/community 后续进审核 |
| Pricing | base cost、count multiplier、premium profile cost、refund policy | 发布前 dry-run，不能由客户端覆盖 |
| Feature Flags | video beta、image edit、community preset、public feed、model rollout percentage | 支持灰度、回滚 |
| Safety Thresholds | 非硬政策阈值、人工复核开关、blocked policy code 文案 | 硬政策不能被后台关闭 |
| Queue Controls | profile concurrency、暂停某 profile、重放 failed job、dead-letter 处理 | 高风险操作写审计 |

后台详情见 [ADMIN_CONSOLE_PLAN.md](./ADMIN_CONSOLE_PLAN.md)。

### 6.9 视频功能 stub 状态（决策）

> **决策：视频是“留位”的合同 + 付费门 + 骨架，但不是可用功能。用户侧 feature flag 默认 OFF。**

精确定义本轮视频的状态，避免“以为已上线”：

| 维度 | 状态 |
| --- | --- |
| API contract | **保留**：`mode=video` 在 schema 中合法，`/generation/config` 返回 `video.enabled=false` + `requiredEntitlement=video_generation`，但 `POST /generation/jobs` 对 video 在 flag OFF 时返回 402/403，不创建 job、不扣费。 |
| 付费门 | **保留**：`video_generation` entitlement 与定价（ECONOMY §1.1 = 100 币/视频）已定义，门控逻辑在位，不删。 |
| 队列 / worker | **stub**：`ai.video.generate` 队列与 `packages/gen` video worker 骨架存在，但只接 **`MockVideoModel`**（确定性假数据），不接真实 Pipeline video runner，不写真实 video 产物。 |
| 用户可见入口 | **feature flag OFF**：`/generate` 的 Video 仅展示 locked/beta 占位，不能提交真实任务（§4.2）。用户侧 flag 默认关闭。 |
| Admin 可见性 | **可见但只读配置态**：admin 能在后台看到 video 的 feature flag、定价、entitlement 配置项（§6.8 Feature Flags / Pricing），可在 flag 中切灰度开关，但 P0 不开放真实视频生成；开关打开前 worker 仍是 stub。 |

视频的真实生产化（真实 video runner、时长计费 `duration_mult`、视频专项安全审核）属 P1+（§3.4 非范围、§11 Phase 5）。

## 7. Frontend 实现

### 7.1 状态模型

`GeneratorWorkspace` 建议拆为：

| 组件 | 职责 |
| --- | --- |
| `GeneratorWorkspace` | 拉 config、jobs、media，管理顶层状态 |
| `GenerationComposer` | 角色、preset、prompt、advanced settings、cost preview |
| `CharacterPickerDialog` | 搜索角色、Freeplay、已创建角色 |
| `PresetPickerDialog` | built-in/user/community preset 分类展示 |
| `ActiveGenerationJobs` | queued/running/failed/blocked job cards |
| `MediaGallery` | Images/Liked 列表、分页、like/delete/download |
| `UpgradeGateDialog` | 权益不足时解释原因和升级入口 |

### 7.2 数据流

页面加载：

1. `GET /api/v1/generation/config`
2. `GET /api/v1/characters?limit=...`
3. `GET /api/v1/generation/jobs?status=active`
4. `GET /api/v1/media?type=image`

提交生成：

1. 前端本地校验必填项。
2. 前端展示 cost preview。
3. `POST /api/v1/generation/jobs`
4. 成功后插入 Active Jobs。
5. 每 1-2 秒轮询 job detail，完成后刷新 media。
6. 失败或 blocked 时停止轮询并展示行动项。

### 7.3 UX 文案规则

| 场景 | 文案方向 |
| --- | --- |
| 未选角色 | “Select a character or Freeplay first.” |
| 余额不足 | 展示当前余额、需要数量、升级/充值 CTA |
| Premium gate | 说明该控制项会提升可控性，但服务端需要 Premium |
| 输出审核中 | 说明图片通过安全检查后进入图库 |
| blocked | 不复述违规 prompt，展示政策代码和申诉/帮助入口 |
| failed | 区分 provider busy、参数错误、内容 blocked、未知错误 |
| refunded | 明确 refund amount 和余额更新 |

## 8. 安全、合规与运营

### 8.1 安全检查

图片生成至少两层审核：

1. **Input moderation**：检查 prompt、negative prompt、preset labels、角色 metadata。
2. **Output moderation**：检查 provider 产物，必须覆盖未成年人、真实人物深伪、非同意、违法内容和平台禁内容。

输出 blocked 时：

- 不创建可展示 `MediaAsset`。
- 写 `ModerationEvent`（schema 见 §8.1.2）。
- 写 `GenerationJobEvent(blocked)`。
- refund 对应 dreamcoin。
- 对高危内容进入 admin queue。

> 涉未成年素材的自动检测与法定上报由合规/法务侧独立负责，不在本设计范围；本服务只负责命中硬政策时拦截 + 留证 + 退款。

### 8.1.1 角色年龄门与生成依赖（决策）

生成入口受三道门约束，全部服务端判定，客户端不可绕（对齐 07 §2、§3.1）：

1. **角色 `age >= 18` 硬规则**：所有角色（公开 / 用户自建）`age` 字段强制 ≥ 18，创建时即校验（07 §3.3 CR-09）。"Teen" 等语义必须是 18+ young adult。生成时再次以 `safetyContext.character` 校验，age < 18 或缺失的角色**不可作为生成对象**，直接 422 `UNDERAGE`，不入队、不扣费。
2. **Freeplay vs 角色模式**：
   - 角色模式：受角色 age 门 + 角色 `safetyStatus`（必须 `approved`）约束；被举报/下架角色不可生成。
   - Freeplay 模式：无角色实体，但 prompt 仍走 input moderation，未成年情境直接 `UNDERAGE` blocked。Freeplay 不豁免任何硬政策。
3. **age gate + age verification 依赖**：
   - 进入 `/generate` 与提交生成都要求已过 **age gate**（18+ 确认，07 §2.2，`requireAgeGate`）。
   - 受限辖区要求 **age verification** 通过（07 §2.3，`requireAgeVerified`）；MVP 默认 `not_required` 直通，provider 暂缓但守卫保留。未通过受限辖区验证 → 阻断生成。
   - 详细政策正文以 `product/CONTENT_POLICY.md`（产品政策 SSoT）、07-security 与 `policy_versions`（Safety Center 镜像）为准；本服务不另立政策口径。

### 8.1.2 ModerationEvent schema 与 policy code 全集

> 与 07 §3/§4 对齐。每次输入/输出审核判定都写一条不可变 `ModerationEvent` 留证（append-only，不可改不可删）。

`ModerationEvent` 字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 事件 ID |
| `target` | 被审对象引用，如 `generation_job:{jobId}`、`media_asset:{assetId}`、`prompt:{jobId}` |
| `layer` | `input` \| `output`（对齐 07 五层；本服务主用这两层） |
| `status` | `passed` \| `flagged` \| `blocked` |
| `policyCode` | 命中政策码（见下表）；`passed` 时为空 |
| `confidence` | 0–1，分类器置信度 |
| `modelVersion` | 审核模型/规则版本，用于复盘口径漂移 |
| `createdAt` | 事件时间 |

policy code 取自 07 §4 同一份机器码集（稳定，贯穿 `ModerationEvent` / `moderation_reviews` / 拦截错误 `CONTENT_BLOCKED.details.policy`）。本表是 07 §4 中**本服务 input/output 审核会主动产出**的子集；`CSAM_HASH_MATCH` 等由合规/法务侧检测管线产生的码不在本服务范围（见 §8.1 范围说明），故不列入下表。

**硬政策（命中即 `blocked` + 留证，后台不可关闭）：**

| policyCode | 含义 |
| --- | --- |
| `UNDERAGE` | 未成年 / 未成年外观，命中即拦截 |
| `DEEPFAKE` | 真实人物深度伪造 |
| `REAL_PERSON_LIKENESS` | 真实人物肖像 |
| `IP_INFRINGEMENT` | 受版权 IP / 名人肖像 |
| `NON_CONSENT` | 非自愿框架 |
| `ILLEGAL` | 其他违法内容 |
| `EVASION_ATTEMPT` | 规避尝试（拼写变体、绕过提示词等） |
| `PROHIBITED_OTHER` | 其他平台禁内容 |
| `SELF_HARM` | 自残 / 自杀相关 |
| `VIOLENCE_EXTREME` | 极端暴力 |

**软政策（`flagged`，进人工复核 / 阈值可后台配，但不绕过硬政策）：**

| policyCode | 含义 |
| --- | --- |
| `SUGGESTIVE_REVIEW` | 边界暗示性内容，置信度不足以直接拦，转 human_review |

软政策阈值与人工复核开关可在后台 Safety Thresholds 调（§6.8），**硬政策不可被后台关闭**（07 §10）。`blocked` 一律退款（ECONOMY §1.3），`flagged` 进复核期间任务保持 `moderating_output`，复核结论再决定 release 或 blocked+refund。

### 8.2 观测指标

| 指标 | 用途 |
| --- | --- |
| `generation_started` | 漏斗入口 |
| `generation_queued` | 队列接受率 |
| `generation_completed` | 成功率 |
| `generation_failed` | provider 和系统错误 |
| `generation_blocked` | 安全策略命中 |
| `generation_refunded` | 资金收敛 |
| `media_liked` | 产物满意度 |
| `media_downloaded` | 高价值使用 |

运营看板至少要能按 model、provider error code、policy code、用户 plan、平均等待时间和成功率切分。

产品质量看板还应按 profile 追踪：

| 指标 | 用途 |
| --- | --- |
| `time_to_first_image` | 首次激活体验，目标 P50 ≤ 90s |
| `profile_success_rate` | 判断模型档位是否可作为默认或 Premium |
| `profile_refund_rate` | 发现不稳定或成本异常 profile |
| `profile_like_rate` / `download_rate` | 近似衡量用户满意度 |
| `upgrade_conversion_by_gate` | 判断 custom prompt、negative prompt、premium model 哪个 gate 最有效 |
| `partial_success_rate` | 发现 batch/count 或 provider 稳定性问题 |

### 8.3 限流

建议首发限流：

| 行为 | 限制 |
| --- | --- |
| `POST /generation/jobs` | user 级 10/min，IP 级兜底；`Idempotency-Key` 去重双击（§5.3 规则 8） |
| 每用户在途 job | `MAX_INFLIGHT_JOBS_PER_USER`（默认 3，§5.3 规则 9），超限 429 |
| `GET /generation/jobs/:id` | user 级 120/min |
| provider worker concurrency | 按 GPU 容量配置，不由 web 实例数决定 |
| failed retry | 同一原始 job 最多 3 次用户触发 retry |

## 9. 管理后台与产品配置

图片生成不是孤立功能，它会牵动订阅、权益、dreamcoin、preset、图库、安全和客服排障。管理后台应作为 iDream 的产品控制面，而不是只做审核队列。

P0 管理后台能力：

| 模块 | P0 能力 |
| --- | --- |
| Generation | 查看任务、失败原因、provider/profile、队列状态、退款状态；管理模型 profile、prompt 模板、built-in preset |
| Trust & Safety | 举报队列、审核决定、policy code、blocked media、申诉入口 |
| Users | 查询用户、状态、plan、entitlements、dreamcoin ledger、age gate/verification 状态 |
| Billing | 查看订阅、checkout、webhook、ledger；人工补偿只允许审计化操作 |
| Content | 角色审核、上下架、标签、公开/私有状态、媒体下架 |
| Product Config | feature flags、价格表、entitlement gate、文案/SEO 路由状态 |
| Ops | queue health、dead-letter、provider error rate、生成成功率、平均等待时长 |

P0 后台应先收敛到六个真实运营必需模块：Dashboard、Generation Jobs、Generation Config、Moderation Queue、Users/Billing、Audit Log。SEO/CMS、Feed/Community 管理、分析导出和双人审批可以放到 Public Launch 或 V1.1。

管理后台不应允许：

- 直接编辑 dreamcoin 余额，只能写 ledger adjustment。
- 关闭未成年/真实人物等硬政策。
- 查看或导出明文敏感 prompt/chat，除非有 support consent、法律流程或安全复核权限。
- 直接改生产密钥；密钥仍在 env/secret manager。

完整方案见 [ADMIN_CONSOLE_PLAN.md](./ADMIN_CONSOLE_PLAN.md)。

## 10. 测试计划

### 10.1 Unit

- pricing：mode、count、model 对 cost 的计算（费率 SSoT 在 ECONOMY §1）。
- schema：`generationJobSchema`、shared payload schema、unknown controls 拒绝；扁平 `negativePrompt`/`outputCount`/`freeplay`（§5.3）。
- entitlement：custom prompt、negative prompt、premium model、video gate。
- 提交幂等/并发：相同 `Idempotency-Key` 不双建（§5.3 规则 8）；在途上限达 `MAX_INFLIGHT_JOBS_PER_USER` 返回 429（规则 9）。
- ledger：reserve/refund idempotency，余额不透支。
- 卡死任务：reconciler 对超 `JOB_STALE_TIMEOUT_MS` 的非终态 job 判 failed+退款，与真完成不双退（§6.4.5）。
- provider：pipeline success、retryable error、terminal error、timeout。
- error mapping：Pipeline `category` → `retryable` 映射（§6.4.4）；终态码不进退避。
- 退避：exponential + jitter 计算、`retryAfterMs` 取大、attempts 封顶后 dead-letter。
- media DTO：private URL 不泄露 storage write key；签名 URL 含 TTL（§6.5）。
- moderation：`ModerationEvent` schema 字段完整；硬 policy code blocked + 退款，软码进复核。
- age gate：角色 age<18 / 缺失 → `UNDERAGE`，不入队不扣费（§8.1.1）。
- admin config：model profile / prompt template / feature flag 的发布、回滚、权限和审计。

### 10.2 Integration

- 创建图片任务返回 queued，不同步完成。
- worker 完成后 finalizer 创建 media，并更新 job completed。
- 余额不足返回 402 且没有 ledger 记录。
- 相同 `Idempotency-Key` 重复 POST 返回同一 job，不双扣（§5.3 规则 8）。
- 在途 job 达 `MAX_INFLIGHT_JOBS_PER_USER` 时再 POST 返回 429，不入队不 reserve（§5.3 规则 9）。
- worker 取出后 input moderation blocked → job=blocked，退款，不调用 provider（`moderating_input`，§6.3）。
- 卡死任务（非终态超 `JOB_STALE_TIMEOUT_MS`）被 reconciler 判 failed + 退款，且不与真完成双退（§6.4.5）。
- output moderation blocked 时不创建 media，并退款。
- retry provider-failed job 创建新 job 并按当前费率重新扣费，旧 job 事件链保留可见（§5.3.1）。
- retry blocked job 被拒绝（403），不创建新 job、不扣费。
- 重新下载同一 asset 每次签发新短时 URL，旧 URL 到期失效（§6.5）。
- duplicate finalize 不重复创建 media，不重复退款。
- 管理后台发布新模型 profile 后，`generation/config` 返回新 profile，旧 job 保留旧 template/profile version。
- 非 admin 无法访问生成配置、审核队列、用户 ledger 和 requeue 操作。

### 10.3 E2E

浏览器关键流：

1. 接受 age gate。
2. 登录或注册。
3. 进入 `/generate`。
4. 选择角色。
5. 查看 cost preview。
6. 提交图片生成。
7. Active Jobs 显示 queued/running。
8. 完成后图片进入 Images。
9. Like、Download、Delete 均可用。

覆盖桌面和移动 viewport。移动端必须验证底部 Generate CTA 不遮挡内容。

### 10.4 命令

实现完成后至少运行：

```bash
bun run lint
bun run typecheck
bun run test
bun run check
bun run --filter @idream/gen test
```

如涉及 Postgres-only 并发或队列 claim 路径，再运行：

```bash
DB_PROVIDER=postgresql bun run --filter @idream/main test:postgres
```

## 11. 分期计划

### Phase 1：异步任务闭环

- 移除请求内 `drainLocalAiPipeline`。
- `POST /generation/jobs` 返回 queued。
- 新增 job list/detail events。
- 前端 Active Jobs 可恢复。
- mock provider 下完整通过测试。

### Phase 2：真实图片 provider

- `packages/gen` 接 `PipelineImageModel`。
- 接私有 BlobStore。
- finalizer 用 storage key 创建 media。
- 增加 provider error mapping。
- 跑通真实图片从生成到图库。
- 内部 Pipeline Service 先接 `stable-diffusion.cpp` runner；MLX 只作为实验 runner。

### Phase 3：工作台产品化

- 重构 `/generate` composer、active jobs、gallery。
- 接 `generation/config`。
- 完整 cost preview、Premium gate、失败/退款解释。
- 移动端布局验证。
- 增加 generation admin 配置页：model profile、prompt template、built-in preset、feature flag。

### Phase 4：安全与运营硬化

- 接真实多模态 output moderation。
- 增加限流、队列积压指标、provider 成功率看板。
- 增加 dead-letter/reconciler runbook。
- 输出客服可读 job timeline。
- Admin 支持暂停 profile、重放 dead-letter、查看 job event timeline 和审计记录。

### Phase 5：P1 扩展

- 用户 preset CRUD 深化。
- Gallery bulk manage 和 collections。
- Remix into Generate。
- 视频 beta 开关。
- 公共分享和 feed 发布。

## 12. 验收标准

P0 完成必须同时满足：

- 免费用户可以用角色或 Freeplay 完成基础图片生成。
- Premium 用户可以使用 custom prompt 和 negative prompt。
- 余额不足、权益不足、安全 blocked、provider failed 都有清晰 UI。
- 生成任务刷新页面后仍可恢复状态。
- 成功产物进入 Images gallery，可 like、download、delete。
- 部分成功时展示成功张数、退款张数和最终扣费。
- dreamcoin ledger 可重算余额，失败/blocked 可重入退款。
- web route handler 不执行长生成任务。
- gen worker 不读写主站 DB。
- 所有媒体字节走私有 blob，浏览器只拿 signed URL。
- 测试覆盖成功、失败、blocked、refund、retry、duplicate finalize。
- Admin 可以配置并发布模型 profile / prompt template / built-in preset，变更有审计和回滚路径。
- Admin 可以排查单个 generation job 的 queue、provider、moderation、ledger、media timeline。
- 首次生成路径有明确免费激活策略，且用户能在提交前看到余额、成本和不足 CTA。

## 13. 关键假设

- Pipeline API 是内部 HTTP 服务，具备服务端 token、超时和**结构化错误类别**（§6.4.4）；生产 runner 首选 `stable-diffusion.cpp`，但产品层只依赖 Pipeline API。
- MLX 用于 Apple Silicon 本地实验、模型评估和高保真验证，**永不进生产、不作为故障 fallback**（§6.4.1）。Pipeline 不可用时 fail fast + 退款，不静默降级。
- 重试可重试性由 Pipeline `category` 决定（service 映射 `retryable`）；BullMQ `attempts=3`、指数退避 + jitter，超限进死信（§6.4.2）。
- 签名 URL 默认 `SIGNED_URL_TTL=15min`，重新下载重新签发新短时 URL（§6.5）。
- retry 仅适用 provider-failed 任务且按当前费率重新扣费；blocked 任务不可 retry（§5.3.1）。
- 余额预留竞态已在 ECONOMY §1.3 定稿（POST 事务内原子 reserve），本服务不重新设计。
- 首发图片数量限制为 `1..4`，不支持 256 张批量生成。
- 首发媒体默认 private，不进入公开 feed。
- 视频生成保留合同和付费门，但默认关闭可用入口。
- 年龄验证和真实支付仍是面向真实用户上线前硬门，不能因为图片 pipeline 接通而跳过。（涉未成年素材的检测/上报由合规/法务侧负责，不在本设计范围。）
- 管理后台是 P0 内部能力，至少覆盖 generation config、审核队列、用户/ledger 查询和队列排障。

## 14. 相关文档与代码入口

- `docs/product/PRD.md`
- `docs/product/BackendFeatureSpec.md`
- `docs/product/ADMIN_CONSOLE_PLAN.md`
- `docs/product/UserStory.md`
- `docs/research/SERVICE_INTEGRATION.md`
- `docs/architecture/06-async-jobs-and-ai.md`
- `docs/architecture/08-billing-and-entitlements.md`
- `packages/main/src/server/modules/ourdream/service.ts`
- `packages/main/src/components/ourdream/GeneratorWorkspace.tsx`
- `packages/main/src/server/ai/local-pipeline.ts`
- `packages/main/src/processes/finalizer.ts`
- `packages/gen/src/pipeline.ts`
- `packages/gen/src/providers.ts`
