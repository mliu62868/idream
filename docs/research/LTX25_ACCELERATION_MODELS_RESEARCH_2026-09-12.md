# LTX 2.5 加速方案与模型调研

日期：2026-09-12  
范围：LTX 2.5 的官方模型、官方推理路径、ComfyUI 原生量化、Apple Silicon/MLX 路线及可复用的速度证据。未下载大模型、未改代码、未把社区宣传速度当作本机验收结果。  
证据标记：**官方事实** = Lightricks / Comfy-Org 一手文档或模型卡；**社区事实** = 可审计的社区仓库或模型卡；**工程判断** = 基于上述事实对 iDream 当前 M4 Max/MPS 路线的建议。

## 结论

1. **最快且最稳的官方模型入口是 `ltx-2.5-22b-distilled-transformer` + `DistilledPipeline`：8 步第一阶段 + 3 步第二阶段，无 CFG。** 官方把它定义为最快路径；它适合预览、批量生成和低延迟服务。生产质量的 DFR 使用同一个 distilled transformer，再增加生成 keyframe 和 spatial detailing pass，官方明确说明会更慢、占用更多显存。[官方 pipeline 文档](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/pipelines.md)、[官方 README](https://github.com/Lightricks/LTX-2/blob/main/README.md)（访问：2026-09-12）
2. **CUDA 上最值得优先 A/B 的量化是官方 `comfy-int8-convrot`；Blackwell 才考虑 NVFP4。** LTX 2.5 模型卡列出 distilled/dev 的 Comfy INT8+ConvRot 文件和 distilled NVFP4 文件，并明确 Comfy INT8 不能加载到 `ltx-pipelines`。NVFP4 依赖 Blackwell/`ltx-kernels`，不是通用 CUDA 或 MPS 加速方案。[LTX-2.5 模型卡](https://huggingface.co/Lightricks/LTX-2.5)（访问：2026-09-12）
3. **公开的可复现实速度证据目前主要来自 Comfy-Org 的 LTX-2.3 量化基准，不是 2.5；它仍可作为后端选择的方向证据。** RTX PRO 6000 Blackwell、512²×49、20 steps 下，INT8 tensorwise 为 2.73 it/s（BF16 2.37 it/s，1.15×），峰值显存下降 28%；FP8 仅 0.96×，NVFP4 为 0.66×但体积最小。不要把这些数字直接当成 LTX 2.5 或 M4 Max 结果。[comfy-quants LTX-2 基准](https://github.com/Comfy-Org/comfy-quants/blob/main/docs/quantization/ltx2.md)（访问：2026-09-12）
4. **对当前 Apple Silicon/MPS，优先验证 MLX/Metal 原生路线，而不是继续期待 MPS 上 FP8/INT8 ConvRot 自动变快。** `mlx-community/ltx-2.5-mlx` 已提供 LTX 2.5 的 MLX 转换；社区报告在 128 GB Apple Silicon 上通过调度把峰值从 62.40 GB 降到 40.66 GB（输出 bit-identical），并报告空间 DFR 约 1.2× 时间、时序 round 约 2.767×/3.542× 时间。它没有公开本机 wall-clock，所以应视为候选后端，必须在 M4 Max 固定输入实测。[MLX 模型卡](https://huggingface.co/mlx-community/ltx-2.5-mlx)、[MLX runtime](https://github.com/dgrauet/ltx-2-mlx)（访问：2026-09-12）
5. **最安全的产品提速杠杆是降低视频 token 和阶段数：预览走 distilled、短时长/较低 stage-1 分辨率、跳过 DFR 或 temporal rounds；最终交付再走 DFR。** 量化主要解决显存和 CUDA kernel 适配，不能抵消 22B DiT、Gemma 4 12B 文本编码器和二阶段 upscaling 的计算量。

官方 quick-start 的 LTX 2.5 split pack 约需 **66 GiB 磁盘**；Gemma 4 12B 文本编码器本身约 23.8 GiB（Apple MLX 测量的 BF16 常驻约 24.4 GB）。因此 M4 Max 的瓶颈首先是统一内存与调度，再是算子吞吐。[官方 README](https://github.com/Lightricks/LTX-2/blob/main/README.md)、[MLX 模型卡内存测量](https://huggingface.co/mlx-community/ltx-2.5-mlx)（访问：2026-09-12）

6. **iDream 本机已经有一组更直接的 M4 Max A/B/A 证据：保留同一个 RedGraft 混合量化文件，只把采样期 Linear 计算改成 BF16，完整工作流从 732.7/773.8 秒降到 588.0 秒，约快 12.7%–20.0%。** 但候选的最终视频与基线逐帧平均 SSIM 为 0.875、最差帧 0.772，眨眼、表情和头部轨迹发生变化；因此这是独立候选路线，不是无损替换。DiffSynth 本身无法识别当前 W4A8/ Gemma4 契约，本轮没有产出新 INT4 文件。[本地验证归档摘要](.DIFFSYNTH_LTX25_INT4_VALIDATION_2026-09-05.pdf.igrep.md)

7. **2026-09-12 在同一 M4 Max 做了 RedGraft 真实 SDPA 对照：只把 ComfyUI runner 从 `--use-split-cross-attention` 换成独立 8190 的 `--use-pytorch-cross-attention`，模型、Gemma4 INT8 encoder、prompt、seed、分辨率和两阶段图保持一致。** SDPA 端到端耗时 `820.656s`；现有 split 路线的同规格历史基线为 `841.614/864.129/890.340s`，相对中位数快 `5.03%`（范围 `2.49%–7.83%`）。产物为 `768×1152`、`121` 帧、`5.041667s`，含音频，`ffmpeg -v error` 全量解码通过；prompt `e3614e3b-73c7-493f-a6ad-cd725e1ba53a`，SHA-256 `8bac2e48ae837d0e84e46fee9cc21393cb76ae917d5bf7478bda584e45068130`。[本地报告](../.tmp/redgraft-sdpa-probe.json)

## 模型与路径清单

| 路线 | 模型/格式 | 适用硬件 | 速度/质量证据 | 兼容性与风险 |
| --- | --- | --- | --- | --- |
| 官方快速默认 | `ltx-2.5-22b-distilled-transformer-bf16.safetensors` | CUDA、MPS（官方 Python 主要面向 CUDA）；MLX 需转换 | 固定 8 步 stage 1 + 3 步 stage 2；官方称最快 pipeline，无公开统一秒数 | 需要 LTX 专用 Gemma4 12B、video/audio VAE、spatial upscaler；不要把 dev 模型传给 DFR |
| 官方生产质量 | 同上 + `LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler`（DFR） | CUDA/MPS/MLX 取决于运行时 | 官方称比 Distilled 更慢、更吃显存；MLX 社区报告 spatial detailing 约 1.2× 时间 | 额外 LoRA/keyframe/detailing；temporal upscaling 还要 temporal upscaler |
| Dev + 蒸馏 LoRA | `ltx-2.5-22b-dev-transformer-bf16` + `ltx-2.5-22b-distilled-lora-450-bf16` | 官方 pipeline/Comfy/MLX 实现 | 可用 CFG/STG；标准两阶段通常 30/15 步 stage 1（取决于 pipeline），明显慢于 distilled | LoRA 只适用于对应模型；用于控制/质量，不是最低延迟路径 |
| 官方 Comfy INT8 | `*-comfy-int8-convrot.safetensors`（DiT、Gemma TE） | ComfyUI；原生快速路径面向 NVIDIA SM ≥7.5 | LTX-2.3 基准 INT8 tensorwise 1.15×、−28% VRAM；2.5 尚无同口径公开速度 | 模型卡明确 ComfyUI-only；MPS 没有对应 CUDA CUTLASS/ConvRot 快路径，能加载不等于加速 |
| 官方 NVFP4 | `ltx-2.5-22b-distilled-transformer-nvfp4.safetensors` | NVIDIA Blackwell SM ≥10，`ltx-kernels`/ComfyUI | LTX-2.3 基准 0.66×、−45% VRAM；优势是体积/显存而非这项测试的速度 | 不适用于 M4；旧 CUDA/非 Blackwell 会退化为反量化或不支持 |
| 官方 BF16 + runtime cast | BF16 checkpoint + `--quantization fp8-cast` | `ltx-pipelines` CUDA 低显存 | 官方只承诺 lower memory footprint；不是原生 FP8 GEMM | 适合显存不足；不要把它当成 MPS 原生 FP8 加速 |
| MLX 原生 Apple | `mlx-community/ltx-2.5-mlx`（BF16 split）或社区 Q8/Q4 pack | Apple Silicon / Metal | 128 GB Apple 测试：DiT encode 阶段驱逐使峰值 62.40→40.66 GB 且 bit-identical；int8 Gemma 24.42→14.20 GB；int4 Gemma 被报告拒绝 | 社区转换，需锁 runtime commit；没有公开 M4 Max 端到端 wall-clock/质量 benchmark |
| GGUF/ComfyUI-GGUF | 社区 Q4/Q8 等 GGUF | 低显存 CUDA，部分 CPU/Metal 取决于 loader | 文件大小可降到约 11.65 GB（Q4_0）或约 20.04 GB（Q8_CR）；公开模型卡没有严谨 LTX 2.5 端到端速度/质量基准 | 依赖第三方 loader；不是官方格式；用于低显存实验，不应作为默认生产路径 |

如果不要求自托管，官方 API 还区分 `ltx-2-5-fast` 与 `ltx-2-5-pro`：Fast 面向速度/成本，Pro 面向更高保真度；两者都支持 T2V/I2V/A2V，但 Pro 是 API-only。它们是服务端模型选择，不能直接解释本地 M4 Max 的加速效果。[LTX 官方模型文档](https://docs.ltx.io/models/ltx-2-5)（访问：2026-09-12）

官方拆分包还提供两种 video VAE：Diffusion VAE 质量更高但更重；Conv VAE 更轻且无需额外依赖。官方 README 说明 Linux+CUDA 的 `natten` 是 Diffusion VAE 最快后端，Windows/macOS 会回退 Triton 或 eager；因此 M4 上可先用 Conv VAE 做速度档。[官方 README 的 VAE/后端说明](https://github.com/Lightricks/LTX-2/blob/main/README.md)（访问：2026-09-12）

## 官方可用的加速开关

- **DistilledPipeline**：固定 8 个 sigma，stage 2 为 3 步；不需要 guidance。适合预览和批处理。
- **单阶段 pipeline**：`TI2VidOneStagePipeline` 没有 upscaler，适合不需要高分辨率的快速原型；官方警告生产质量应使用 DFR。
- **降低 full-model 步数**：官方 README 对非 distilled pipeline 建议把 40 步降至 20–30 步并验证质量；该建议不能覆盖 distilled 固定 schedule。
- **FP8**：CUDA 低显存可对 BF16 checkpoint 使用 `fp8-cast`；Hopper+ 原生 FP8 才考虑 `fp8-scaled-mm`。MPS 上不应据此推断有 tensor-core 加速。
- **Attention backend**：B200 使用经验证的 FlashAttention 4 beta；Hopper 使用 FlashAttention 3；其他 CUDA 自动用 PyTorch SDPA。`natten` 主要优化 Diffusion VAE，且官方说明 Linux+CUDA-only。
- **内存清理**：显存足够时关闭 stage 间自动 cleanup，可减少调度开销；代价是常驻内存增加。
- **视频规格**：帧数必须满足 `num_frames % 8 == 1`，宽高需被 32 整除。缩短帧数、降低 stage-1 宽高、跳过 spatial/temporal refine 都是直接降低 token 数的办法。

## Apple Silicon/M4 Max 判断

官方 LTX Desktop 支持 Apple Silicon 本地生成，要求至少约 15 GB 可用 RAM；这是兼容性声明，不是速度承诺。[LTX Desktop README](https://github.com/Lightricks/LTX-Desktop)（访问：2026-09-12）

当前 iDream 的 M4 Max/MPS 路线应按以下优先级做受控 A/B：

1. **先做 Distilled + Conv VAE 的速度档**：同一 seed、同一 5 秒/121 帧规格，记录文本编码、stage 1、upscale、stage 2、VAE decode、端到端 wall time 和峰值统一内存。
2. **并行试 MLX Q8 transformer + int8 Gemma（保留 embed_tokens BF16）**：MLX 社区测量显示 int8 Gemma 数值/感知接近 BF16，而 int4 被明确拒绝；不要直接采用无质量数据的 int4 Gemma。
3. **测试 MLX 的 DiT eviction / block streaming**：这是内存/调度优化，社区报告 bit-identical；它可能让更大 batch 或更高分辨率可运行，但不应假设 wall time 必然下降。
4. **把 DFR temporal rounds 设为可选**：社区报告 1/2 轮约 2.767×/3.542× 时间，不能作为加速手段；默认只保留 spatial detailing 或直接交付 distilled preview。
5. **不要在 MPS 上把 FP8/INT8 文件大小当成速度**：Comfy-Org 的快速 INT8 证据依赖 NVIDIA SM ≥7.5；M4 应以 MLX Metal kernel 或 BF16 MPS 实测为准。

本次 SDPA 对照还做了独立 attention 微基准：MPS 上 `scaled_dot_product_attention` 在 `16,384×16×128` 的热态约 `0.187s`，Comfy split attention 约 `0.292s`（`1.56×`）；但该局部收益被文本编码、两阶段采样和 VAE 解码摊薄到端到端约 `5%`。因此 SDPA 值得作为独立 runner 的候选，当前证据不足以直接替换 8188 生产路由。

本项目对当前 RedGraft 文件的结构检查显示它不是纯 INT8：DiT 中约 609 层为 W4A8、831 层为 INT8 tensorwise，Gemma4 文本编码器另有 328 个 INT8 层。因而“换成 INT4”不能直接解释为整体减半，也不能绕过 W4A8 loader、Gemma4 专用 hidden-state/projection 契约。当前 DiffSynth parser 不接受 `asym_w4a8_int8`，其 MPS 原生 INT4 微基准在大矩阵上也明显慢于 BF16；不应作为现有 M4 默认路线。

## 许可证与部署注意

LTX-2.5 模型卡标注 `ltx-2.x-community-license-agreement`：模型卡写明年收入低于 1,000 万美元的实体可按社区许可证免费商业/生产使用；超过该门槛需要付费商业协议，完整约束以官方许可证为准。[模型卡许可说明](https://huggingface.co/Lightricks/LTX-2.5)、[LTX-2.x LICENSE-2_x](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x)（访问：2026-09-12）。社区 MLX/GGUF 转换应保留上游许可证并核对其模型卡；第三方量化文件不能改变上游权利义务。

## 验收建议

在决定默认模型前固定一次 5 秒、24 fps、121 帧、同一首帧和 3 个 seed，至少比较：官方 BF16 distilled、Comfy INT8 ConvRot（若 CUDA）、MLX Q8、MLX int8 Gemma、Conv VAE 与 Diffusion VAE。记录实际 provider、runtime commit、checkpoint SHA、量化格式、峰值内存、阶段耗时、端到端 wall time、音频轨是否存在、角色/肢体错误率和失败恢复。公开来源目前不足以证明任何社区量化在 iDream NSFW identity 场景上优于现有 MPS baseline。
