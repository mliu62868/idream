# iDream Qwen Image Edit 与 FLUX.2 [klein] 速度 / 替换评估

日期：2026-07-25
范围：当前 Apple Silicon + ComfyUI 图生图线路；区分官方模型声明、仓库配置、本机历史实测与本轮只读检查。

## 结论

1. **目前默认图生图确实是 Qwen Image Edit 家族。** 但精确权重不是 Qwen 官方原版，而是 `Qwen-Rapid-AIO-NSFW-v19-bf16.safetensors`；单图、身份 + source、多身份 workflow 都默认 4 steps。`chat-image-edit` 和 `character-image-variation` 当前是 active、100% rollout。来源：[`qwen-image-edit-img2img.json`](../../packages/gen/workflows/qwen-image-edit-img2img.json)、[`qwen-image-edit-multi-reference.json`](../../packages/gen/workflows/qwen-image-edit-multi-reference.json)、[`seed.ts`](../../packages/main/prisma/seed.ts)。
2. **它在这台 Mac 上仍然很重，而且延迟波动很大。** 当前 AIO BF16 文件约 53 GiB。2026-07-25 当天的 ComfyUI history 有三次 832×1024、单参考、4-step Qwen：`197.487s`（无缓存节点）、`72.280s`（缓存节点 `1/4/9`）和 `376.131s`（无缓存节点）。当前可诚实报告的观察范围是约 **72.3–376.1 秒**，不是稳定的 72 秒，也还不是严格控制后的 warm p50/p95。来源：[本机 ComfyUI `/history`](http://127.0.0.1:8188/history)、[`2026-07-07-image-generation-redesign-design.md`](../superpowers/specs/2026-07-07-image-generation-redesign-design.md)。
3. **不能直接得出“换现有 Klein 9B 就会更快”。** 已接入的 Dark Beast / FLUX.2 klein 9B 在本机历史实测为 832×1216、双参考、5-step Euler，约 116.5 秒；它与今天 Qwen 的三次执行不是同分辨率、同参考数、同冷暖 / 切模状态，不能横比，双方都没有完成受控 A/B。来源：[`DARK_BEAST_2740209_SUITABILITY_REVIEW.md`](./DARK_BEAST_2740209_SUITABILITY_REVIEW.md)、[`seed.ts`](../../packages/main/prisma/seed.ts)、[本机 ComfyUI `/history`](http://127.0.0.1:8188/history)。
4. **真正值得作为速度候选的是官方 distilled `FLUX.2-klein-4B`，不是 Base 4B，也不是当前 9B。** 4B distilled 是 4 steps、Apache 2.0、支持单 / 多参考；BFL 官方页列出的 RTX 5090 推理参考约 1.2 秒、8.4 GB VRAM。该数字只说明它在匹配 NVIDIA 栈上有很强的低延迟潜力，不能外推为本机 MPS 秒数。来源：[BFL 官方模型页](https://bfl.ai/models/flux-2-klein)、[BFL 官方 4B 模型卡](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)、[BFL 官方仓库](https://github.com/black-forest-labs/flux2)。
5. **建议不替换 Qwen Auto/default。** 保留 Qwen 作为身份一致性与复杂编辑基线；新增官方 distilled Klein 4B 为显式选择 / draft-speed 候选，完成本机同条件 A/B 后再决定灰度。现有 Klein 9B 保持 explicit-only；其开放权重是非商业许可，商业自托管生产还需另行取得 BFL 商业许可。来源：[`seed.ts`](../../packages/main/prisma/seed.ts)、[BFL 官方许可说明](https://help.bfl.ai/articles/7108141705-can-i-run-or-fine-tune-flux-2-klein-locally)。

## 现在实际跑的是什么

| 项目 | 当前事实 | 证据 |
|---|---|---|
| 单图编辑 | `qwen-image-edit-img2img` → Rapid-AIO v19 BF16；832×1216；4 steps；SA Solver / beta | [`qwen-image-edit-img2img.json`](../../packages/gen/workflows/qwen-image-edit-img2img.json) |
| 身份 + source | `qwen-image-edit-multi-reference`；两张输入；同一 AIO；4 steps | [`qwen-image-edit-multi-reference.json`](../../packages/gen/workflows/qwen-image-edit-multi-reference.json) |
| 自动线路 | Qwen `character-image-variation` active、enabled、100% rollout | [`seed.ts`](../../packages/main/prisma/seed.ts) |
| Klein 9B | Dark Beast 9B 已发布为 `explicitOnly: true`；自动路由未改 | [`seed.ts`](../../packages/main/prisma/seed.ts) |
| Klein 4B | 仓库没有 4B descriptor；2026-07-25 本轮只读文件检查也未发现 4B diffusion / Qwen 3 4B encoder | [`packages/gen/workflows`](../../packages/gen/workflows) |
| 当前 runner | 2026-07-25 只读探针：ComfyUI 0.28.0、PyTorch 2.10.0、Apple MPS、128 GiB unified memory；`ReferenceLatent` / `Flux2Scheduler` 等节点存在 | [本机 `/system_stats`](http://127.0.0.1:8188/system_stats)、[ComfyUI Klein 官方指南](https://docs.comfy.org/tutorials/flux/flux-2-klein) |

当前 v19 还是 2509 / 2511 混合并含 Lightning 的第三方 AIO，不应把它等同为 Qwen 官方 `Qwen-Image-Edit-2511`。官方 2511 是 20B 家族，官方 quick start 用 40 steps；iDream 的 4-step 配方来自当前 Rapid-AIO，而不是官方原版设置。来源：[`QWEN_RAPID_AIO_DRAWTHINGS_SDCPP_COMPATIBILITY_2026-07-24.md`](./QWEN_RAPID_AIO_DRAWTHINGS_SDCPP_COMPATIBILITY_2026-07-24.md)、[Qwen 官方 Qwen-Image-Edit 模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit)、[Qwen 官方 2511 模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511#quick-start)。

## 4B、9B、Base 与 9B KV 不能混为一谈

| 模型 | 参数 / 默认步数 | 单 / 多参考编辑 | 开放权重许可 | 官方 NVIDIA 参考 | 对 iDream 的判断 |
|---|---|---|---|---|---|
| Klein 4B distilled | 4B；4 steps；step + guidance distilled | 支持；Klein 官方上限 4 refs | Apache 2.0，可商用 | RTX 5090 约 1.2 秒、8.4 GB | **首选速度候选** |
| Klein 4B Base | 4B；50 steps；未蒸馏 | 支持 | Apache 2.0，可商用 | RTX 5090 约 17 秒、9.2 GB | 用于 LoRA / 微调，不是低延迟替换 |
| Klein 9B distilled | 9B；4 steps；step + guidance distilled | 支持 | FLUX Non-Commercial License | RTX 5090 约 2 秒、19.6 GB | 质量候选；商业生产需许可 |
| Klein 9B Base | 9B；50 steps；未蒸馏 | 支持 | FLUX Non-Commercial License | RTX 5090 约 35 秒、21.7 GB | 研究 / 微调，不是速度方案 |
| Klein 9B KV | 9B；4 steps；KV-cache 专用变体 | 支持，专门优化 reference editing | FLUX Non-Commercial License | 对标准 9B 的加速随 refs / 输出尺寸变化 | 不能把 BFL CLI 的 KV 收益默认算到当前 ComfyUI 9B |

表中参数、蒸馏、能力和许可来自 [BFL 官方仓库模型矩阵](https://github.com/black-forest-labs/flux2)；步数、RTX 5090 时间和 VRAM 来自 [BFL 官方模型页](https://bfl.ai/models/flux-2-klein)；Klein 最多 4 个参考图来自 [BFL FLUX.2 官方概览](https://docs.bfl.ai/flux_2/flux2_overview)。

`9B KV` 不是普通 9B 自动开启的开关，而是独立权重 / 推理路径。BFL 官方参考实现给出的相对标准 9B 加速，在 1024×1024 输出时为 1 ref `1.40×`、2 refs `1.77×`、4 refs `2.22×`；BFL 因此称它在多参考编辑中甚至可能快于 4B。当前 iDream descriptor 加载的是 Dark Beast 普通 9B checkpoint，ComfyUI 官方指南也只列普通 / Base 4B、9B workflow，不能把这个 KV 数字算作现有线路能力。来源：[BFL 9B KV 官方说明](https://github.com/black-forest-labs/flux2/blob/main/docs/flux2_klein_kv_cache.md)、[`darkbeast-flux2-klein-9b-multi-reference.json`](../../packages/gen/workflows/darkbeast-flux2-klein-9b-multi-reference.json)、[ComfyUI Klein 官方指南](https://docs.comfy.org/tutorials/flux/flux-2-klein)。

## 为什么官方“1 秒级”不能直接回答这台 Mac

- BFL 的质量 / 延迟对 Qwen 图表是在 **GB200 + BF16** 上测的；其量化加速数字是在 **RTX 5080 / 5090** 上测的。BFL 自己的 reference repo 也只声明测试过 GB200、CUDA 12.9、Python 3.12。来源：[BFL 官方发布说明](https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence)、[BFL 官方仓库](https://github.com/black-forest-labs/flux2)。
- ComfyUI 官方提供 4B / 9B 的 distilled 和 Base image-edit workflow；4B 使用 Qwen 3 4B encoder，9B 使用 Qwen 3 8B encoder，二者共用 FLUX.2 VAE。官方还要求使用足够新的 ComfyUI；稳定版可能晚于 nightly 获得节点。来源：[ComfyUI Klein 官方指南](https://docs.comfy.org/tutorials/flux/flux-2-klein)。
- ComfyUI 官方下载项主要是 FP8 diffusion。Apple MPS 当前没有原生 FP8 compute；本项目已有算子级核验表明 ComfyUI 会拒绝 MPS FP8 cast / compute，可靠路径是 BF16 / FP16 计算或独立 Metal / MLX 量化 runtime。因此 BFL 的 RTX FP8 加速不能套到当前 Mac。来源：[`QWEN_IMAGE_FP8_INT8_APPLE_MPS_SUPPORT_2026-07-24.md`](./QWEN_IMAGE_FP8_INT8_APPLE_MPS_SUPPORT_2026-07-24.md)、[ComfyUI `model_management.py`](https://github.com/Comfy-Org/ComfyUI/blob/45ffd5430beeccf63682b5f8b569faad45fd60e1/comfy/model_management.py#L1239-L1254)、[ComfyUI FP8 gating](https://github.com/Comfy-Org/ComfyUI/blob/45ffd5430beeccf63682b5f8b569faad45fd60e1/comfy/model_management.py#L1870-L1892)。
- 这台 Mac 的直接证据恰好说明“模型小 / steps 少”不自动等于秒级：今天 Qwen v19 BF16 三次单参考 4-step 为 72.280–376.131 秒；现有 Klein 9B 的历史双参考记录约 116.5 秒。Qwen 的 72.280 秒执行缓存了 checkpoint / 部分节点，另两次没有缓存节点；它们与 9B 仍不是受控 A/B，也不能用来推导 4B 的速度。来源：[本机 ComfyUI `/history`](http://127.0.0.1:8188/history)、[`DARK_BEAST_2740209_SUITABILITY_REVIEW.md`](./DARK_BEAST_2740209_SUITABILITY_REVIEW.md)。

## “更好”不只看速度

Qwen 官方把 2511 的重点放在减少 image drift、增强角色一致性和多人一致性；官方 quick start 直接接受多图列表。它仍然是 iDream 角色身份、服装 / 构图 / 场景复杂编辑的合理基线。来源：[Qwen 官方 2511 模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)。

BFL 官方声明 4B distilled 同时支持 text-to-image、单参考和多参考编辑，并以低延迟为首要目标；但本机尚未安装 / 跑过 4B，也没有 iDream 角色素材上的身份一致性、复杂指令、多轮漂移证据。官方能力声明不能代替 iDream 质量 Gate。来源：[BFL 官方 4B 模型卡](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)、[BFL 官方仓库](https://github.com/black-forest-labs/flux2)。

因此，“Klein 4B 更快”是**高概率候选假设**；“Klein 4B 整体更好、可以替换 Qwen”目前没有证据。“现有 Klein 9B 更快”也没有证据。

## 推荐落地

1. **保留 Auto / default → Qwen。** 不改 `chat-image-edit`、`character-image-variation` 和多身份默认路由。
2. **新增精确的官方 distilled `FLUX.2-klein-4B` ComfyUI descriptor。** 不用 Base 4B；使用独立 `modelId` / `workflowKey`，显式选择，初始 draft / 0% 自动流量。
3. **Klein 4B 先服务“快速尝试”。** 可优先验证聊天轻编辑、换背景 / 光线 / 服装、More-like-this 和批量草稿；角色主肖像、identity asset pack 与发布路线仍以 Qwen 为默认，直到 4B 通过相同身份 Gate。
4. **现有 Klein 9B 保持 explicit-only。** 它可继续做 identity-focused A/B，但不要当速度方案；商业流量前闭环 BFL 9B 商业许可。来源：[BFL 许可说明](https://help.bfl.ai/articles/7108141705-can-i-run-or-fine-tune-flux-2-klein-locally)。
5. **如果未来专攻多参考速度，再单独评估 9B KV。** 需要确认 ComfyUI / runner 的真实 KV 权重和执行路径；不能复用普通 9B checkpoint 后在 UI 上改个名字。

## 最小本机 A/B

固定同一组真实不同的 `identity_image` + `source_image`、prompt、832×1216、单候选：

| 线路 | 配方 |
|---|---|
| 当前基线 | Qwen Rapid-AIO v19 BF16，4 steps，SA Solver / beta |
| 速度候选 | 官方 Klein 4B distilled，4 steps，官方 ComfyUI image-edit recipe |
| 已有对照 | Dark Beast Klein 9B，5 steps，Euler / Flux2 |

每条线路做 1 次冷运行、至少 3 次改变 seed 的热运行，分别记录模型加载、text / reference encode、采样、VAE decode、端到端 wall time、峰值 unified memory；改变 seed 是为了避免 ComfyUI node cache 把缓存命中误报为生成速度。质量单独评身份、source 姿态 / 场景服从、手脸、纹理、多参考串扰和多轮漂移。来源：[`DARK_BEAST_2740209_SUITABILITY_REVIEW.md`](./DARK_BEAST_2740209_SUITABILITY_REVIEW.md)、[`QWEN_RAPID_AIO_DRAWTHINGS_SDCPP_COMPATIBILITY_2026-07-24.md`](./QWEN_RAPID_AIO_DRAWTHINGS_SDCPP_COMPATIBILITY_2026-07-24.md)。

只在 Klein 4B 的 warm p50 / p95 明显更低、峰值内存更低，并且身份与指令质量 Gate 不退化时，才从显式候选升级到小流量；否则它只作为快速草稿模型存在。
