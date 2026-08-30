# Apple Silicon / MPS 下 FP8 与 ComfyUI 社区方案复核

日期：2026-08-29  
对象：iDream 的 RedCraft Krea2 Identity Edit、MiniMax H3 与 RedGraft LTX 视频路径  
本机：M4 Max 128 GB / macOS 26.5.1 / PyTorch 2.13.0 / ComfyUI 0.34.2

## 结论

1. **社区已经解决“FP8 checkpoint 在 Mac 上能加载、能生成”，没有解决“M4 原生 FP8 乘加”。** M1–M4 的主流实现都是在 Metal/MPS 上把 FP8 bytes 解码成 FP16/BF16，再调用普通浮点 GEMM。真正不展开 FP8 的 Metal 4.1 kernel，目前社区实现明确要求 M5、macOS 27 与对应工具链。
2. **我们已经安装了目前最完整的 ComfyUI 兼容层。** `ComfyUI-AppleSilicon-FP8` v1.3.1 已在本机；生产启动器为了保护 RedGraft 视频，只启用 `tensor_to_fp8,int_mm_mps`。它使当前 RedCraft scaled-FP8 + Identity v1.2 full 跑通，但每个 denoise step 仍有 FP8 weight → BF16 decode 成本。
3. **不能再叠装旧 FP8 包。** `fp8-mps-metal`、`fp4-fp8-for-torch-mps` 与当前插件会改写相同的 `Tensor.to`、`F.linear` 或 `_scaled_mm` 调用缝。叠加后无法可靠归因，现代 PyTorch 2.13 还增加了 `F.scaled_mm` / `aten::_scaled_mm_v2` 新缝，旧补丁可能完全不命中。
4. **离线 BF16 候选已经被本机 A/B 否决为服务默认。** 它能去掉采样期逐层 decode，却把 base 从约 12 GiB 扩到约 24 GiB；匹配 warm run 也没有快过 FP8。正确默认是 FP8 常驻 + 每层瞬态 BF16 compute，而不是整模 BF16 常驻。
5. **MLX 已有 Krea2 Turbo 实现，但没有可直接替换当前 Identity Edit 的实现。** `ComfyUI-Krea2-MLX` 是自包含 T2I island，不输出 ComfyUI `MODEL`；MFLUX 的 img2img 是传统 init-latent 加噪，不是 Identity v1.2 的 Qwen3-VL grounded instruction + clean source token 双条件机制。
6. **视频有一个新的、值得单独测的社区方案：`ComfyUI-SolAttn-MPS`。** 它对 MiniMax H3 报告 1.30–1.44× 端到端加速，并有 BF16/MPS 实现；但它不支持 Krea2，也不支持当前 RedGraft LTX 2.5，而且要求 PyTorch attention。只能在 H3 候选图和独立视频进程中做 A/B，不能改 RedGraft 已验证路径。

## 本机事实

| 项目 | 当前结果 | 含义 |
|---|---|---|
| Python / Torch | 3.13.12 / 2.13.0 | `F.scaled_mm` 已存在，旧 `_scaled_mm`-only 补丁不完整 |
| MPS | built/available 均为 true | 普通 FP16/BF16/FP32 GPU compute 正常 |
| Xcode / SDK | Xcode 26.6 / SDK 26.5 | 没有 Metal 4.1 FP8 类型；`xcrun metal` 还缺独立 Metal Toolchain |
| Apple FP8 插件 | v1.3.1，commit `911294c` | 已含 `F.scaled_mm` v2 修复；不是漏装插件 |
| 当前启动补丁 | `tensor_to_fp8,int_mm_mps` | 兼容优先；没有开启全局实验 kernel |
| `mtlflashattn` | 未安装 | 当前生产没有偷偷走社区 flash kernel |
| 图片/视频进程 | 8189 PyTorch attention / 8188 split attention | 两条数学路径已隔离，队列检查为 0/0 |

本机代表 Krea2 GEMM `6656×6144 @ 6144×6144` 的同进程 micro-benchmark：

| dtype | 单次 matmul |
|---|---:|
| FP16 | 33.035 ms |
| BF16 | **32.894 ms** |
| FP32 | 36.664 ms |

因此，“全局转 FP16”或“`--force-fp32`”在这台 M4 上没有矩阵乘层面的速度依据。此前独立进程还测得 `PYTORCH_MPS_PREFER_METAL=1` 把同类 BF16 GEMM 从约 33 ms 降级到约 365 ms，`PYTORCH_MPS_FAST_MATH=1` 无可测收益。

## 社区实现逐项复核

### 1. ComfyUI-AppleSilicon-FP8：保留，已是当前最完整兼容层

来源：[pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8)

它实际有三层能力：

- M1–M4 通用兼容：FP8 LUT decode、Comfy Kitchen 修补、`Tensor.to`、`F.linear`、`torch._scaled_mm` 与新版 `F.scaled_mm` 包装；
- M1–M4 可用的局部 shader：RMSNorm、RoPE、部分 attention；
- M5 专用量化 GEMM：Metal 4.0 INT8、Metal 4.1 FP8，门槛还包括 `ninja` 与逐 kernel self-check。

插件自己的 README 明确说明：没有合适硬件时，FP8 权重仍在 matmul 前按算子解码为 BF16；它没有声称整模 BF16 一定更快。整模 BF16 省去反量化但把常驻权重翻倍，最终速度取决于解码开销与统一内存压力，必须做本机 A/B。其 v1.3.1 已修复 comfy-kitchen 0.2.28+ 改走 `F.scaled_mm` 后旧补丁失效的问题，见 [issue #19](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/issues/19)。

对本机判断：

- `tensor_to_fp8` 是当前 RedCraft 跑通所需兼容层；
- native FP8 kernel 不能在 M4 / SDK 26.5 上使用；
- 强加 `--supports-fp8-compute` 会让 activation 进入 FP8 量化再解码，可能增加 CPU/GPU 往返或双重解码；
- 已执行的 image-only `fused_norm_mps + rope_fast_mps + MPS text encoder` 全生成 A/B 比冷基线更慢，不进入生产。

### 2. fp8-mps-metal：代码能解释 FP8，但不适合当前栈

来源：[tashiscool/fp8-mps-metal](https://github.com/tashiscool/fp8-mps-metal)

实现方式：monkey-patch `torch._scaled_mm`；小 `M` 用自写 Metal FP8 decode/matmul，大于 16 行时把 A、B 两端都解码为 FP16，再用原生 FP16 matmul。

不采用的原因：

- 当前 HEAD 只包旧 `torch._scaled_mm`，没有处理 PyTorch 2.13 的 `F.scaled_mm` v2；
- Krea2 diffusion token 的 `M` 远大于 16，实际会走“两端 FP8 → FP16 → GEMM”，不是 native FP8；
- 它的公开性能主要比较 CPU fallback，而我们当前已是 GPU LUT decode + BF16 GEMM，不是 CPU fallback；
- 与已安装插件改写同一全局 seam，不能叠加。

### 3. fp4-fp8-for-torch-mps：适合“使 checkpoint 可运行”，不是当前提速答案

来源：[PyPI](https://pypi.org/project/fp4-fp8-for-torch-mps/)、[源码](https://github.com/AppMana/mps-fp8-for-torch-and-comfyui-python-package)

v1.0.3 用 `torch.library` 注册 MPS `_scaled_mm`，同时覆盖 FP8/FP4 encode、decode、copy、mm、linear。它比手改 ComfyUI core 更整洁，之前也让 iDream 的 Qwen plain-FP8 路径跑通过。

但当前 RedCraft 不采用：

- 仍是软件 decode/encode 与浮点 matmul；
- 源码没有当前 `F.scaled_mm` v2 的专门包装；
- 与 AppleSilicon-FP8 的全局 dtype/operator patch 重叠；
- 之前 Qwen 热态 A/B 没有提速，不能把“能跑”写成“更快”。

### 4. MPS-Accelerate：Flux/M2 的 22% 不能外推到 RedCraft/M4

来源：[SrinivasMohanVfx/mps-accelerate](https://github.com/SrinivasMohanVfx/mps-accelerate)

它通过 C++ 直接调用 `MPSMatrixMultiplication`，绕开 PyTorch/MPSGraph 的 dispatch。作者在 M2 Max、Flux.1 BF16、5 steps 上报告 10.6 → 8.3 s/it。

源码审查发现：

- ComfyUI wrapper 只处理稠密 FP16/BF16 `F.linear`；
- 对 BF16 input/weight，每次调用都会 `.half()` 后再算，并把输出转回 BF16；转换后的 weight 没有被缓存；
- 预编译二进制面向 Python 3.11，本机 Python 3.13 必须自行重编；
- 当前 RedCraft 的额外成本恰好是 FP8 weight 每步先解码为 BF16，再加一次 BF16→FP16 不具备优势。

本机代表 GEMM 中 BF16 还略快于 FP16，所以不安装。若未来重写为“加载时一次性安全转 FP16并缓存”，才值得独立评估。

### 5. mtlflashattn：当前 ref_boost=4 的 Krea2 路径不会命中

来源：[mtlflashattn](https://pypi.org/project/mtlflashattn/)

它对 M5 的 TensorOps attention 有强性能数据，M1–M4 也提供 FP16 `simdgroup_matrix` v1。但是其 SDPA wrapper 对 `attn_mask is not None` 直接判定不适用；当前 Identity Edit 的 `ref_boost=4` 正是通过 dense additive attention bias 实现。即使 `ref_boost=1` 去掉 mask，当前 Krea2 是 BF16，M4 自动 tier 会落到 chunked FP32 torch path，而不是 FP16 v1 快核。

因此：

- 默认 identity profile 不适用；
- 不能拿 M5 3–11× attention micro-benchmark外推到 M4 的 Krea2 E2E；
- 已实测 `ref_boost=1` 自身能让当前 NSFW edit E2E 快约 9.1%，这是更直接、已验证的快档，但身份锁定略弱。

### 6. MLX / MFLUX：值得关注，但还不是 Identity Edit 替代品

来源：[ComfyUI-Krea2-MLX](https://github.com/Cthomasdesign/ComfyUI-Krea2-MLX)、[MFLUX Krea2](https://github.com/mflux-community/mflux/blob/main/src/mflux/models/krea2/README.md)

`ComfyUI-Krea2-MLX` v0.4：

- mixed-4/8 与 8-bit Krea2 Turbo；
- 自包含 `load → LoRA → generate → IMAGE`；
- 不暴露 torch `MODEL`，不能接原生 KSampler/ControlNet/`comfyui-krea2edit`；
- 作者 M1 Max 数据为 1024² / 8 steps 约 263 秒；不是当前 M4 Identity Edit 的替代基准。

MFLUX 已支持 Krea2 Turbo、量化、LoRA 和传统 img2img，但其 img2img 明确是“VAE encode init image → 加噪 → denoise”。Identity v1.2 需要 Qwen3-VL image-grounded instruction 和 clean reference latent tokens 同时进入 28 个 DiT block，两者不是同一算法。

社区还有一个 [Krea2-Identity-Edit-Diffusers](https://github.com/huan-yin/Krea2-Identity-Edit-Diffusers)，确实复刻了双条件机制，但公开示例使用 CUDA generator，没有 MPS 端到端耗时、内存或一致性数据。它适合以后做 MLX/MPS port 的规格参考，不是现在的生产替换。

### 7. mps-bitsandbytes：不是 ComfyUI scaled-FP8 checkpoint 的直接 loader

来源：[mpsops/mps-bitsandbytes](https://github.com/mpsops/mps-bitsandbytes)

它提供自己的 `LinearFP8`、`Linear8bit`、NF4/FP4 与 `quantize_model()`，面向 Hugging Face/LLM 模块替换。当前 RedCraft 是 comfy-kitchen `TensorCoreFP8` layout，Identity LoRA 还覆盖全部 256 个 quantized Linear；没有现成 Krea2/ComfyUI loader 把这些 layout、scale 与 LoRA patch 语义映射过去。没有完整 Krea2 render 证据前，不作为候选。

### 8. ComfyUI-SolAttn-MPS：H3 视频的高价值候选，不碰 RedGraft LTX

来源：[yshenaw/ComfyUI-SolAttn-MPS](https://github.com/yshenaw/ComfyUI-SolAttn-MPS)

它为 MiniMax H3 的长序列 self-attention实现 BF16 Metal tiled kernel，并保留 exact sink/fallback。作者公开的 M3 Ultra 实测：

- 864×480 / 124 帧：完整生成 278.55 → 194.18 秒，1.435×；
- 1280×720 / 124 帧：731.27 → 560.45 秒，1.305×；
- 864×480 / 362 帧：1051.78 → 756.66 秒，1.390×。

适用边界：

- 仅 MiniMax H3；不是 Krea2，也不是 LTX 2.5；
- 推荐 PyTorch 2.13，本机版本满足；
- 要求 `--use-pytorch-cross-attention`，而当前视频 runner 为保护 RedGraft 使用 split attention；
- 只能另建 H3 候选 workflow/runner 做同 seed、同帧数、视频+音频完整 A/B。

## 真正值得执行的顺序

### 图片

1. 保留当前生产默认：RedCraft FP8 resident + per-op BF16 compute、832×1216、8 steps、完整 Identity v1.2、`ref_boost=4`。
2. 保留 workflow v4 的 `target_latent` 预编码并移除重复 source VAE encode，避免采样期模型驱逐/流送。
3. 图片独立使用 8189 + PyTorch attention + 最小已验证补丁；不启用实测更慢的 Tier-A kernel 组合。
4. 不把 `ref_boost=1` 或低秩 LoRA作为默认提速手段，因为它们会降低用户要求保持的身份锁定。

### 视频

1. RedGraft LTX 2.5 继续用独立 8188 + split attention + 当前两个兼容补丁。
2. MiniMax H3 若继续投入，单独测试 SolAttn-MPS；通过条件包括全帧 decode、AAC、NaN/黑帧检查和 identity/动作目检。
3. Spectrum/FirstBlockCache 等近似缓存仍是后续质量换速度候选，不能与 SolAttn 一次同时启用，否则无法归因。

## 明确不做

- 不强开 `--supports-fp8-compute`；
- 不叠装多个 FP8 monkey-patch 包；
- 不为 M4 强制编译 M5/Metal 4.1 kernel；
- 不把 macOS beta 或安装 Metal CLI 当成硬件升级；
- 不用 `--force-fp32` 或全局 FP16 代替真实 A/B；
- 不把 MLX T2I、传统 img2img 或 CUDA Diffusers demo 宣称为 Identity Edit 已迁移；
- 不把整模 BF16 候选提升为生产配置；当前单变量 warm A/B 已否决它。

## 关联记录

- [Mac FP8 修复与 RedCraft 适用性](./MAC_FP8_REPAIR_REDCRAFT_APPLICABILITY_2026-08-28.md)
- [RedCraft Krea2 Identity Edit 速度与 NSFW 实跑](./REDCRAFT_KREA2_IDENTITY_SPEED_NSFW_RECHECK_2026-08-29.md)
- [MiniMax H3 Apple Silicon 加速方案](./MINIMAX_H3_APPLE_SILICON_ACCELERATION_2026-08-20.md)
