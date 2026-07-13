# Dark Beast Krea2 INT8 ConvRot 集成评估

日期：2026-07-12  
目标版本：Civitai model `2242173` / version `3091496`

## 结论

**模型格式和现有工作流是可集成的，但不应直接替换当前 RedCraft BF16 生产版本。**

- 作者明确标注该版本用于 **ComfyUI 0.27 原生节点**。我们的本机 ComfyUI 是 `v0.27.0-55-g69ea5869`，已包含官方 INT8/ConvRot 支持；示例图也确实使用原生 `UNETLoader`，不是第三方 INT8 loader。
- 它与现有 RedCraft Krea2 工作流共用 `qwen3vl_4b_bf16.safetensors` 文本编码器和 `qwen_image_vae.safetensors`，核心图只需把 UNet 文件名换成 Dark Beast，并保留 Krea2 的 sampler 配置。因此工程接入成本低。
- **当前运行机器是 M4 Max / MPS，不具备 INT8 Tensor Core 加速路径。** 当前环境只有 `comfy-kitchen` eager backend；PyTorch 2.10 的 MPS 对底层 `torch._int_mm` 实测为 `NotImplementedError`。所以在这台 Mac 上不能把“可被 ComfyUI 识别”理解成“能获得 INT8 加速”，更不能据此期待 2 倍速度。
- 当前线上 descriptor 已经使用由旧 FP8 正确反量化得到的 **BF16 diffusion + BF16 text encoder**，不是运行时再把 FP8 临时转成 FP16/BF16。Dark Beast INT8 是另一个模型版本/调校，不是已证明与 RedCraft 权重等价的量化副本；直接替换会同时改变内容表现与数值格式，无法归因，也没有回滚隔离。

建议：**以新的 model/workflow key 并行接入，Mac 保持 RedCraft BF16；等有 NVIDIA CUDA runner 后做同机 A/B，通过后再决定是否把 Dark Beast INT8 设为 CUDA 默认。**

## 模型与作者工作流事实

Civitai API 给出的精确文件如下：

| 项目 | 值 |
|---|---|
| 模型 | Dark Beast / 黑兽 INT8 Convrot 2倍速 Krea2 Aggressive Edition |
| 版本 | KREA2 黑兽1.1 INT8 Convrot (`3091496`) |
| Base model | Krea 2 |
| 文件 | `darkBeastINT8Convrot2_krea211INT8Convrot.safetensors` |
| 类型 | Diffusion Model / SafeTensor / INT8 |
| 大小 | 13,801,012.90625 KiB，约 13.16 GiB |
| SHA-256 | `AC104833639FFE5D25785EAAD8FE641AC66F3D4902C32380B925BE5A48E23E4B` |

作者说明写明 `INT8 Convrot for ComfyUI 0.27 [Native 原生节点支持]`，推荐 `ER_SDE` 或 `Euler`、`Simple`、CFG 1、8–16 steps。十张示例图嵌入的 API workflow 均为：

1. `UNETLoader` 加载 Dark Beast INT8，`weight_dtype=default`；
2. `CLIPLoader` 加载 `qwen3vl_4b_bf16.safetensors`，type=`krea2`；
3. `VAELoader` 加载 `qwen_image_vae.safetensors`；
4. `CLIPTextEncode` → `ConditioningZeroOut` → `KSampler` → `VAEDecode` → `SaveImage`；
5. 示例统一为 10 steps、CFG 1、`er_sde` / `simple`、denoise 1。

部分示例额外使用 `Krea2/Detailer-KREA2.safetensors`、strength 3，另一些没有，因此该 LoRA 是可选增强，不是基础运行依赖。我们的 `redcraft-krea2-txt2img.json` 已具有同构的核心图和同一组文本编码器/VAE；新增 descriptor 不需要修改 `ComfyUIBackend`。

## 速度、显存与质量判断

### 速度

模型标题中的“2倍速”没有附带 GPU、Torch/CUDA 版本、分辨率、baseline 文件或同 seed timing，因此只能视为作者声明，不能直接套用到我们的环境。

INT8 实现作者公开的受控数据能说明“为什么在 NVIDIA 上值得测”，但不是这个 Dark Beast checkpoint 的直接 benchmark：

| 环境 / 被测模型 | FP8 | INT8 ConvRot | 结果 |
|---|---:|---:|---|
| RTX 3090 / Flux2 Klein 9B | 2.06 s/it | 1.64 s/it | INT8 约 1.26x；compile 后 1.04 s/it，约 1.99x |
| RTX 5060 8 GB / Klein 9B | 3.04 s/it | 2.53 s/it | 约 1.20x；compile 后约 1.35x |

该实现说明 INT8 快速路径依赖 NVIDIA INT8 Tensor Core / Triton；其 layout 文档要求至少 SM 7.5。我们的 Apple MPS 环境没有 CUDA、没有 Triton，仅有 eager backend，不能获得上述优势。因此：

- **CUDA runner：** 很可能快于 BF16；相对 FP8 的收益取决于 GPU 代际和 compile，必须实测。
- **当前 M4 Max：** 不会比现有 BF16 更快；目前底层 INT8 matmul 还会因 MPS 未实现而失败，不能作为可用生产路径。

### 显存 / 内存

Dark Beast INT8 文件约 13.16 GiB；本机现有 RedCraft BF16 diffusion 文件约 24 GiB。仅看权重存储，INT8 接近 BF16 的一半。但峰值内存还包括 BF16 文本编码器、VAE、激活、运行时量化 workspace 和 offload，不能把文件大小直接当成峰值显存。对 CUDA runner 应记录冷加载峰值和热态峰值；对 MPS，INT8 eager/dequant 路径不会自然等于 13 GiB 常驻开销。

### 质量与产品行为

ConvRot 通过旋转权重/激活抑制量化 outlier，INT8-Fast 的跨模型 latent 指标总体优于 FP8；但这些是 Anima、Z-Image、Flux/Qwen 等 checkpoint 的结果，不是 Dark Beast 对 RedCraft 的同 prompt 对照。

更重要的是，目标模型是 **Dark Beast 1.1**，当前模型是 **RedCraft Krea2 RedMix**。Civitai 旧 FP8 版本和此 INT8 1.1 的文件大小、哈希及版本均不同，没有证据证明新文件只是把同一组权重从 FP8 转为 INT8。因此不能把输出差异简单归为“INT8 质量”；需要按两个独立候选模型评测。

## 推荐集成方式

1. 不改 `redcraft-krea2-txt2img`，新增 `darkbeast-krea2-int8-txt2img` descriptor 和独立 model/profile key。
2. 下载后校验 SHA-256，并放入 ComfyUI `models/diffusion_models/`；文本编码器和 VAE 复用现有文件。
3. 新图沿用现有 slots；UNet 改为 Dark Beast 文件，默认 10 steps、CFG 1、`er_sde` / `simple`。第一轮不要加入 Detailer LoRA，避免混入第二个变量。
4. backend capability 要求标为 NVIDIA CUDA INT8；不要把它路由到当前 MPS backend。当前 ComfyUI 原生 `UNETLoader` 足够，无需安装 `ComfyUI-INT8-Fast`。
5. 在目标 CUDA 机器用相同 prompt、seed、分辨率、steps 做至少以下 A/B：冷/热耗时、峰值显存、sanity、脸/手/构图、角色一致性和人工偏好。分别对比 Dark Beast INT8、Dark Beast 同权重 FP8/BF16（若可获得）、当前 RedCraft BF16。
6. 只有在 CUDA A/B 达到速度和质量门槛后，才把 Dark Beast INT8 设为 CUDA 默认；RedCraft BF16 保留为 MPS 默认和回滚通道。

## 一手资料

- [Civitai 精确版本 API](https://civitai.com/api/v1/model-versions/3091496)
- [Civitai 模型 API（作者说明和全部版本）](https://civitai.com/api/v1/models/2242173)
- [目标模型页面](https://civitai.red/models/2242173/dark-beast-or-int8-convrot-2-or-krea2-aggressive-edition?modelVersionId=3091496)
- [ComfyUI v0.27.0 release：原生 INT8 ConvRot 支持](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.27.0)
- [ComfyUI 原生 INT8 合入 PR #14636](https://github.com/Comfy-Org/ComfyUI/pull/14636)
- [ComfyUI-INT8-Fast README / 硬件要求](https://github.com/BobJohnson24/ComfyUI-INT8-Fast/blob/48a88b2fde88e986c6444fa1f51589b6089d04f3/README.md)
- [ComfyUI-INT8-Fast speed measurements](https://github.com/BobJohnson24/ComfyUI-INT8-Fast/blob/48a88b2fde88e986c6444fa1f51589b6089d04f3/Speed.md)
- [ComfyUI-INT8-Fast quantization quality measurements](https://github.com/BobJohnson24/ComfyUI-INT8-Fast/blob/48a88b2fde88e986c6444fa1f51589b6089d04f3/Metrics.md)
- [Comfy-Org Krea-2 官方 BF16 text encoder](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors)
- [Comfy-Org Krea-2 官方 VAE](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors)
- [Comfy-Org Krea-2 官方 INT8 ConvRot checkpoint](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors)（证明原生 Krea2 ConvRot 路线；不是 Dark Beast 权重）

## 仓库 / 本机证据

- `packages/gen/workflows/redcraft-krea2-txt2img.json`：当前生产 descriptor 明确加载 RedCraft BF16 diffusion 和 Qwen BF16 text encoder。
- `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md`：记录旧 FP8 → BF16 的正确反量化过程及 MPS 实测闭环。
- 本机 ComfyUI commit `69ea58697bb2f05124f5dc7e00ad111f7cfff645`（`v0.27.0-55`）包含官方 INT8/ConvRot code；本机 `comfy-kitchen 0.1.0` 仅 eager backend 可用，CUDA/Triton 不可用。
