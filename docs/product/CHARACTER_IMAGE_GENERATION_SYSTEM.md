# 角色图片生成：身份、时刻与交付

更新日期：2026-10-04

本文定义角色图片的完整目标与验收，关联 [PRD](PRD.md) CR-01–09、GN-01–19、CH-06/07。当前实施和实际质量见 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)，待办见 [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)。这里不维护模型选型、schema/API 草案或历史实施路线。

## 1. 产品承诺

用户每次看到的是同一个角色，只是场景、服装、动作和情绪发生变化。角色身份由系统负责，用户主要描述“想看什么时刻”；漂亮但像另一个人的结果仍是身份失败。

Character 与 Freeplay 是完整的两类图片任务：Character 复用角色身份，Freeplay 按独立主体/意图生成，不强加角色、关系或视觉档案。公开与私有角色分别按访问资格使用，既定审核与角色年龄 ≥18 保持不变。

| 一致性维度 | 应保持 | 用户可以改变 |
|---|---|---|
| 面部与身体身份 | 脸部结构、肤色、体型、年龄感 | 表情、朝向、姿势和镜头 |
| 标志特征 | 发型特征、痣、纹身、眼镜等识别点 | 明确的造型变化或遮挡 |
| 基础风格 | 角色确认的写实/动漫等身份风格 | 已支持的摄影、构图和表现方式 |
| 连续性 | 已确认的衣着、地点、人物和道具 | 用户明确要求改变的部分 |

一次性换装、换场景与永久身份变更分开。永久修改身份需明确确认并创建新版本；固定 seed、长 prompt 或单一人脸分数不能替代完整一致性。

## 2. 用户对象与权威

| 对象 | 作用与边界 |
|---|---|
| Visual Identity / CharacterVisualProfile | 结构化外观、身份 anchor 与基础风格的版本快照，身份 prompt 是派生产物；已使用版本不可原地改写 |
| Reference Set | 经确认的参考图集合与不可变 revision；候选经基础检查与选择后显式提升，不由 Like 自动加入 |
| Look | 可命名、保存和复用的服装/妆容/配饰变化，不覆盖脸部与身体身份；切换身份后校验兼容，冲突要求确认 |
| Moment | 本次场景、动作、情绪、衣着、镜头和连续性来源；保留用户原意和来源，历史剧情与图片专属覆盖分开 |
| 生成结果与反馈 | 产物、角色、来源任务与实际生成快照可追溯；喜欢、像/不像、意图不符、坏图和变化不足是不同信号 |

Main 持有身份、Release、Scene、附件、生成请求、报价、交付和结算；Chat 提供当轮方向与角色表达；Gen 按 workflow-native backend 执行。新请求固定身份/reference revision、source、accepted brief、profile/workflow/version、实际输入和报价，执行与重试不随当前 active/default 漂移。

必需 source 与 identity reference 按 workflow 的语义角色、数量和权限精确绑定；缺失、不兼容或歧义在接纳前拒绝，不能静默丢图降级。Prompt 必须保留已接受的关键方向，过长时明确拒绝，不能截断尾部衣着或场景要求。格式/来源合法与传输无损不代表语义已理解。

具体执行与版本契约见 [Chat PRD](CHAT_SERVICE_PRD.md)、[ADR-21](../architecture/21-companion-chat-deep-runtime.md)、[Gen workflow 契约](../../packages/shared/src/gen/workflow.ts) 与 [Gen 运行说明](../../packages/gen/README.md)。

## 3. 各入口的完整体验

| 入口 | 用户动作与结果 |
|---|---|
| Create | 在完整六步创建的 Image 步探索、刷新和选择视觉候选；失败保留草稿与人格/外观输入，明确选择后建立身份，私有保存可立即聊天 |
| Character Detail | 展示符合身份的主图和精选场景图，可启动 Chat、生成另一个时刻或复用场景；官方推荐不能使用未确认身份或不合格素材 |
| Chat | 自然语言请求、相机动作或确认角色邀约；Main 接受后在原回复显示状态，一张结果回到原消息及 Gallery，生成不阻塞继续聊天，失败可就地恢复 |
| Generate | 先选 Character/Freeplay，再描述 Moment、选择 Look、画幅和数量，接受价格与等待估计；提供内置/My/Community/Custom 的背景、姿势、服装 preset与独立 Image Edit |
| Advanced | 按 entitlement 提供 Custom/Negative Prompt、合格模型/风格、seed 等控制；默认角色路径不要求用户理解模型、权重或版本 |
| Gallery | 搜索、按角色/类型/时间/喜欢/可见性筛选，收藏、下载、删除、批量管理与继续创作；权限和可见性变化即时生效，刷新不丢结果 |
| Admin | 逐张生成、检查与采用角色素材，只有明确 Publish 才改变 Serving；身份、sealed references、兼容 route 和 Release lineage分别可核查 |

Create 的多个候选应是同一身份家族。若只有独立文生图探索，必须如实标为外观探索，确认 anchor 后再承诺身份复用；不能把随机首图静默设为稳定身份。身份可用后参考包可异步补齐正面、侧向、半身/全身角度，失败明确降级并可重试，不阻塞聊天。

官方资产的 Primary portrait、Character hero 与 Chat moments 生产、草稿采用和一次发布见 [Asset Studio 操作](CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md) 与 [发布权威 ADR](../architecture/16-character-asset-studio-authority.md)。客户候选探索与运营每次一张是不同任务；不另设角色人工发布 QA 或定时发布关卡。

### 后续动作不能混淆

| 动作 | 结果 |
|---|---|
| 再来一张 | 保留同一 Moment/身份，变化镜头、表情或 seed |
| 保持人物，换场景 / Image Edit | 固定 source 与身份，明确只改哪些内容、哪些要保持 |
| Enhance | 使用独立增强契约，保留 source、接受的增强方向、报价与结果 lineage |
| Like / 收藏 | 审美偏好，不自动改变身份或参考集 |
| 像她 / 不像她 | 独立身份反馈；不像的结果不作为身份参考，提供低摩擦纠正/重试 |
| 设为展示头像 | 只更换主图展示，限有权修改角色的人，不默认为替换身份 anchor |
| 替换身份 / 加入 identity references | 明确确认，校验权限和质量，生成身份版本或 reference revision；历史任务仍用原快照 |
| Save as Look / More like this | 保存稳定造型，或以 source 延续构图/造型，不默认为永久身份变化 |

反馈可撤回或修改并保持幂等，正负反馈与后续重试可追溯。Gallery 应能区分 Moments、Looks、Identity 与普通 Liked；旧 Look 不兼容新身份时不能自动覆盖身份。

## 4. 图片与视频的边界

Create Image、Image Edit、Enhance 与 reference-guided generation 分别固定 source、accepted brief、参考/provenance、报价和结果 lineage，不能因复用 worker 而合并用户承诺。

Video 是完整目标，按独立能力开放：Generate I2V 使用有权访问且满足已发布配方的 Character，不自动外推 Freeplay；GN-19 的多 scene、时长、比例、质量档和可选 AI voice/audio分别提供控制与验收，视频字段不显示不适用的 Pose。Chat Animate 绑定已交付图片和原 Turn/attempt；自然语言视频动作另需显式 Chat capability。图片成功不能代替视频身份、动作、场景、音频或序列合成资格。

关闭新视频能力不删除已有视频的查看、播放和下载；已有结果继续按原权限访问。具体目标见 PRD GN-01/02/05/19 与 Chat PRD。

## 5. 状态、失败与费用

| 用户状态 | 必须呈现与可执行动作 |
|---|---|
| 草稿/候选未就绪 | 缺什么、已完成哪些候选；保留输入，选择可用项或补生成 |
| queued/running | 已接受、排队或执行中；可以离开/继续聊天并恢复，不伪报完成 |
| 质量检查/有界重试 | 如实说明仍在检查或补生成，未评分维度不宣称通过 |
| completed/partial/degraded | 展示实际交付和数量、未满足部分与费用；多张部分成功可补缺失项 |
| failed/blocked/未知结果 | 错误类别、接受/扣减/退款事实和可执行恢复，不诱导重复创建已接受请求 |
| cancel requested/cancelled | 仅按服务端资格开放取消；接受后不被迟到 provider 改回成功 |

退款和附件状态都来自 Main，不由 Chat、Gallery 或客户端猜测。Main 已交付后不能再把任务取消；删除已交付资产不自动退款。移动端主动作可见、无横向滚动，状态变化可被辅助技术读取，操作可键盘到达且异步更新不丢焦点。

| 失败类别 | 处理目标 |
|---|---|
| Infrastructure | 有界自动重试；终态失败释放/退款，不交付空结果 |
| Artifact | 文件、尺寸、空白、坏脸/肢体、文字或主体数量不合格时淘汰/补生成，不让坏图算成功交付 |
| Identity | 身份低于门槛时提供一次免费系统重试；反复失败可暂停/回退该 route，不污染参考集 |
| Intent | 场景、动作或衣着不符独立标记，保留可用结果并提供纠正重试；是否退款按接受条款，不混成 provider failure |

生成前按既定政策、权益、quote 和余额接纳，固定费用上限；用户按看到的产品单位付费，内部候选不另收费。成功由 Main 唯一结算，失败/拦截/已接受取消按同一权威流程释放或退款；重放、免费质量重试、迟到结果不能二次扣减。价格和账务规则见 [经济契约](ECONOMY_AND_PRICING.md)。

## 6. 目标与验收

以下是有效产品目标，不是当前实现或全绿声明；具体待办由剩余工作统一管理。

| 范围 | 必须完成的用户结果 | 需求依据 |
|---|---|---|
| P0 身份与可靠交付 | Create确认身份；Chat/Generate复用同一身份与上下文；异步状态、原消息恢复、quote、交付和唯一结算闭合 | CR-03–05/08、CH-06/07、GN-08/11–13/15/16 |
| P1 可控与复用 | 参考候选/revision、跨入口反馈、身份更新/回退、Look与场景连续性、preset、编辑/Enhance和reference引导完整可用 | CR-06、GN-03/04/06/07/10/14/17/18 |
| Video完整目标 | Generate序列与Chat视频分别开放控制、交付、恢复和质量；单个短片不代表完整GN-19 | CH-07、GN-01/02/05/19 |

### 质量与性能目标

| 目标 | 验收口径 |
|---|---|
| 人工 Identity Match ≥90% | 按写实/动漫与近景、半身、全身、侧脸、强/弱光、换装、复杂背景分层；80–89%仅内部候选，不进入默认角色路径 |
| 身份参考质量 | 初始基线为单主体、脸部有效区域≥160px、无遮挡/严重压缩，artifact和人工identity通过；按风格/镜头校准 |
| 多候选同族通过率≥90% | 初始至少20组可比较候选，明确是否为外观探索，不把独立随机图算身份一致 |
| 技术质量矩阵 | 初始目标至少40张覆盖代表场景，分别报告身份、artifact和intent；它不构成每次角色Publish的人工关卡 |
| Chat等待 P50≤45s、P95≤120s | 测排队到原消息实际交付；超出显示延迟并保留任务，不静默失败 |
| Generate等待 P50≤90s、P95≤240s | 测接受到实际交付，离页与刷新可恢复；规格、冷热和容量条件明确 |
| 补生成有界、费用不变 | 初始最多一次自动质量重试；未评分单列，不能把不可用evaluator算identity通过；有限失败仍有明确终态 |

生成质量分别判断文件/artifact、身份与意图，不能用一个黑盒总分。参考选择按脸、身体/角度、Look、source角色和质量选择，不永远取数组前几张；route必须证明所承诺控制真实生效。新版本需独立质量与容量证据，出现连续身份失败时可暂停/回退而不改写历史任务。

结果指标关注首张有效图、身份命中、图片后继续聊天/创作、资产复用、付费生成留存，以及identity/intent/artifact各自失败率。未反馈不当人工通过，未评分单列；等待、队列、每交付单位真实成本、补生成、退款与版本事故同时记录。成本使用实际算力与扣除退款/费用后的收入，不把生成次数当价值证明。

每次验收记录用户任务、接受的identity/reference/source/brief/quote、实际provider/workflow与版本、Request/Attempt/Artifact/Delivery/Settlement、耗时和真实扣减/退款。检查原消息/Gallery交付、播放/下载、刷新、重试/取消和持久化，并另判像素身份、衣着/场景、指定修改与连续性。能力声明、schema合法、有效文件或唯一扣费不能替代质量与完整用户结果。
