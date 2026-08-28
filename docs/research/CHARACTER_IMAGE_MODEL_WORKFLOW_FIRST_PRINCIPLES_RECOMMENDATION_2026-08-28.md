# iDream 角色生图：模型与工作流第一性原理选型

> 核验日期：2026-08-28
>
> 范围：核验 iDream 角色资产权威、当前代码/数据库/本机运行态、历史受控实测，以及外部模型的精确版本、工作流依赖、许可与 Apple/MPS 可行性；不下载权重，不做新的实图生成。
>
> 证据优先级：官方模型卡 / 官方仓库与许可证 > Civitai 精确 model/version API > 作者工作流与样图元数据。作者精选图只证明“能出过”，不证明身份稳定率、失败率或生产吞吐。
>
> 2026-08-28 产品决策：Dark Beast FLUX.2 Klein 9B `2740209` 已移出 iDream 的运行时模型与后续资格赛；下文保留它的历史实测与许可证据，但不再把它当候选。

## 结论先行

**iDream 不该选择一个 checkpoint 包办所有角色图片。** “成人画面能力”和“同一角色身份不漂移”是两种不同能力；T2I checkpoint 负责创造场景与身体/画面先验，reference-edit 或 character LoRA 负责锁身份。把二者混成一个“最强模型”指标，会稳定地产生漂亮但不是同一个人的图片。

从外部事实出发，最合理的是四条分工明确的路线：

1. **角色首次建档 / 视觉探索（T2I）**：首选 **RedCraft Krea2 `3139241` 的 FP8 文件 `3019490`**。它有成人样图和明确的 8–12 steps 配方，Civitai 作者权限包含站外收费生成的 `Rent`，也有适合 Apple/MPS 首测的 FP8 变体。它仍然只是 T2I，不能单独承担角色保持。
2. **单角色参考图换装、换背景、换姿势（reference edit）**：首选做生产候选的是 **RedCraft `3139241` + Krea 2 Identity Edit v1.2 `3139172` + `comfyui-krea2edit`**。两条条件链必须同时存在：VAE reference latent 保外观、Qwen3-VL grounded encode 保语义身份。这一组合在结构与许可上可以成立，但没有作者提供的精确成人同跑证明，必须通过 iDream 自己的受控 A/B 才能上线。
3. **多人 / 两个不同角色同框**：以 **官方 Qwen-Image-Edit-2511** 做质量与身份分离基线。官方直接支持多图输入，并明确把 multi-person consistency 列为 2511 的改进点；Krea Identity Edit 作者则诚实标注两人脸仍可能互相漂移。当前 Rapid-AIO v19 可以作为成人少步候选，但不能替代官方 2511 的 40-step 诊断基线。
4. **一个角色需要长期、大批量、多场景复用**：训练角色自己的 **Krea 2 character LoRA**，遵循官方 **Raw 训练、Turbo 推理**。角色 LoRA 是身份资产，不是全局默认；多人场景仍应回到 reference composition / 分角色两阶段流程，避免身份向其他人物泄漏。

候选中不应进入默认生产路线的有：

- **Lustify v10 `3112728`**：成人女性写真 T2I 很有针对性，但 checkpoint 没有身份输入；作者工作流 `3159388` 仍依赖外部 Identity Edit。更关键的是 Civitai 权限只有 `Image + RentCivit`，没有站外收费生成所需的 `Rent`。适合内部资产制作/隔离 A/B，不适合当前直接开放给付费用户。
- **Muse v3.0 Extended Turbo Edit `3200345`**：这是 Muse 系列中真正烘入 Identity Edit 的版本，不是 v3.5 `3258954`。它的集成变量最少，但 Civitai 只给 `RentCivit`，且精确文件只有 INT8；对 Apple MPS 和站外付费服务都不合适。适合 NVIDIA 研究环境做能力上限对照。
- **Moody Krea 2 Mix V7 `3209007`**：NSFW T2I 证据充分，但作者 graph 是 `EmptyLatentImage` 起步，没有人物参考路径。它可以加载角色 LoRA 或外部 Identity Edit，却没有站外 `Rent`，也不是当前项目优先路线。
- **Dark Beast FLUX.2 Klein 9B `2740209`**：已从产品与资格赛移除。历史证据显示它支持统一 T2I/参考编辑，但上游 9B 的非商业许可、双参考槽位语义错误和无显著速度收益都不值得继续维护该路线。
- **Dark Beast Krea2 `3078453`**：是强成人 T2I 候选，不是身份模型。它可与 Identity Edit 组合且 Civitai 权限包含 `Rent`，但 checkpoint prior 更激进，更容易与 identity prior 竞争；应排在 RedCraft 之后做压力测试，不应先设默认。

没有查到名为 **BlackBurst** 的精确 Krea 2 checkpoint，不能把近似名称当版本事实。若用户所指是 Dark Beast / 黑兽，则本报告按 `3078453` 评估；如果是另一个模型，必须拿到精确 URL 或 `modelVersionId` 后再进入资格赛。

## iDream 当前事实：这不是从空白开始的模型投票

### 产品权威与生成模型的真实职责

iDream 已经有一条正确的角色资产权威链：

```text
CharacterVisualProfile
  -> sealed ReferenceSetRevision
  -> GenerationJob（固定 profile/workflow/seed/reference manifest）
  -> review
  -> draft asset pack（portrait / hero / chat）
  -> immutable Release
  -> Serving
```

这意味着模型不是“角色是谁”的最终权威。模型只能消费一版不可变参考集，产出候选资产；人工 review、Release 和 Serving 才决定用户实际看到什么。工作流 descriptor 还必须声明它接受哪些 reference role、最多消费几张参考图；不能完整消费 manifest 时应 fail closed，而不是静默少喂图。

因此本次选型必须分别回答四个问题：

1. 没有参考图时，哪个 T2I 模型适合探索角色外观；
2. 已有身份参考时，哪个 graph 真正把 `identity_image` 当身份，而不是服装或构图素材；
3. 两个不同角色同框时，哪个 graph 能保持角色与槽位语义；
4. 角色批准后，如何以可追溯方式规模化，而不是不断链式编辑造成漂移。

### 2026-08-28 的实际代码、数据库与运行态

| 层 | 当前事实 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| ComfyUI | `0.33.0`、Python 3.13.12、PyTorch 2.10.0、Apple MPS、128 GiB unified memory；监听 `127.0.0.1:8188` | 本机 backend 在线 | 候选身份质量合格 |
| Gen worker | 两个 Bun `gen-image` worker 在线，backend 指向本机 ComfyUI | 执行链存在 | profile 有真实资格数据 |
| 模型资产 | 已有 RedCraft Krea2 RedMix3 FP8、Qwen Rapid-AIO v19 FP8；Dark Beast FLUX2 Klein 9B 权重仍是未删除的本机历史资产 | 两条当前路线可在本机装载 | Krea2 Identity Edit 路线已可运行 |
| 节点 | 有 Qwen Image Edit / ReferenceLatent 路径；没有 `Krea2EditModelPatch`、`Krea2EditGroundedEncode`、`Krea2RedNode` | 现有 descriptor 与节点基本闭合 | 当前已经具备 Krea2 身份编辑能力 |
| 预检 | `packages/gen` 的 `bun run preflight`：7 descriptors、42 node types、13 model refs、10 pinned model bytes，0 problems | 删除 Dark Beast descriptor 后，剩余文件和节点引用闭合 | graph 的 reference role 语义正确 |
| 默认/高级 T2I | `profile_image_default_v1@2` 与 `profile_image_premium_v1@2` 都是 RedCraft T2I、100% active、`identity.mode=none` | RedCraft 是当前 bootstrap 路线 | 它能保持人物 |
| 角色变体 | Qwen v19 multi-reference 与 Qwen multi-identity 保留；Dark Beast Klein explicit-only 已从源码移除 | 产品仍有 Qwen 多参考入口 | 任一入口已通过真正 identity + source 验收 |
| Chat 单图编辑 | Qwen v19 single-reference active | 可保留为运营逐图复核的 fallback | 已达到自动身份合格；当前记录仍是 `dryRun=not_run` |
| route qualification | 当前角色相关记录没有完整真实样本集；关键记录出现 `sampleCount=0/passCount=0` 但 identityMatch 写 1 | 路由层允许运营复核兜底 | 模型达到 90% 或 95% identity pass |

仓库仍有需要按发布流程收口的漂移：seed 源码已切到 RedCraft FP8，但数据库还保留旧 BF16 比较元数据与 `/tmp` 路径；Dark Beast descriptor、seed、probe 和产品选项已删除，既有数据库 Profile 的归档迁移已产出但尚未执行；本机权重与历史研究证据刻意保留。部分文档记录 ComfyUI 0.28，实际运行的是 0.33.0。它们不妨碍本轮判断，却说明不能把文档、seed、数据库和运行进程中的任意一层单独当事实。

### 已有真实 A/B 推翻了当前双参考语义

2026-07-27 的 14 次真实生成使用了两张**身份和场景都明显不同**的图，而不是过去冒烟测试中两张字节相同的图。结果是：

- Qwen Rapid-AIO v19 始终保留 source 图的人脸和场景，只把 identity 图的服装/风格迁移过去；换 sampler 没有改变行为；
- Dark Beast Klein 9B 从 identity 图拿全身构图和场景、从 source 图拿脸；交换两个输入槽后结果基本不变；
- Klein graph 的两图都只经 `VAEEncode -> ReferenceLatent` 对称加入 conditioning，source 没有作为 init latent，因此 descriptor 声明的 `identity_image/source_image` 不是 graph 的真实语义；
- 历史热态延迟 Qwen 约 132–138 秒、Klein 约 129 秒，换模型没有获得有意义的热态速度优势。该数据来自旧 BF16 Qwen 配置，只能用于解释这次受控 A/B，不能当今天 FP8 路线的性能基准。

这份证据优先级高于模型页的“支持多参考”和旧人工通过记录。结论不是 Qwen 或 FLUX 架构永远不能保持人物，而是：**iDream 当前这两张 graph 不能继续被称作已验证的 identity + source 生产路线。** 当前单图 Qwen fallback 与双参考失败也必须分开评价，不能用其中一个替另一个背书。

现有 RedCraft 20 张近景 contact sheet 同样只能说明 T2I 画风和成人画面可用；固定 seed、相近构图下仍能肉眼看到多张不同脸，不能把“20/20 consistency”继续解释为人物身份资格。

### 基于当前事实的最终决策

1. **继续用 RedCraft FP8 做 bootstrap，但把能力标签收窄为 T2I。** 它适合创建第一批候选视觉，不承担“同一角色”的承诺。
2. **把 RedCraft + Identity Edit v1.2 full + pinned `comfyui-krea2edit` 作为下一条隔离生产候选，不直接切默认。** 当前本机缺节点和 LoRA，这条路线尚未运行；它必须先证明成人画面与 SFW 训练的 identity layer 能同时成立。
3. **当前 Qwen v19 双参考降为实验控制组。** 单参考 Chat 编辑可以继续作为每图必审的运营 fallback，但 `dryRun=not_run` 和零样本资格记录意味着它也不能获得自动生产身份认证。
4. **官方 Qwen-Image-Edit-2511 40-step 是多人/多参考的诊断金标准，不是低延迟默认。** 先用它区分 graph 绑定问题与 Rapid-AIO 蒸馏/merge 问题。
5. **角色正式批准且生成量上升后，训练版本化的 character LoRA。** LoRA 必须记录训练所用 `ReferenceSetRevision`、数据 manifest、底模 revision、权重 hash 和回归结果；推理遵循 Raw 训练、Turbo 使用。
6. **Mage-Flow-Edit Turbo 只做低延迟预览/聊天轻编辑候选。** 本机历史实测成人热跑中位数约 9.8 秒，明显快于当时 Qwen，但身份和身体比例保持较弱；它不进入 portrait/hero/Release 的身份权威路线。

在新的资格赛通过前，最诚实的产品状态是：**bootstrap 已可用；单图参考编辑可运营复核；通用双参考身份保持尚未生产闭环；多人保持仍在候选验证阶段。**

## 1. 第一性原理：模型必须满足什么

对“角色生图”，可见的最终质量至少是六项乘积，而不是一项平均分：

\[
Q = I \times A \times P \times C \times R \times L
\]

- `I`（Identity）：脸型、五官比例、发型、肤色、体型、标志物跨图一致；
- `A`（Adult capability）：明确成年虚构角色的身体、互动与场景能按指令生成；
- `P`（Prompt adherence）：服装、姿态、镜头、人物关系、遮挡和背景满足要求；
- `C`（Composition）：单人、双人、多人时人物不串脸、不复制、不属性泄漏；
- `R`（Runtime）：目标硬件能稳定运行，冷/热切模成本、内存与延迟可接受；
- `L`（License）：基础模型、merge、LoRA、节点和在线服务权限全部成立。

这是乘法关系：任何一项接近零，漂亮样图都不能成为产品路线。由此得到三个硬结论：

1. **T2I 不等于角色保持。** 固定 seed、复述外貌 prompt 或上传参考图但不进入训练匹配的 conditioning graph，都不能当身份锁。
2. **reference edit 不等于多人身份。** 单人相似度高，不代表两个角色同框不会串脸；多人必须单列验收。
3. **Civitai 的作者权限不能覆盖上游许可证。** merge 的每一层都要满足；最严格的上游约束会继续生效。

## 2. 精确候选矩阵

| 候选 | 精确版本与形态 | T2I | 参考图 / 多人 | 成人专项证据 | Apple/MPS | 站外付费服务 | 外部结论 |
|---|---|---:|---|---|---|---|---|
| **Qwen-Image-Edit-2511 官方** | `Qwen/Qwen-Image-Edit-2511`，20B BF16，Apache-2.0 | 非主要职责 | 官方示例直接传两张图；明确改进角色与多人一致性 | 非成人专项 | HF 页面有 MPS 提示，但无 Apple 性能基准；20B BF16 成本高 | **允许**（Apache-2.0） | 多参考、多人身份的干净质量基线；40 steps，不是低延迟默认 |
| **Qwen Rapid-AIO NSFW v19** | `v19/Qwen-Rapid-AIO-NSFW-v19.safetensors`，26.48 GiB FP8，SHA `BA7157…E5AC`；4–8 steps | 是，可无图 T2I | 作者修订节点支持最多 4 图；v19 被作者称为编辑一致性较好；iDream 实测当前双参考 graph 不具备声明的 role 语义 | 明确 NSFW merge，含 GNASS 等 LoRA | 当前 FP8 已能在本机 MPS 运行；仍无上游统一 Mac benchmark | **待 provenance 审核** | 单图成人编辑 fallback / 双参考实验控制组；不能继续把作者宣称的多图能力当作本项目已验证身份路线 |
| **RedCraft Krea2** | model `958009` / version **`3139241`**；首选 FP8 file **`3019490`**，SHA `F608…09EA` | **是** | checkpoint 本身没有；可外接 `3139172`，精确组合未由作者验证 | 版本有 level-16 样图；作者写明 no mosaics | **FP8 是 Mac 首测优先**；避免 INT8 ConvRot | Civitai 有 `Rent`；另受 Krea <$1M/yr 门槛或企业许可约束 | **首选成人 T2I bootstrap；首选 Krea Identity Edit 底模候选** |
| **Lustify v10 Krea2** | model `573152` / version **`3112728`**；7 个 Raw/Turbo FP8/BF16/INT8/GGUF 变体 | **是** | checkpoint 没有；作者 edit workflow **`3159388`** 明确要求 Krea2Edit nodes + Identity LoRA | **最明确**：女性写真和显式成人场景；作者样图为 Turbo INT8、8 steps、CFG 1 | 有 FP8/BF16/GGUF，Mac 候选形态丰富；不要首选 INT8 ConvRot | **不允许直接用于站外收费生成**：只有 `Image + RentCivit`，无 `Rent` | 内部成人资产/专项 A/B 价值高；不能替代通用身份路线 |
| **Muse Extended Turbo Edit** | model `2741166` / version **`3200345`**；INT8 file `3081686`，SHA `FD165…C22E` | 是 | **Identity Edit 已烘入**；仍需 Krea2Edit reference nodes，但跳过外部 edit LoRA loader | 版本页有 level-16 图；但样图 hash `e00c4ae933` 属同系列 NVFP4，不是该 Edit 文件 | **差**：精确版本只有 INT8；MPS `_int_mm` 当前有公开故障证据 | **不允许**：只有 `RentCivit` | NVIDIA 上的最小变量 identity-edit 对照；不是 iDream 外部付费默认候选 |
| **Moody Krea 2 Mix V7** | model `2731187` / version **`3209007`**；FP8/NVFP4/INT8 | **是** | checkpoint 和作者 graph 都没有 identity 输入；可外接 Identity Edit 或角色 LoRA | 作者明确 V7 NSFW influence 较强，样图含成人 prompt | FP8 可测；当前项目未安装 | **不允许**：只有 `RentCivit` | 成人 T2I/角色 LoRA 内部研究候选，不是 one-shot 人物保持模型 |
| **Dark Beast FLUX.2 Klein 9B** | model `2242173` / version **`2740209`**；FP8 file `2626634`，SHA `B20B…99C3` | 是 | 上游原生 single/multi-ref；该 merge 专攻 face swap | 版本 10 张图中 4 张 level-16；作者明确成人定位 | 量化文件较小，但官方上游只给 RTX/VRAM 数据；Mac 仍须实测 | **不允许，除非另购 BFL 商业许可**：上游 9B 非商业 | 能力研究候选；生产许可一票否决 |
| **Dark Beast Krea2** | model `2242173` / version **`3078453`**；FP8 diffusion file `2958418`，SHA `0C00…FC1B` | **是** | checkpoint 没有；可外接 `3139172`，未验证 | 明确 uncensored / zero mosaics，版本有 level-16 图 | FP8 可做 Mac 首测 | Civitai 有 `Rent`；另受 Krea 许可约束 | 成人 prior 最强压力候选；身份竞争风险高于 RedCraft |
| **Krea 2 Identity Edit v1.2** | model `2761113` / version **`3139172`**；full file `3019297`，另有 r128/r64 | 否 | 单 ref + scene/person 双输入；角色表、换脸、try-on；两人脸仍可能漂移 | **只用 SFW 数据训练**，成人组合没有作者质量承诺 | LoRA 本身较小；底模和量化决定 Mac 表现 | Civitai 有 `Rent`；Krea <$1M/yr 门槛或企业许可 | 当前 Krea2 最有一手证据的身份条件层；不能把它误称为 NSFW LoRA |
| **Krea 2 character LoRA** | 官方策略：在 Raw 训练、在 Turbo 推理 | 是（叠加到底模） | 单角色长期复用强；多人有 identity bleed 风险 | 取决于训练集和推理底模 | 训练更适合独立 GPU；推理形态取决于底模 | 受 Krea Community License / 企业许可 | Approved identity 的长期资产路线，不是首轮建档或多人统一解法 |

### 建议冻结的上游 revision

仅固定模型名不够。2026-08-28 查询到的上游 revision 是：

| 资源 | revision |
|---|---|
| `Qwen/Qwen-Image-Edit-2511` | `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9` |
| `Phr00t/Qwen-Image-Edit-Rapid-AIO` | `691024f438640508f8aa86414863fc15edfb8a84` |
| `krea/Krea-2-Raw` | `6b0ece7fffb640c5e3bcbe0a7f10f66b8e60a603` |
| `krea/Krea-2-Turbo` | `98e0fe118d17c9e3547fbb2e25acdbae2cadf7c7` |
| `conradlocke/krea2-identity-edit` | `89e9e7a09ee2e5c9331e952063d79b1b8a703280` |

对 Civitai 候选则同时冻结 `modelId + modelVersionId + fileId + SHA256`。同一个 model 容器会持续加入其他架构和更新版本，例如 RedCraft `958009` 已同时包含 Krea2 和后续 MiniMax H3；按模型页 slug 或“最新版本”解析会把生产路由静默换成另一种架构。

### 2.1 Civitai 权限的准确含义

Civitai 自己的权限组件把字段解释为：

- `Image`：可以出售生成图片；
- `Rent`：可以运行在“收费生成服务”；
- `RentCivit`：可以在 Civitai 上运行；
- `allowDerivatives`：可以分享 merge。

来源：[Civitai 权限语义源码，固定 revision](https://github.com/civitai/civitai/blob/390a70c33285c5470a3b33f455f286afeb522972/src/components/PermissionIndicator/PermissionIndicator.tsx#L39-L54)。

因此 `Image + RentCivit` 不能推导为 iDream 这种站外付费生成服务可用。当前 API 权限是：

| 模型 | `allowCommercialUse` | 对 iDream 的含义 |
|---|---|---|
| [RedCraft model `958009`](https://civitai.red/api/v1/models/958009) | `RentCivit, Rent, Image` | 作者层允许站外收费生成 |
| [Lustify model `573152`](https://civitai.red/api/v1/models/573152) | `RentCivit, Image` | 允许商用图片，不允许据此开放站外收费生成 |
| [Muse model `2741166`](https://civitai.red/api/v1/models/2741166) | `RentCivit` | 只允许 Civitai 生成服务 |
| [Moody model `2731187`](https://civitai.red/api/v1/models/2731187) | `RentCivit` | 只允许 Civitai 生成服务 |
| [Dark Beast model `2242173`](https://civitai.red/api/v1/models/2242173) | `Image, RentCivit, Rent` | 作者层允许；仍不能覆盖 FLUX 9B 上游非商业许可 |
| [Identity Edit model `2761113`](https://civitai.red/api/v1/models/2761113) | `RentCivit, Image, Rent` | 作者层允许；仍受 Krea 上游许可 |

### 2.2 Krea 上游许可是第二道门

[Krea 2 Community License](https://github.com/krea-ai/krea-2/blob/main/docs/KREA-2-COMMUNITY-LICENSE) 允许使用、修改、创建 derivative 和商业输出，但商业使用只覆盖全公司过去 12 个月总营收低于 **100 万美元** 的主体；达到门槛前必须取得企业许可。它还要求部署有合理的内容过滤/审查机制，并把 [Krea AUP](https://www.krea.ai/krea-2-use-policy) 纳入协议。

许可证 §3 对“分发或提供包含模型/derivative 的产品或服务”还有协议副本、模型命名和 NOTICE/署名要求。即使公司营收低于门槛，也不能只记录一句“可商用”；上线前需要明确 iDream 的 hosted service 是否触发 §3、并把对应 NOTICE 和用户条款落到产品里。超过 100 万美元门槛时则不再分析社区许可边缘，直接取得 Krea Enterprise License。

Krea AUP 没有按名称禁止合法、虚构、成年人的自愿成人内容；它禁止 CSAM、NCII、违法/侵权等用途。该许可边界与模型能力是两回事：官方 Krea 2 做过 safety fine-tuning，成人 checkpoint 的有效性来自下游 fine-tune/merge，不能从 Krea 官方模型卡推断。

### 2.3 FLUX.2 Klein 9B 的上游许可会覆盖 merge

[BFL 官方模型卡](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B) 明确：Klein 9B 是 FLUX Non-Commercial License；商业/生产使用不属于其免费许可。官方同时确认它统一支持 T2I、单参考和多参考，4-step distilled，约需 29GB VRAM。Civitai 上的 `2740209` 即使由作者勾选 `Rent`，也不能消除这个上游约束。若要生产使用，必须另行取得 BFL 的商业 self-hosted license，并核对该 derivative 是否被覆盖。

## 3. 各工作流到底如何锁身份

### 3.1 Qwen-Image-Edit-2511：原生双路条件，适合多人基线

官方 2511 示例直接把 `image=[image1, image2]` 传入 `QwenImageEditPlusPipeline`，用 40 inference steps。官方声明的改进包括减少 image drift、加强单角色一致性，以及把两张独立人物图融合为同一合照时的 multi-person consistency。[官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511#showcase)

它的价值是**干净、可解释的基线**：Apache-2.0、原生多图、没有第三方成人 LoRA merge 的 provenance 变量。它的局限同样明确：不是成人专项，20B/40-step 昂贵。正确用法不是“替换所有生成”，而是回答两个诊断问题：

1. 当前少步成人 merge 的身份漂移，是 Qwen 架构本身还是蒸馏/merge 导致？
2. 两个不同角色串脸，是 prompt/slot 错误还是少步模型能力不足？

### 3.2 Rapid-AIO v19：快，但需要单独完成成分许可清单

[Phr00t 模型卡（固定提交）](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md) 明确：

- AIO 合并 accelerator、VAE、CLIP 和多种用途 LoRA；
- 1 CFG、4 steps，作者修订的 `TextEncodeQwenImageEditPlus` 支持最多 4 张输入图；
- v19 是 2509/2511 混合，再加入 2511 8-step Lightning 和 GNASS 成人 LoRA；
- 作者最终认为 v19 更偏 edit consistency，v23 更偏 prompt adherence。

仓库 metadata 标为 Apache-2.0，但模型卡没有给出每个被 merge accelerator/realism/skin/NSFW LoRA 的精确 repository、revision、license 与权重比例。因此“HF 页面显示 Apache”只证明发布者声明，不能独自证明所有合并来源都允许站外收费服务。生产准入应要求一份 transitive manifest；在此之前，它是运行能力已知的候选，不是许可闭环已知的候选。

### 3.3 Krea2 Identity Edit：必须保留两条参考条件链

[Identity Edit v1.2 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit) 和 [`comfyui-krea2edit`](https://github.com/lbouaraba/comfyui-krea2edit) 给出清楚的训练匹配契约：

```text
reference image
  ├─ VAEEncode ──> Krea2EditModelPatch.source_latent
  └─ Qwen3-VL ───> Krea2EditGroundedEncode.image

Krea2 checkpoint
  └─ Identity Edit LoRA @ 1.0
       └─ Krea2EditModelPatch ──> sampler
```

- VAE latent token 负责 appearance；
- Qwen3-VL grounded encode 负责语义和“画面中的哪一个人”；
- 普通 `CLIPTextEncode` 看不到参考图语义，质量会明显下降；
- Turbo 快速路径：8–12 steps、CFG 1；删除/大改用 Raw、约 20 steps、CFG 3；
- v1.2 默认 `fit`，`ref_boost≈4` 是强 likeness 起点，输出应 ≤2MP；
- scene/person 双输入时 input order 固定；当前两人 face separation 仍不完美。

`3139172` 的 full LoRA 是 file `3019297`、约 1.70 GiB、SHA-256 `6ADF9A69…D3FD3CF`；另有 r128 `3025702` 和 r64 `3025700`。低 rank 变体更省内存，但生产候选应先用 full 作为质量基线，再证明降秩没有损坏角色特征。

最重要的证据边界：作者明确说该 LoRA **只用 SFW 数据训练，也不计划支持 NSFW 数据**。这不等于它结构上不能与成人 Krea2 checkpoint 组合；它意味着“成人画面 + 身份同时成立”必须由 iDream 自己实测，不能引用 Identity Edit 作者作为保证。

### 3.4 Muse Edit：烘入 LoRA，不等于无需 reference nodes

[Muse model API](https://civitai.red/api/v1/models/2741166) 的作者说明明确区分：

- Extended Edit 把 Krea 2 Identity Edit LoRA 烘进 checkpoint；
- 仍使用 `comfyui-krea2edit` node pack；
- 跳过独立 edit LoRA loader，避免重复 patch；
- 8–20 steps，16 是 sweet spot；CFG 1–3，Euler/simple。

精确版本是 [`3200345`](https://civitai.red/api/v1/model-versions/3200345)，不是用户链接中的 v3.5 `3258954`。但版本页十张样图记录的是同系列 NVFP4 模型 hash `e00c4ae933`，而 Edit INT8 文件的 SHA 是 `FD165…C22E`；所以这些图能证明 Muse 系列有成人能力，不能证明精确 Edit 文件的参考图成人同跑质量。

### 3.5 Lustify Edit workflow：工作流不是能力来源

[Lustify 工作流 model API](https://civitai.red/api/v1/models/2503119) 明确写明：Krea2 edit 需要安装 `comfyui-krea2edit` 并取得 Identity Edit LoRA，否则 edit functionality 不工作。精确 workflow version 是 [`3159388`](https://civitai.red/api/v1/model-versions/3159388)，JSON file `3040376`，SHA `DB7F…159C`。

[Lustify v10 Version API](https://civitai.red/api/v1/model-versions/3112728) 的七个文件不能只按简化 API 返回的同名 `lustifyNSFWCheckpoint_v10Krea2` 选择；应固定具体 fileId：

| 用途 | fileId | 大小 | SHA-256 |
|---|---:|---:|---|
| Turbo FP8 | `2997637` | 11.94 GiB | `94D92700…5E00` |
| Turbo INT8 ConvRot | `2996235` | 12.25 GiB | `0505412E…900D` |
| Turbo BF16 | `3015314` | 24.48 GiB | `04571B6C…27D3` |
| Raw BF16 | `3015315` | 24.48 GiB | `017F3363…BBA4` |
| Turbo GGUF Q2_K | `3001078` | 4.68 GiB | `25656F59…E5B1` |
| Turbo GGUF Q4_0 | `3002352` | 7.74 GiB | `29DE9543…76D` |
| Raw INT8 ConvRot | `2997070` | 12.25 GiB | `F165D4DB…C865` |

作者建议 Turbo 用于日常推理、Raw 用于训练/微调；这与 Krea 官方 Raw→Turbo 分工一致。对 Apple 首轮正确性，优先 Turbo FP8/BF16 或 GGUF，不选 INT8 ConvRot。

所以 Lustify 的能力分解是：

```text
Lustify v10 checkpoint = 成人女性写真/场景 prior
Identity Edit v1.2     = reference identity prior
Krea2Edit nodes        = 训练匹配的 reference transport
workflow 3159388       = 把三者接起来的图
```

把 workflow 下载下来并不等于 Lustify 自带人物保持；漏掉 LoRA 或任一 grounded/reference 节点都会退化为“参考图看似接入、实际没有身份权威”。

## 4. 角色 LoRA：何时比参考图编辑更合适

[Krea 2 官方仓库](https://github.com/krea-ai/krea-2) 的硬建议是 **TRAIN on Raw, RUN on Turbo**：Raw 是未蒸馏、可塑的训练底模；Turbo 是 8-step 推理底模，Raw 上训练的 LoRA 设计为可应用到 Turbo。Krea 官方的生成技能把 character consistency 的训练集建议为约 **15–20 张**高质量图片。[官方 Krea skill](https://github.com/krea-ai/skills/blob/main/krea-generate/workflows/lora-train-and-use.md)

角色 LoRA 适合：

- 身份已批准，不再探索“这个角色长什么样”；
- 同一角色要生成几十到几千张图；
- 需要跨镜头、跨构图、跨服装仍由同一身份 prior 主导；
- 能建立训练集版本、LoRA hash、trigger 与回归图库。

它不适合：

- 首轮视觉探索；训练会把尚未批准的错误身份固化；
- 两个以上角色直接叠多 LoRA 后一把生成。Krea 官方仓库当前有未解决的多人 identity bleed 报告，强度足以保 likeness 时会污染其他人物。[Krea issue #15](https://github.com/krea-ai/krea-2/issues/15)
- 用 LoRA 替代不可变参考集。训练权重是派生资产，仍应能追溯到它由哪一版 reference set 训练。

对 iDream 的合理分层是：**reference edit 负责建档与低频变化，character LoRA 负责批准身份后的高频规模化；多人同框继续由原生 multi-reference 模型或分阶段合成负责。**

## 5. Apple/MPS 与运行时选择

### 5.1 Mac 上先排除 INT8 ConvRot 默认路线

ComfyUI v0.27.0 加入 native INT8 ConvRot，但公开的 Apple MPS 故障报告显示 `aten::_int_mm` 没有 MPS 实现，只能设置 CPU fallback，且明确会更慢。[ComfyUI issue #15133](https://github.com/Comfy-Org/ComfyUI/issues/15133)

因此外部候选的 Mac 排序应是：

1. **FP8 / BF16 正确性基线**；
2. **GGUF / Metal** 独立性能候选；
3. INT8 ConvRot 仅在目标 NVIDIA 上测，不作为 Apple 默认。

这直接影响候选：RedCraft、Lustify、Dark Beast Krea2 都有 FP8；Muse Edit `3200345` 只有 INT8，所以它即使能力强，也不适合当前 Apple 本地主线。

### 5.2 stable-diffusion.cpp 是值得单列的 Metal/GGUF backend

[stable-diffusion.cpp 官方 README](https://github.com/leejet/stable-diffusion.cpp) 已列出 Krea2、FLUX.2 Klein 和 Qwen Image Edit 系列；其 [edit 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/edit.md) 还明确区分：

- `qwen` preset；
- `krea2_edit`，专门对应 `lbouaraba/krea2edit`；
- `krea2_ostris_edit`，对应其他 Ostris 路线；
- VLM、VAE reference、RoPE 与 `force_ref_timestep_zero` 的不同组合。

官方 Qwen 2511 文档还要求 `qwen_image_zero_cond_t=true`，否则 edit quality 会明显下降。[Qwen 2511 sd.cpp 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_edit.md)

这说明在 Apple 上可以把 GGUF/Metal 当平行 backend 做 A/B；但“项目支持某架构”不是速度证明。必须固定同一权重来源、量化、参考图、分辨率、steps 和 seed，与 ComfyUI 做真实冷/热测量。

## 6. 建议的资格赛，而不是凭样图投票

### 6.1 参赛路线

| 赛道 | A | B | C | D |
|---|---|---|---|---|
| 单人 T2I bootstrap | RedCraft `3139241` FP8 | Dark Beast Krea2 `3078453` FP8 | Lustify v10 Turbo FP8（内部候选） | 官方 Krea2 Turbo（干净基线） |
| 单人 reference edit | RedCraft + Identity Edit full v1.2 | Dark Beast Krea2 + Identity Edit full v1.2 | 官方 Qwen 2511 40-step | 当前 Qwen v19 单图 graph（控制组） |
| 多人 distinct identity | 官方 Qwen 2511 | 当前 Rapid-AIO v19 graph（失败控制组） | Krea2 scene/person 两输入 Identity Edit | 分阶段插入/局部重绘控制组 |
| 长期角色 | Krea Raw→Turbo character LoRA | character LoRA + RedCraft（兼容性候选） | reference-only Krea2 Edit | reference-only Qwen 2511 |

Lustify、Muse 和 Moody 因 `Rent` 权限不足，只能参加能力研究/内部资产赛道，不能因为分数高就自动晋级客户付费生成。Muse Edit 还可在 NVIDIA 环境作为“烘入 Identity Edit”的变量最少对照。Dark Beast Klein 9B 不再参加资格赛，历史 A/B 只作为反例证据保留。

### 6.2 固定测试集

资格赛分三关，先用最小成本发现 graph 级错误，再花成本评质量：

1. **Wiring gate**：两对强冲突的 identity/source 图、2 seeds；同时交换输入槽。任一候选如果忽略槽位、reference 断开后结果无明显变化、或复现当前“服装来自 identity、脸来自 source”的模式，立即淘汰，不进入大样本。
2. **Quality gate**：4 个角色 archetype × 6 个固定任务 × 3 seeds = **每条单人路线 72 张**。多人路线另用 4 对不同角色 × 4 个构图 × 3 seeds = **每条路线 48 张**。这是 model/workflow qualification，不与产品流量混跑。
3. **Drift/regression gate**：对通过者做连续 3 轮编辑测试，同时设置“每轮都从 immutable reference 重生”的控制组；然后以完全冻结的 revision 和 hash 做 20 次重复回归，确认冷/热切模、worker 重启后结果契约不变。

每个角色固定一版 reference manifest，任务至少覆盖：

- 4 个镜头：大特写、半身、全身、远景；
- 3 个姿态难度：正面静态、强透视/遮挡、多人互动；
- 3 个外观变化：换装、发型/妆容轻改、不同光照；
- 2 个场景强度：日常与明确成人；
- 2 个身份规模：一个人、两个不同角色；
- 连续 3 轮 edit，观察 identity drift 是否累积。

不能只测亚洲年轻女性近景；否则 Lustify/RedCraft 的训练 prior 会被误当成通用角色能力。至少加入男性、不同肤色、不同年龄外观的明确成年人、非写实画风和有独特几何特征的脸。

### 6.3 指标与一票否决

每条路线至少记录 1 次冷运行和全部热运行；质量由两名不知道模型名称的 reviewer 独立判断，分歧进入复核。记录：

- 人工盲评 identity pass/fail；
- face embedding 相似度只做辅助，不能覆盖体型、发型和标志物；
- 两人脸互相相似度、属性串扰与复制率；
- prompt slot 完成率；
- 手、脸、身体结构重大错误率；
- 成人动作/场景完成率；
- 端到端 wall time、模型加载、reference encode、sampling、VAE decode、峰值内存；
- 权重、LoRA、节点、VAE、text encoder、sampler/scheduler 的精确 revision。

建议硬门槛：

- 单角色 identity 人工通过率 <95%：不进入角色资产默认；
- prompt/slot 完成率 <90% 或重大手脸身体错误通过率 <95%：不进入默认；
- 两角色任一串脸/身份融合率 >2%：不开放多人默认；
- 连续三轮 edit 出现系统性漂移：禁止链式 edit，强制每轮从 immutable reference 重新生成；
- 许可没有基础模型 + merge + LoRA 的完整链：能力分再高也不生产发布；
- Apple 路线依赖 CPU fallback：不标记为本地快速模型。

## 7. 最终推荐顺序

### P0：现在最值得验证的生产候选

1. **保留 RedCraft `3139241` FP8 T2I**：只服务角色首次探索与成人构图，不给它 identity 能力标签；
2. **隔离建立 RedCraft + Identity Edit v1.2 full + pinned Krea2Edit nodes 候选**：先补齐本机尚不存在的节点/LoRA，再过 wiring gate，未通过前不切默认；
3. **引入官方 Qwen-Image-Edit-2511 40-step 作为测试基线**：判断多人/多图问题出在架构、graph 还是少步 merge；
4. **把现有 Rapid-AIO v19 双参考作为失败控制组，而不是推荐路线**；单图 Chat fallback 可保留运营逐图复核，但要重新做真实 qualification；
5. **Mage-Flow-Edit Turbo 作为 opt-in 快速预览**：只服务聊天轻编辑和草稿，不生成 portrait/hero/Release 的权威候选。

这几项的关系不是互相替代，而是：RedCraft 创造初始视觉，Krea2 Edit 竞争单人身份路线，官方 Qwen 诊断多人上限，Rapid-AIO 验证少步代价，MageFlow 争取低延迟预览。**当前只有第一项可以按收窄后的 T2I 职责继续使用；其余项目即使已有旧运行链，也都不应被写成身份生产已完成。**

### P1：身份批准后的规模化

6. 用批准的 reference set 训练 **Krea2 character LoRA（Raw train → Turbo infer）**；
7. 先在官方 Turbo 验证 identity，再把同一 LoRA 与 RedCraft 组合做兼容性 A/B；不要先验认为所有 Krea2 merge 都与官方 Turbo 等价；
8. 多角色不直接全局叠 LoRA，使用通过资格赛的 multi-reference graph 或分阶段区域合成。

### P2：隔离专项候选

9. **Lustify v10**：内部成人女性写真/解剖专项；取得作者站外 `Rent` 书面授权后才考虑用户生成；
10. **Dark Beast Krea2**：最激进成人 prior 压力测试；只有在 identity 不被 prior 覆盖时才晋级；
11. **Muse Edit**：NVIDIA 能力对照；许可和 MPS 限制使其不适合默认产品路线；
12. **Moody V7**：角色 LoRA/成人 T2I 内部对照，不是 one-shot identity 路线。

### 移出资格赛与默认生产

13. **Dark Beast Klein 9B `2740209`**：从 descriptor、seed、probe、产品选项与数据库可执行 Profile 中移除；本机权重和历史研究结果不随运行时删除；
14. 任何只有 T2I 样图、没有 reference conditioning 或 character LoRA 的 checkpoint：不得标记为“人物保持”；
15. 任何只写 modelVersionId、不锁 fileId + SHA256 + node revision + VAE/text encoder 的工作流：不得进入可复现生产 profile。

## 8. 本轮没有证明什么

- 本轮没有新下载或新运行候选；运行态判断来自只读预检，模型质量判断使用仓库已有真实输出和历史受控 A/B；
- 没有证明 RedCraft / Dark Beast / Lustify 与 Identity Edit v1.2 的成人组合质量；
- 没有证明 Rapid-AIO 所有 merge 成分的传递许可；
- 没有把 Civitai 的下载量、点赞数或精选图当质量基准；
- 没有证明任何社区 checkpoint 全面优于官方 Qwen 2511；
- 没有证明 Apple 上 FP8、GGUF 或 Metal 的相对速度；
- 没有修改模型路由、代码、数据库、ComfyUI 节点或权重。

## 一手来源

- [Qwen-Image-Edit-2511 官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)
- [Phr00t Qwen Rapid-AIO 模型卡（固定提交）](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md)
- [Krea 2 官方仓库](https://github.com/krea-ai/krea-2)
- [Krea 2 Community License](https://github.com/krea-ai/krea-2/blob/main/docs/KREA-2-COMMUNITY-LICENSE)
- [Krea 2 Acceptable Use Policy](https://www.krea.ai/krea-2-use-policy)
- [Krea 2 Raw 官方模型卡](https://huggingface.co/krea/Krea-2-Raw)
- [Krea 2 Turbo 官方模型卡](https://huggingface.co/krea/Krea-2-Turbo)
- [Krea 2 Identity Edit 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit)
- [`comfyui-krea2edit`](https://github.com/lbouaraba/comfyui-krea2edit)
- [RedCraft `3139241` Version API](https://civitai.red/api/v1/model-versions/3139241)
- [Lustify v10 `3112728` Version API](https://civitai.red/api/v1/model-versions/3112728)
- [Lustify Edit workflow `3159388` Version API](https://civitai.red/api/v1/model-versions/3159388)
- [Muse Edit `3200345` Version API](https://civitai.red/api/v1/model-versions/3200345)
- [Moody V7 `3209007` Version API](https://civitai.red/api/v1/model-versions/3209007)
- [Dark Beast Klein `2740209` Version API](https://civitai.red/api/v1/model-versions/2740209)
- [Dark Beast Krea2 `3078453` Version API](https://civitai.red/api/v1/model-versions/3078453)
- [Krea2 Identity Edit `3139172` Version API](https://civitai.red/api/v1/model-versions/3139172)
- [FLUX.2 Klein 9B 官方模型卡](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B)
- [BFL FLUX.2 官方推理仓库](https://github.com/black-forest-labs/flux2)
- [ComfyUI v0.27.0 Release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.27.0)
- [ComfyUI Apple MPS INT8 `_int_mm` issue](https://github.com/Comfy-Org/ComfyUI/issues/15133)
- [stable-diffusion.cpp 官方仓库](https://github.com/leejet/stable-diffusion.cpp)
- [stable-diffusion.cpp reference edit 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/edit.md)
- [Civitai 权限语义源码](https://github.com/civitai/civitai/blob/390a70c33285c5470a3b33f455f286afeb522972/src/components/PermissionIndicator/PermissionIndicator.tsx#L39-L54)

## iDream 本地证据

- [角色资产工作室权威](../architecture/16-character-asset-studio-authority.md)
- [当前角色生图系统说明](../product/CHARACTER_IMAGE_GENERATION_SYSTEM.md)
- [Qwen v19 vs Dark Beast Klein 9B 真实双参考 A/B](./QWEN_V19_VS_KLEIN_9B_CONTROLLED_AB_2026-07-27.md)
- [Mage-Flow-Edit Turbo 本机 MPS 实测](./MAGE_FLOW_EDIT_TURBO_MPS_NSFW_RESEARCH_2026-07-31.md)
- [Moody V7 人物保持边界核验](./MOODY_KREA2_V7_NSFW_CHARACTER_CONSISTENCY_2026-08-28.md)
- [Muse、RedCraft 与 BlackBurst 精确版本核验](./KREA2_IDENTITY_EDIT_MUSE_REDCRAFT_BLACKBURST_COMPARISON_2026-08-28.md)
