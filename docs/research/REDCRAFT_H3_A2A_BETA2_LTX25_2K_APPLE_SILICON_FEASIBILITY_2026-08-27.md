# RedCraft H3 A2A beta2 + LTX 2.5 2K 在 Apple Silicon M4 上的可行性

日期：2026-08-27  
目标：[Civitai Red 模型页，version `3262321`](https://civitai.red/models/958009/redcraft-or-or-redmix-hybrid-a2a-beta2-ltx25-2k?modelVersionId=3262321)  
证据口径：公开来源统一访问于 2026-08-27；本机事实来自同日只读探针。

## 结论

**如果“适合”指下载后按作者工作流直接在 Mac 上稳定生成 2K：目前不适合。** Civitai `3262321` 实际只发布了一个约 **20.97 GiB 的 MiniMax H3 INT8 diffusion checkpoint**，没有发布作者所说的 LTX 2.5、IC-LoRA、RIFE、VSR 资产或完整 workflow JSON。页面的“2K”描述的是一条 H3 草稿 → LTX 2.5 V2V → 插帧 → 超分的多阶段管线，不是这个 checkpoint 自己直接输出 2K。[版本 API](https://civitai.red/api/v1/model-versions/3262321)、[模型 API](https://civitai.red/api/v1/models/958009)（访问：2026-08-27）。

**如果“适合”指在我们的 M4 Max 128 GB 上做工程验证：可以，而且容量足够，但必须重建 Mac 路线，不能照搬作者的 CUDA/INT8 路线。** 最稳妥的做法是让 H3 与 LTX 分阶段加载、在 LTX 阶段使用 BF16 + MPS streaming/offload、split attention、禁用模型缓存并分块解码/超分。官方 LTX Desktop 1.2.7 已支持 Apple Silicon，并修复 LTX 2.5 Fast 在 MPS denoise 时内存暴涨与冻结；官方代码也记录了 M4 Pro 48 GB 的 streaming 端到端验证。[LTX Desktop v1.2.7](https://github.com/Lightricks/LTX-Desktop/releases/tag/v1.2.7)、[runtime policy](https://github.com/Lightricks/LTX-Desktop/blob/v1.2.7/backend/runtime_config/runtime_policy.py)（访问：2026-08-27）。这证明 **LTX 2.5 单阶段有官方 Mac 路径**，不证明 RedCraft 的完整双阶段 2K 图已经在 Mac 上跑通。

内存建议不是一个数字：

| 统一内存 | 对这个完整混合管线的判断 |
| --- | --- |
| 16 / 24 GB | **不建议**。官方 LTX Desktop 的 `>=15 GB free RAM` 只是 LTX 单阶段进入磁盘 streaming 的启动门槛，不是 H3 + LTX + 2K 后处理的总需求。 |
| 32 GB | **不适合完整链**。H3 文件本身已 20.97 GiB；加文本编码器、VAE、激活、OS 后没有可靠余量。 |
| 48 / 64 GB | **可做缩规格、分阶段试验**。官方只验证过 M4 Pro 48 GB 的 LTX streaming；完整 RedCraft 2K 无实证。 |
| 96 GB | **有希望完成分阶段 BF16/streaming**，但 2K 峰值和耗时仍未验证。 |
| 128 GB | **本项目推荐规格**。足以给 BF16 LTX、H3、OS 与中间张量留出可操作余量；仍需逐级 smoke，不能宣称即插即用或实时。 |

磁盘同样是硬约束：按现有 H3 依赖和官方 LTX 2.5 文件计算，CUDA 风格的双 INT8 静态资产约 **77.24 GiB**；Mac 为避开 MPS INT8 阻塞而采用 BF16 LTX 时约 **106.49 GiB**。两者都还没算作者未公开的 RIFE/VSR、Python/ComfyUI 环境、中间帧与成品。实际应至少预留 **150 GiB**，更稳妥是 **200 GiB** 空闲磁盘。这是容量规划值，不是经作者验证的最低要求。

## 1. `3262321` 到底包含什么

[Civitai version API](https://civitai.red/api/v1/model-versions/3262321) 当前只返回一个下载文件（访问：2026-08-27）：

| 字段 | 值 |
| --- | --- |
| 版本名 | `H3 A2A-RED ( beta2 )` |
| base model | `MiniMax H3` |
| 文件 | `redcraftREDMIXHybridA2A_h3A2AREDBeta2.safetensors` |
| 类型 / 精度 | Diffusion Model / SafeTensor / `int8` |
| 大小 | `21,984,166.7265625 KiB`，约 **20.966 GiB** |
| SHA-256 | `6A1E09871380982A96C0AF058AF35CD61B34E4A47A567B4704BDAA7D0F5FD60F` |
| 下载入口 | [Civitai download API](https://civitai.red/api/download/models/3262321?fileId=3145880) |

作者描述的完整流程是：

1. MiniMax H3 以约 6 steps 生成低分辨率、带语义与音频的草稿；
2. LTX 2.5 22B 用 IC-LoRA 引导做 V2V，蒸馏阶段约 8 steps；
3. latent ×2 upscaler 再约 3 steps；
4. RIFE 插到 48 fps；
5. VSR 输出约 1440×2160。

作者给出的性能是 NVIDIA CUDA 数据：A5000 24 GB 生成 8 秒 2K 约 200 秒、5090D 24 GB 约 120 秒，并称 `16 GB+ VRAM`，更低显存需 offload、tile、CPU 或降低分辨率/时长。这些数字不能换算成 Mac 统一内存要求，也不是 MPS benchmark。[目标模型页](https://civitai.red/models/958009/redcraft-or-or-redmix-hybrid-a2a-beta2-ltx25-2k?modelVersionId=3262321)（访问：2026-08-27）。

版本 API 的十个样例只提供 prompt、steps、sampler、CFG 和输出尺寸等摘要；主要样例为 1440×2160、19 steps，另有 768×1152 / 11 steps 和 21-step 样例。API 没有 `comfy` / `workflow` 图、节点版本、帧数、时长或逐阶段资源记录。因此样例能证明作者产出了高分辨率结果，不能让我们复现其完整管线。[版本 API](https://civitai.red/api/v1/model-versions/3262321)（访问：2026-08-27）。

## 2. 文件与磁盘边界

### H3 阶段

beta2 只公开 DiT。若它继续复用项目现有 beta1 的 Qwen3-VL 32B Q4 与 MiniMax H3 video/audio VAE，则 H3 阶段静态资产约为：

| 资产 | 大小 |
| --- | ---: |
| beta2 H3 INT8 diffusion | 20.966 GiB |
| Qwen3-VL 32B Q4 text encoder | 13.576 GiB |
| H3 video VAE FP16 | 4.850 GiB |
| H3 audio VAE FP32 | 0.564 GiB |
| **小计** | **39.955 GiB** |

这里的 text encoder / VAE 复用是根据现有 beta1 资产做的工程假设，不是 beta2 作者公开 workflow 的确认项。

### LTX 2.5 阶段

官方 [LTX-2.5 模型库](https://huggingface.co/Lightricks/LTX-2.5/tree/main) 与 [IC-LoRA Pixel Spatial Upscaler](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler/tree/main) 提供的核心文件如下（访问：2026-08-27）：

| 资产 | Comfy INT8 | BF16 / 通用文件 |
| --- | ---: | ---: |
| LTX 2.5 distilled transformer | 20.027 GiB | 39.132 GiB |
| Gemma 4 12B + projection | 14.317 GiB | 24.460 GiB |
| video diffusion VAE | — | 1.371 GiB |
| audio VAE | — | 0.340 GiB |
| spatial upscaler | — | 0.927 GiB |
| IC-LoRA pixel spatial upscaler | — | 0.305 GiB |
| **LTX 小计** | **37.288 GiB** | **66.536 GiB** |

因此：

- H3 约 39.955 + LTX INT8 约 37.288 = **77.243 GiB**；
- H3 约 39.955 + LTX BF16 约 66.536 = **106.491 GiB**。

这些是磁盘资产加总，**不是峰值统一内存**。正确实现应在 H3 完成后卸载 H3 DiT/TE，再加载 LTX；VAE、latent、参考视频、RIFE/VSR 和输出编码仍会形成额外峰值。反过来，磁盘上两套资产必须同时存在，不能用“分阶段不常驻”抵消磁盘需求。

官方 LTX 2.5 还提供 temporal upscaler、duration head 和其它 LoRA；作者所用 RIFE/VSR 的具体仓库和文件均未公开，所以本表没有把它们猜进总数。[LTX-2.5 文件树](https://huggingface.co/Lightricks/LTX-2.5/tree/main)（访问：2026-08-27）。

## 3. Apple Silicon 已经获得的官方支持

### LTX Desktop 1.2.7：真实、但只覆盖 LTX

官方 [LTX Desktop README](https://github.com/Lightricks/LTX-Desktop/tree/v1.2.7#local-vs-api-mode) 把 Apple Silicon + MPS 列为本地生成平台，要求 macOS 13+，启动时有 **至少约 15 GB 空闲 RAM**；Intel Mac 或低于门槛时退回 API-only。这里检查的是空闲 RAM，不是机器标称总内存，而且只在 backend 启动时检查一次（访问：2026-08-27）。

[v1.2.7 release](https://github.com/Lightricks/LTX-Desktop/releases/tag/v1.2.7) 于 2026-08-26 明确修复：Apple Silicon 上本地 LTX 2.5 Fast 在 denoise 时不再把内存冲到几十 GB并冻结（访问：2026-08-27）。这比早期社区 issue 更强，是当前应优先采用的官方 MPS 基线。

[v1.2.7 runtime policy](https://github.com/Lightricks/LTX-Desktop/blob/v1.2.7/backend/runtime_config/runtime_policy.py) 还明确记录：

- Darwin streaming 最低门槛是约 15 GB **free RAM**；
- 该门槛来自测得约 13 GB RSS 再留余量，只是单点数据，不是硬件普查；
- M4 Pro 48 GB 的 **streaming_models_loading** 是已经端到端验证的 Darwin 路径；
- MPS 没有该项目的 FP8 路径，因此 streaming 从磁盘 mmap，而不是持有 CUDA FP8 transformer；
- `>=85 GB free RAM` 才切到 full-resident，但源码明确标注这个层级仍未在真实硬件验证。

官方性能文档说明，发布版 Mac 使用预编译、zero-copy 的 `mps-sdpa` 扩展；开发态 JIT 路径的注意力与内存曲线可能不同，Mac 性能应以打包应用实际运行测量为准。[performance runner](https://github.com/Lightricks/LTX-Desktop/blob/v1.2.7/backend/performance_runner/README.md)（访问：2026-08-27）。

这些事实把“Mac 是否支持 LTX”从猜测变成了肯定答案，但边界必须保持：LTX Desktop 没有加载 Civitai 的 H3 checkpoint，也没有复现作者的 H3 音频草稿、LTX IC-LoRA V2V、RIFE 和 VSR 拼图。

### 官方 LTX-2 Python 路线

[Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) 当前源码已经有 CUDA → MPS → CPU 的 device 选择、MPS SDPA 和 MPS 音频/vocoder 路径；Apple Silicon 安装 `mps-sdpa`。NATTEN 快路径仍限 Linux + CUDA，macOS 使用 eager / pure-PyTorch attention。[安装说明](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/installation.md)、[优化说明](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/optimization.md)、[device source](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-core/src/ltx_core/devices.py)（访问：2026-08-27）。

官方 `ICLoraPipeline` 能用参考视频做 distilled LTX 两阶段条件生成，因此是重建 H3→LTX V2V 的最干净 Mac 代码基础；但它不是作者未公开 workflow 的等价实现。[pipeline 文档](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/pipelines.md)（访问：2026-08-27）。

## 4. 为什么 Civitai INT8 不能直接当作 Mac 加速

目标 H3 文件登记为 INT8。现有同作者 H3 beta1 文件的本地 header 是混合 BF16/F32/F16/I8/U8，并含 200 个 `.comfy_quant` tensor，量化元数据为 `int8_tensorwise + convrot=true + groupsize=256`。beta2 匿名下载当前返回 403，尚不能核对其精确 tensor/header；因此只能确认 Civitai 的 `fp=int8` 登记，不能把 beta1 header 无条件套给 beta2。

对官方 Comfy LTX 2.5 INT8 文件，阻塞则是确定的：

- 官方 [Comfy INT8 量化文档](https://github.com/Comfy-Org/comfy-quants/blob/main/docs/quantization/ltx2.md) 把 tensorwise ConvRot 快速路径要求写为 NVIDIA CUDA SM >= 7.5；
- comfy-kitchen 的 eager INT8 乘法最终调用 `torch._int_mm`；其 [MPS issue #92](https://github.com/Comfy-Org/comfy-kitchen/issues/92) 说明 MPS 没有该算子，`PYTORCH_ENABLE_MPS_FALLBACK=1` 会产生逐层 CPU round-trip，不能视为可用加速；
- PyTorch [issue #190337](https://github.com/pytorch/pytorch/issues/190337) 在 M4 Pro/nightly 上同样复现 `_int_mm` 无 MPS kernel，并关闭为 not planned。

以上来源均访问于 2026-08-27。本机当前 ComfyUI 0.33.0 / PyTorch 2.10 / MPS 直接 probe 也返回 `_int_mm` 无 MPS kernel。因此：

- ComfyUI“能识别 INT8 ConvRot 文件”不等于 MPS 能原生加速；
- 开 CPU fallback 可能越过异常，但很可能极慢；
- NVIDIA 专用 NVFP4/FP8 也不是 M4 路线；
- Mac 上当前应选择 BF16 LTX + 官方 MPS streaming，而不是期望 Comfy INT8 获得 CUDA 宣称的显存/速度收益。

## 5. 本机证据与它能证明什么

同日只读检查确认本机是 Apple M4 Max、128 GB 统一内存；活动 ComfyUI 为 0.33.0、PyTorch 2.10.0、device=`mps`。项目已有 RedCraft H3 beta1 的真实 MPS 闭环：512×512、124 帧、24 fps、约 5.17 秒、8 steps，生成 H.264 + AAC；一次已记录的完整运行约 667 秒，其中 sampling 约 565 秒。

这证明：

- MiniMax H3 A2A 类 checkpoint 可在本机 MPS 栈完成视频与音频生成；
- 128 GB 对 H3 单阶段有充足容量；
- 本机不是依赖 NVIDIA 才能得到任何结果。

它不证明：

- beta2 与 beta1 tensor 布局完全一致；
- beta2 能无修改加载；
- LTX 2.5 二阶段、IC-LoRA、RIFE、VSR 已接通；
- 1440×2160 / 8 秒的完整链能在 128 GB 内无 swap 完成；
- INT8 在 MPS 上获得原生加速。事实上 `_int_mm` probe 证明最后一点不成立。

## 6. 推荐的 Mac 支持路线

### 路线 A：官方 LTX Desktop 1.2.7，先建立 LTX/MPS 基线

这是最小、风险最低的第一步：先用发布版 arm64 应用验证本机 LTX 2.5 Fast、MPS memory fix、streaming 和输出质量。它不能直接载入 RedCraft H3 混合图，但能把“LTX 2.5 在这台 Mac 上是否稳定”独立验清。[v1.2.7 release](https://github.com/Lightricks/LTX-Desktop/releases/tag/v1.2.7)（访问：2026-08-27）。

### 路线 B：官方 LTX-2 MPS + 自建两阶段编排，推荐

1. 固定并 load-only 检查 beta2 SHA-256/header；
2. 用现有 H3 图先跑 512×512、约 5 秒、低步数，确认视频、音频、峰值内存；
3. 持久化 H3 成品后主动卸载 H3 DiT/TE；
4. 以官方 LTX-2 `ICLoraPipeline`、BF16 transformer/Gemma、`mps-sdpa` 和 disk/CPU offload 做 1280×736、约 5 秒 V2V；
5. 先用较轻的 conv VAE 或 tiled decode，稳定后再比较 diffusion VAE；
6. 最后才加 IC upscaler、RIFE、VSR，并逐阶段记录 peak RSS、swap、wall time 和中间文件。

这是最符合 Mac 现状的工程路线，但得到的是“按作者描述重建的兼容管线”，不能命名为作者原 workflow。

### 路线 C：ComfyUI 全图，只有拿到作者 workflow 后再做

若要保留作者节点图，应把 LTX transformer 与 Gemma INT8 ConvRot 换成 BF16，并从以下保守参数起步：

- `--lowvram --cache-none --use-split-cross-attention`；
- H3 和 LTX 分阶段卸载；
- 1280×736 / 5 秒先行；
- VAE、latent upscaler、VSR 都采用 tile；
- 保留 H3 原音轨，RIFE/VSR 最后接入。

官方 [ComfyUI LTX 2.5 模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_ltx2_5_i2v.json) 可以提供节点和文件布局参考，但其默认使用 INT8 ConvRot transformer/Gemma，不能原样当作 MPS 快路径（访问：2026-08-27）。

### 路线 D：MLX，只作研究候选

Apple [MLX unified memory 文档](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html) 说明 MLX 能在统一内存中避免 CPU/GPU tensor 复制（访问：2026-08-27）。但 Lightricks 没有发布官方 MLX 版 LTX 2.5 完整管线，Civitai safetensors/Comfy workflow 也不能直接交给 MLX。社区转换需要另一套权重和自定义编排，本轮没有找到 H3 beta2 → LTX 2.5 → 2K 在 M4 上的完整实证。因此它不是当前最快落地方式。

## 7. 验证门槛

在把该模型接入本项目之前，至少需要四级证据：

1. **供应链**：下载 beta2，校验文件名、大小、SHA-256 与完整 safetensors header；
2. **H3 单阶段**：固定 512×512 / 124 帧 / 8 steps，验证视频、AAC 音轨、峰值统一内存与 wall time；
3. **LTX 单阶段**：固定 1280×736 / 121 帧 / 8+3 steps，验证 BF16 MPS streaming、V2V identity retention、无黑帧/NaN；
4. **完整链**：再升到作者目标约 1440×2160 / 8 秒 / 48 fps，逐阶段记录 H3、LTX、upscale、RIFE、VSR 的耗时、RSS、swap 与产物。

任一阶段出现持续 swap、MPS NaN/黑帧、音画时长漂移或 denoise 内存失控，就停在该层排查，不继续堆后处理。

## 8. 证据缺口

目前无法诚实给出“至少 X GB 就一定能完成作者 2K 工作流”，原因是：

- beta2 下载在匿名探测时返回 403，未检查精确量化 header；
- Civitai 只给 H3 checkpoint，完整 workflow、节点版本和其它资产未公开；
- beta2 是否复用现有 Qwen3-VL 32B Q4、H3 video/audio VAE 未被作者锁定；
- LTX IC-LoRA、RIFE、VSR 的精确文件与版本未公开；
- 作者的 16 GB+、A5000/5090D 数据是 CUDA，不含 MPS；
- LTX Desktop 的 M4 Pro 48 GB 实证只覆盖其官方 LTX pipeline，不覆盖 RedCraft 双阶段图；
- 没有 exact beta2 + LTX 2.5 + 1440×2160 / 8 秒 / 48 fps 的 M4 峰值内存和 wall time。

所以当前最准确的产品判断是：**我们的 M4 Max 128 GB 值得做本地验证，容量不是首要阻塞；首要阻塞是作者没有公开可复现的完整工作流，以及 INT8 ConvRot 没有原生 MPS kernel。** 如果只求尽快获得作者声称的速度，24 GB NVIDIA CUDA 仍是有公开作者实测的路径；如果坚持 Mac，本项目应采用官方 LTX Desktop/LTX-2 的 BF16 MPS streaming 基线，按阶段重建和验收。
