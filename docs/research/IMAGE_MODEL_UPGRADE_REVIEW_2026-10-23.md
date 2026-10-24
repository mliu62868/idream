# 统一图片模型后的升级复核

核验截止：2026-10-23 23:44 UTC。范围：发布者 API、模型配置、许可证、ComfyUI 官方权重和工作流，以及本项目既有实验记录。本轮只读小型元数据与源码，没有下载大模型、启动生成、切换服务或修改运行配置。

## 决定

**继续只启用现有 RedCraft / FineView QW21 Turbo Fixed INT8；本轮没有找到足以驱动升级的证据。不能称它为“已证明最新最好”。** FineView / RedCraft 当前是否另有版本，因发布源访问失败仍未知；官方 Qwen-Image-2.1-Turbo 是 10 月 9 日发布的基线，不是晚于现用 10 月 15 日 checkpoint 的新一代模型。Comfy-Org 的 10 月 22 日更新仅补充工作流链接，不能当作权重更新。[Qwen 发布记录](https://github.com/QwenLM/Qwen-Image-2.1/blob/ab96caa944157ca28a4f36b695c3047549f48f98/README.md#news)、[Comfy-Org 提交记录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/commits/main)、[现用资产的历史来源核验](../../.scratch/fineview-comparison-20261015/ASSET_SOURCE_REVIEW.md)

官方 Turbo 有明确的 ComfyUI INT8 权重和八步配方，适合作为未来受控比较的基线。它的存在与日期不证明优于现用模型；本轮没有得到与当前六步 RedCraft、旧 RED＋Viggle 相同输入条件下的三方画质对照。当前统一结果证明了可用链路，不能代替画质排名。[官方 Turbo 文件目录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd/diffusion_models)、[既有 RED 对照](REDCRAFT_QW21T_INTEGRATION_2026-10-16.md#作者八步与-redviggle-六步重新对照)、[六步与八步对照](REDCRAFT_SIX_VS_EIGHT_2026-10-21.md)

**当前配置已只使用一个扩散模型。** 23:44 UTC 的本地只读复查确认，5 个 active/enabled 生图与编辑 profile、4 个工作流均指向同一 FineView INT8 路径，采用六步 `er_sde/simple`、CFG1、无 LoRA；旧 REDQW21 active 数量为 0。记录中另外保留的 `mock-image` 测试 fixture 与 RealESRGAN 放大服务不属于扩散生图候选。[当前配置证据](../../.scratch/image-model-unification-20261023/upgrade-review-local-state.json)

下文的标记含义：**事实**为本次读取的发布元数据、配置或源码；**作者宣称**为发布者描述的效果/能力；**推断**为有依据但未执行验证的判断；**未知**为缺少证据，不能当作否定结果。

## 1. 现用 FineView / RedCraft 是否仍为最新

| 对象 | 可确认的历史事实 | 本次最新状态 |
|---|---|---|
| AiMetatron / FineView，model `3003597`，version `3407540` | 10 月 15 日来源快照记录名称 `QW21 Turbo Fixed`，发布于 `2026-10-15T20:29:44.979Z` | **未知**。本轮 [官方 API](https://civitai.com/api/v1/models/3003597) 未能读取；不能将旧快照当作 10 月 23 日版本列表。 |
| AiMetatron / RedCraft，model `958009`，version `3407259` | 同次快照记录名称 `RedCraft 3.0 (FixQW21T)`，发布于 `2026-10-15T17:25:07.241Z` | **未知**。本轮 [官方 API](https://civitai.com/api/v1/models/958009) 未能读取；该模型还包含不同基础模型的其他版本，不能仅按列表第一项判定 QW21 最新版。 |

历史日期直接来自保存的 [FineView API 快照](../../.scratch/fineview-comparison-20261015/source-model-3003597.json) 与 [RedCraft API 快照](../../.scratch/fineview-comparison-20261015/source-model-958009.json)。这两个入口在该次核验中发布的 INT8、TextureFix VAE 和附带工作流分别具有相同哈希；它们不是两个独立物理 checkpoint。此结论的时间边界是该次快照，不是今天的新版本声明。[历史资产来源报告](../../.scratch/fineview-comparison-20261015/ASSET_SOURCE_REVIEW.md)

会话前序 `.com` / `.red` 页与 API 已出现 403 或访问失败，本轮未绕过访问限制。作者历史说明链接的 Hugging Face 仓库主要是底模与 VAE；本次公开目录检索也没有找到能够验证发布者归属、并完整替代上述版本列表的作者镜像。因此结论是“无法确认是否有更新”，不是“确认没有更新”。[历史作者链接与归属核验](../../.scratch/fineview-comparison-20261015/ASSET_SOURCE_REVIEW.md)、[HF FineView 目录检索](https://huggingface.co/api/models?search=FineView&limit=20)、[HF AiMetatron 目录检索](https://huggingface.co/api/models?search=AiMetatron&limit=20)

## 2. 官方 Qwen Turbo 的版本与能力

| 发布对象 | 本次固定 revision / UTC 时间 | 这次更新实际意味着什么 |
|---|---|---|
| `Qwen/Qwen-Image-2.1-Turbo` | `fc13ba1986fcb905854dc8de2f52eee395f49b5b`；仓库创建 `2026-10-09T04:50:01Z`，最近修改 `2026-10-12T09:45:49Z` | 10 月 9 日上传模型；10 月 12 日修改文生图示例尺寸。没有据此发现更晚的 Turbo 权重发布。[API](https://huggingface.co/api/models/Qwen/Qwen-Image-2.1-Turbo)、[提交记录](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/commits/main) |
| `QwenLM/Qwen-Image-2.1` | `ab96caa944157ca28a4f36b695c3047549f48f98`；`2026-10-14T10:08:18Z` | 最新提交是增加 LightX2V Mac App 的 Apple Silicon 文档，不是新权重。[提交](https://github.com/QwenLM/Qwen-Image-2.1/commit/ab96caa944157ca28a4f36b695c3047549f48f98) |
| `Comfy-Org/Qwen-Image-2.1` | `0217efd1d9c9452e84f6448903d6e21bfa171ffd`；`2026-10-22T05:20:44Z` | 最新提交补充 Turbo 文生图/编辑模板链接。当前 Turbo INT8 权重的最近上传为 `72a49122613a4f9afbcc443426d6c765c0c383cf`，`2026-10-09T18:37:30Z`，该时点与当前目录的目标 SHA256 相同。[提交记录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/commits/main)、[10 月 9 日资产元数据](https://huggingface.co/api/models/Comfy-Org/Qwen-Image-2.1/tree/72a49122613a4f9afbcc443426d6c765c0c383cf/diffusion_models?recursive=false&expand=false&limit=100) |
| ComfyUI Turbo 模板 | `0cf483d1dcb548b8b8d3f38ddf0ff41c89896cdb`；`2026-10-13T16:35:38Z` | 已提供真正可读取的官方 JSON，包含明确采样节点，不必依赖第三方教程猜配方。[提交](https://github.com/Comfy-Org/workflow_templates/commit/0cf483d1dcb548b8b8d3f38ddf0ff41c89896cdb) |

**作者宣称 / 接口事实：** Qwen-Image-2.1 原生统一文生图与编辑，视觉生成部分为 7B、32 层 Single-Stream DiT；官方介绍支持最多 10 张参考图、透明图与局部编辑。Turbo 沿用同一架构，官方推荐八步、CFG1 和前缀 KV 缓存。官方编辑模板确实提供 `image_1` 至 `image_10` 的输入；这些资料能支持“原生多参考候选”的判断，不能独立证明 iDream 人物保持效果或 NSFW 质量。[Qwen 官方说明](https://github.com/QwenLM/Qwen-Image-2.1/blob/ab96caa944157ca28a4f36b695c3047549f48f98/README.md#introduction)、[Turbo 模型卡](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/README.md)、[官方编辑模板](https://github.com/Comfy-Org/workflow_templates/blob/0cf483d1dcb548b8b8d3f38ddf0ff41c89896cdb/templates/image_qwen_image_2_1_turbo_image_edit.json)

## 3. 可部署权重与组件复用

以下大小和哈希来自本次读取的发布者 LFS 元数据，**没有下载大权重，也没有重新计算远端完整文件哈希**。表中 GB 采用十进制字节，避免把下载大小混同于运行内存。

| 组件 | 发布大小 | 发布者 SHA256 | 与当前链路的关系 |
|---|---:|---|---|
| 官方 Turbo INT8 ConvRot | 7,256,787,829 B，约 7.26 GB | `8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c` | 官方可测试扩散权重，当前机器尚未安装；不是 FineView 的 `712b44…` 文件。[固定版本目录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd/diffusion_models) |
| 官方 Turbo BF16 单文件 | 14,230,280,616 B，约 14.23 GB | `8b74237a7f505773e2c66726fa696444b4c704585c93a347cff9044937f7914a` | 官方全精度备选；不需要为本次只读研究下载。[同一目录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd/diffusion_models) |
| 官方 ConvRot 编码器 `qwen3vl_8b_int8_convrot` | 9,350,798,360 B，约 9.35 GB | `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f` | 与现用 pin 完全一致；官方 Turbo 模板也指定该文件。无需凭文件名猜兼容。[官方目录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd/text_encoders)、[本项目 pin](../../packages/gen/src/preflight.ts) |
| 官方 Qwen 2.1 BF16 VAE | 675,509,688 B | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` | 官方 Turbo 模板的原配 VAE。[官方目录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd/vae) |
| madebyollin TextureFix BF16 VAE | 675,509,688 B | `36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908` | 与现用 pin 相同；作者允许其替换 Qwen 2.1 VAE，Turbo＋本机路径仍需实际测试。[作者资产元数据](https://huggingface.co/api/models/madebyollin/texture-fix-vae-for-qwen-image-2.1/tree/9a10df811f183323e4e94d255c18add1924ce340?recursive=true&expand=false&limit=100)、[作者兼容说明](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/blob/9a10df811f183323e4e94d255c18add1924ce340/README.md#compatibility) |

各 Comfy-Org 资产的精确大小与 SHA256 可通过[固定 revision 的树 API](https://huggingface.co/api/models/Comfy-Org/Qwen-Image-2.1/tree/0217efd1d9c9452e84f6448903d6e21bfa171ffd?recursive=true&expand=false&limit=100)复核。Qwen 原始 Diffusers 包另含两个 transformer 分片（合计 14,230,284,408 B）、17,534,340,584 B 编码器与 675,508,656 B VAE，四份权重合计 32,440,133,648 B；这与 ComfyUI 可按组件复用的单文件分发不同。[Qwen 原始包树 API](https://huggingface.co/api/models/Qwen/Qwen-Image-2.1-Turbo/tree/fc13ba1986fcb905854dc8de2f52eee395f49b5b?recursive=true&expand=false&limit=100)

**TextureFix 的边界：** 作者明确称其为非官方 Qwen 2.1 VAE 微调，目的是改善纹理与 FP16 NaN；README 记录最近权重功能更新为 10 月 5 日。本次仓库 API 的 10 月 22 日修改时间不能证明出现新 VAE，目标文件仍是现用哈希。作者展示的 rFID 改善伴随 PSNR/LPIPS 重建指标略差，也不能转述为所有内容全面变好。[作者模型卡与版本记录](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/blob/9a10df811f183323e4e94d255c18add1924ce340/README.md)、[仓库 API](https://huggingface.co/api/models/madebyollin/texture-fix-vae-for-qwen-image-2.1)

## 4. 官方 Turbo 的精确采样路径

**事实：Diffusers 原始配置**使用 `QwenImage21Pipeline`、`FlowMatchEulerDiscreteScheduler`，checkpoint 内嵌 `sample_sigmas`。调度器 `shift=1.0`、`use_dynamic_shifting=false`、`stochastic_sampling=false`；不能将其替换理解成沿用 FineView 的 `er_sde/simple`、六步、AuraFlow shift1.31。[model_index.json](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/model_index.json)、[scheduler_config.json](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/scheduler/scheduler_config.json)

ComfyUI 官方模板将终止零值一并写入 `ManualSigmas`：

```text
1.0, 0.978453, 0.95418, 0.926626, 0.89508,
0.845148, 0.704534, 0.414568, 0
```

实际连接是 `UNETLoader(Turbo INT8)` → `QwenImage21Cache(auto/default)` → `CFGGuider(CFG1)` → `SamplerCustomAdvanced`；另接 `KSamplerSelect(euler)`、`RandomNoise` 和上述 `ManualSigmas`。两份模板均没有额外 `ModelSamplingAuraFlow(shift1.31)` 节点，也不依赖 Viggle LoRA。官方支持 full Turbo checkpoint 或从底模提取的 Turbo LoRA 两条路线；本次候选选择完整 INT8 checkpoint，避免额外叠加一个不必要的适配器。[官方文生图 JSON](https://github.com/Comfy-Org/workflow_templates/blob/0cf483d1dcb548b8b8d3f38ddf0ff41c89896cdb/templates/image_qwen_image_2_1_turbo_t2i.json)、[官方编辑 JSON](https://github.com/Comfy-Org/workflow_templates/blob/0cf483d1dcb548b8b8d3f38ddf0ff41c89896cdb/templates/image_qwen_image_2_1_turbo_image_edit.json)、[Comfy-Org 部署说明](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/0217efd1d9c9452e84f6448903d6e21bfa171ffd/README.md#turbo)

编辑模板内部 `CFGGuider` 保存的 widget 值是 8，但其 `cfg` 输入通过 link911 由外层子图 `cfg=1` 覆盖；不能只读内部旧 widget 值误报 CFG8。编辑条件由 `TextEncodeQwenImage21` 同时接收图像和 VAE，保留 source latent/custom-size 切换。模板还包含默认关闭的 prompt enhancer；比较时应固定是否开启及最终编码文本，避免把提示词重写收益算到 checkpoint 上。[同一官方编辑 JSON](https://github.com/Comfy-Org/workflow_templates/blob/0cf483d1dcb548b8b8d3f38ddf0ff41c89896cdb/templates/image_qwen_image_2_1_turbo_image_edit.json)

官方安装路径分别为 `ComfyUI/models/diffusion_models/`、`models/text_encoders/` 和 `models/vae/`。这些资料给出了可部署的原生图和资产组合；本轮仅静态检查，未证明本机执行、交付或恢复已通过。[官方存放说明](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/0217efd1d9c9452e84f6448903d6e21bfa171ffd/README.md)

## 5. Apple Silicon 与当前运行时

**事实：** 当前 ComfyUI 上游 `supports_int8_compute` 在 MPS 上返回 false，源码解释是其 INT8 matmul 路径依赖 MPS 未实现的 `torch._int_mm`；量化运算选择因此禁用该计算格式。官方存在 INT8 文件，不等于 MPS 原生 INT8 算子加速。[model_management.py:2101](https://github.com/Comfy-Org/ComfyUI/blob/fb3befd168731438f88bc96e0920a538e8649878/comfy/model_management.py#L2101)、[ops.py:1880](https://github.com/Comfy-Org/ComfyUI/blob/fb3befd168731438f88bc96e0920a538e8649878/comfy/ops.py#L1880)

**本机静态核对：** 图像 ComfyUI 根目录为 `/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI`，pin 为 `88ab4a06566454ad89db8f0bedb970d6c08cd1b7`；包含 QwenImage21 支持与 `TextEncodeQwenImage21`。本机尚无官方 Turbo INT8 文件，因此没有本轮加载/出图证据。现有 ConvRot 编码器与 TextureFix VAE可作为组件复用候选，但新 diffusion 权重是否能完整经过项目的 resident BF16、MPS、缓存与卸载边界，仍需执行验证。[项目启动 pin](../../scripts/start-comfyui-idream.cjs)、[固定上游 QwenImage21 支持](https://github.com/Comfy-Org/ComfyUI/blob/88ab4a06566454ad89db8f0bedb970d6c08cd1b7/comfy/supported_models.py#L2074)、[固定上游编码节点](https://github.com/Comfy-Org/ComfyUI/blob/88ab4a06566454ad89db8f0bedb970d6c08cd1b7/comfy_extras/nodes_qwen.py#L111)

**推断，尚未验证：** 同一家族架构、官方 ConvRot 文件以及同哈希编码器，使官方 Turbo 成为有明确接入路径的候选；这不足以证明当前 custom node 可直接替换加载，也不足以估计速度。官方 README 的 Apple Silicon 推荐是 LightX2V Mac App，这是另一条运行路径，不能用其可用性证明当前 ComfyUI MPS 工作流。[官方 Apple Silicon 段落](https://github.com/QwenLM/Qwen-Image-2.1/blob/ab96caa944157ca28a4f36b695c3047549f48f98/README.md#apple-silicon)

## 6. 既有对照对“最好”的限制

**历史实验事实：** 10 月 16 日在统一参考图预处理、最终编码文本、种子和尺寸后，用两个人物×两个种子比较 RED＋Viggle Euler 六步、RedCraft `er_sde/simple` 八步＋旧 VAE、同一 RedCraft＋TextureFix。四个配对的参考脸保持均偏好 RED；当时报告结论是不支持替换 RED。该结果来自同一助手的一次匿名目视检查，样本小、不是独立多评审，也没有验证露骨 NSFW。它既不能证明 RED 普遍最好，也明确不支持“RedCraft 已被证明画质更好”。[完整实验、配方与局限](REDCRAFT_QW21T_INTEGRATION_2026-10-16.md#作者八步与-redviggle-六步重新对照)

**另一项历史实验：** 10 月 21 日只比较同一个 RedCraft 的六步与八步，八个配对全部六步更快，逐对降幅中位数 29.2%；目视画质与参考人物保持均无可靠胜负。这个结果支持特定条件下减少步数，不能跨模型传递推导出 RedCraft 六步优于 RED，更不能推导出优于本次未测的官方 Turbo。[配对结果与边界](REDCRAFT_SIX_VS_EIGHT_2026-10-21.md)

本会话统一过程中完成的四张真实生成属于功能与质量冒烟：文生图、单图编辑走 Main 产品链路并记录交付/持久化/扣费；身份＋造型、源图＋身份通过候选图直接执行 Gen provider。它们没有配套候选模型的相同输入结果，因此不纳入模型优劣排名。统一一个物理 checkpoint 与选择画质最优 checkpoint 是两个不同证据问题；本轮继续保留前者，撤回任何未经比较支持的后者。[产品两图收据](../../.scratch/image-model-unification-20261023/report.json)、[身份＋造型收据](../../.scratch/image-model-unification-20261023/candidate-look.json)、[源图＋身份收据](../../.scratch/image-model-unification-20261023/candidate-source-identity.json)

若之后评估替换，应先固定官方可部署八步 Euler/ManualSigmas 配方，再将当前 RedCraft 六步、旧 RED＋Viggle、官方 Turbo 放到同一人物、源图/多参考角色、最终编码文本、种子与输出尺寸的比较中。当前产品默认的比较与统一预处理的模型配方比较应分别标记；速度也应区分冷启动、缓存命中、原生执行和 Main 交付耗时。**这些是未来升级所需的证据标准，不是本次已完成的验证，也不改变本次继续只用现有模型的决定。** 该标准直接针对既有实验中发现的预处理、身份提示前缀及测量口径差异。[10 月 16 日输入隔离说明](REDCRAFT_QW21T_INTEGRATION_2026-10-16.md#输入与隔离)、[10 月 21 日测量范围](REDCRAFT_SIX_VS_EIGHT_2026-10-21.md#中断验证及适用范围)

## 7. 许可证约束

**事实：** 官方 Turbo 的固定版本 LICENSE 第 2 条只授予非商业研究/评估用途，商业用途需另行获得许可；Comfy-Org 与 TextureFix 模型卡也指向 Qwen Research License。不能将“可下载、可本地执行”转述为“已具备商业部署许可”。本轮未核验账户是否另持商业许可，也不对整个项目作法律结论。[Turbo LICENSE 第 2 条](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/fc13ba1986fcb905854dc8de2f52eee395f49b5b/LICENSE)、[Comfy-Org 模型卡](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/0217efd1d9c9452e84f6448903d6e21bfa171ffd/README.md)、[TextureFix 声明](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/blob/9a10df811f183323e4e94d255c18add1924ce340/README.md#attribution-notice)
