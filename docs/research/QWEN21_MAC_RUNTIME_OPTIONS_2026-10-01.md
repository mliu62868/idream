# REDQW21 V2 图生图：Mac 优化方法与实施优先级

> 后续实施更新（2026-10-01）：本地已启用 VAE 修复、单图 MPS INT8 编码与 Viggle 六步，并完成真实产品交付/持久化/单次扣费验证。本文保留当轮历史状态；最新配置、数值 oracle 与耗时见 [实施记录](QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md)。

调研日期：2026-10-01。范围是当前 REDQW21 V2 / Qwen-Image-2.1 参考编辑，保留用户指定的 8 位编码器选择。证据分为本机实测、实现者一手报告、源码可达路径和待验证假设。本轮只读取运行状态、模型文件头部及公开源码，没有启停服务、换默认配方、安装依赖或新增真实生成。

## 结论与优先级

**短期先验证 VAE 正确性，再试同一 INT8 编码器在新版环境上 MPS、图像模型常驻及真正的 Metal attention。长期最值得建立的原生候选是 MFLUX 的 Qwen 2.1 编辑实现，但它仍有调度接线和参考编辑算子路径的问题，不能直接承诺替换后达到 16 秒。**

| 顺序 | 方法 | 当前证据 / 必须补齐的检查 |
| --- | --- | --- |
| 1 | 原尺寸参考 VAE 的 CPU/MPS 对照 | 旧环境已发生参考 latent 冷热大幅漂移；2.14 统计接近不等于已修复所有 MPS 编码问题。先做 832×1216 encode→decode 与 CPU oracle 对照 |
| 2 | 编码器 CPU→MPS，避免重复加载 | 同一社区 INT8 ConvRot 文件可保持不变；现有 loader 已有显式 `mps` 选项。此前设备比较受 VAE 干扰，需要在正确的参考 latent 上重测，不用全局 `--gpu-only` |
| 3 | MFLUX 原生 MLX 编辑 / Q8 | 已有真正的 2.1 多参考编辑源码；须打包 REDV2、正确转换编码器量化、修复 Viggle scheduler 传递并验证 reference path，详见后文 |
| 4 | Metal flash attention 与相关矩阵算子 | 已测 MPSGraph zero-copy 没收益；它不等于所有 Metal FlashAttention。当前 Qwen 2.1 的实际 query/key 长度、dtype、mask 与 KV 缓存决定是否命中快路径 |
| 5 | 正确的 6 步 / 4 NFE 配方 | Viggle v0.3 6 步本机单例 69.45 秒；PAI 4 NFE 需要 PDD 输出头与调度器，不能只把 KSampler 改成 4 步 |
| 6 | M5 GPU Neural Accelerator 内核 | M5 专用量化 GEMM / attention 有一手实现；当前 M4 Max 不具备该硬件路径，CUDA、Krea2 或旧 Qwen 数据不能直接外推 |

这些是验证排序，不是未经实测的收益承诺。保持同一 REDV2 权重内容、prompt、参考图、输出尺寸和 seed；把改变运行实现、量化格式、采样配方、分辨率分别作为独立变量。

## 本地瓶颈：步数只解释了一部分

当前硬件是 Apple M4 Max、128 GiB、macOS 26.5.1；image API 确认 ComfyUI 0.37.0 / PyTorch 2.14.0 / MPS。默认单图依然是 REDV2 BF16、CPU 社区 INT8 Qwen3-VL 8B、原生无损 prefix-KV、10 步 CFG 1；Rapid-AIO 已退役。[已有实测记录](QWEN21_MAC_IMAGE_EDIT_ACCELERATION_2026-10-01.md)

| 同一 832×1216 单参考编辑 | 总耗时 | 原生执行 | 采样 | 原生执行减采样 |
| --- | ---: | ---: | ---: | ---: |
| 新环境原始 10 步 | 93.526 s | 93.117 s | 约 64.3 s | 约 28.8 s |
| 新环境 Viggle 6 步 | 69.450 s | 68.812 s | 约 39.7 s | 约 29.1 s |

两次准入等待均不足 1 ms，缓存命中节点数均为 0。最后一列包含模型加载、文本/图像编码、参考 VAE、卸载与解码等，不是单独的 LLM 编码计时。此前编码-only 捕获约 19 秒，也不能把它全部算到 LLM 上。

**推断：** 按已测路径，即使非采样开销完全消失，6 步仍需约 39.7 秒；若只从 6 步减到 4 步、其他成本保持不变，粗略模型是 `29.1 + 39.7×4/6 ≈ 55.6 秒`，不是 16 秒。这是成本模型，不是 PAI 实測；蒸馏实现和首步缓存建立会改变每步成本。要接近用户的 M5 Pro 16 秒，必须改变每步效率和固定开销，或确认两次计时采用的是不同工作负载。

用户 16 秒测试的软件、精确权重、参考图数量、分辨率、量化、步数、冷/热状态及计时范围尚未提供。不能验证或否定该数字，也不能仅凭 M4/M5 名称推算其比例。

## VAE 正确性：质量对照的前置条件

社区在 [ComfyUI #16433](https://github.com/Comfy-Org/ComfyUI/issues/16433) 报告 Qwen 2.1 参考 VAE 的 MPS round-trip 异常，并定位到 Wan 2.2 `AvgDown3D` 的 rank-five 时间维前置 `F.pad`；FP32 并非可靠绕过方法。独立报告以零帧 concatenation 绕过 padding，比较 CPU/MPS。源码修复线索是 [PyTorch 72bca5e](https://github.com/pytorch/pytorch/commit/72bca5e6d542341e6bcd795aaa293968843c29b2) 和 [constant pad Metal 迁移 #195368](https://github.com/pytorch/pytorch/pull/195368)。issue 中有 2.15 开发版已修复的报告；不能据此说当前 2.14 安装包含修复。

本地 image 安装的 `comfy/ldm/wan/vae2_2.py:253` 仍调用 `F.pad(x, (0, 0, 0, 0, pad_t, 0))`。本机此前冷/热 reference latent 大幅不同，换正确 Python 后 mean/std 接近；两组 latent 哈希仍不同。**目前只是风险路径存在，尚未证明当前 832×1216 输出有该上游 defect。** 部分社区报告存在尺寸阈值，不能用 256×384 的正常结果替代原尺寸验收，也不能因高分辨率失败就统一关闭 MPS VAE。

最低充分检查：同一输入在 CPU FP32、MPS BF16、MPS FP32 做原尺寸 encode/decode，对齐预处理与参考 latent，记录逐元素误差、PSNR/MAE、冷/热差异；如复现 padding 缺陷，先单独验证 concat 或固定版本 PyTorch 修复，再重做编码器设备、LoRA 和 Cache 的保真比较。CPU VAE、tiled encode 是可比较的绕过臂，不是假定更快的默认配置。

## CPU 编码、常驻与缓存

本项目 [FreshCLIPLoader](../../packages/gen/comfyui_nodes/idream_memory_lifecycle/__init__.py) 每次返回 NaN 的 `IS_CHANGED`，强制重新构造编码器；屏障在所有条件分支完成后销毁 CLIP owner 并清理 RAM cache。它是有意的内存策略，并非未知泄漏。即使同一图像 runner 热运行，也不能假设 8B 编码器一直常驻。

建议先将同一 `qwen3vl_8b_int8_convrot.safetensors` 的 `device` 显式设为 `mps` 做受控对照。loader 支持这个选项，屏障也会释放已完成的 MPS text owner，保留 VAE/DiT。不用全局 `--gpu-only` 改动所有模型或其他 runner。此前 CPU/MPS 画面差异不能充分排除 VAE 混杂因素；CPU 仍是活跃配置，但不应把它描述成已证明唯一保真路径。

128 GiB 图像连续请求可以实验“保留编码器/DiT，切换到视频时再释放”的策略；它可能减少加载与 cache 清理成本，**不消除新 prompt / 新参考图的编码计算**。应记录单图连续请求与 image→video→image 的物理 RSS、MPS driver/allocated、swap 活动及实际 unload。跨 runner 的共享租约和 [memory transition](../../packages/gen/src/backend/comfyui-memory-transition.ts) 仍必须保留；不能仅以 Python 对象已 unload 断言物理内存已释放。

图像 conditioning 缓存只适合真正相同输入复用。缓存键至少包含模型/编码器/VAE内容哈希、prompt 与模板、图像字节与预处理、尺寸、dtype、参考角色/顺序；不同角色或新编辑不可复用整份条件。Qwen 原生 prefix-KV 是单次采样中保留静态参考计算，当前已用，不应重复列为尚未开启的优化。[原生 cache 与参考编码源码](https://github.com/Comfy-Org/ComfyUI/blob/88ab4a06566454ad89db8f0bedb970d6c08cd1b7/comfy_extras/nodes_qwen.py)

INT8 ConvRot 是当前文件格式；MLX affine Q8、GGUF Q8 是不同表示。更小文件并不自动意味着 MPS 真正执行 INT8 GEMM。在现有 M4 环境，量化 dequant/rotation 可能抵消收益；8 位 MLX 路径需正确导入/转换并单独测量，不能把位数相同当作 checkpoint 可互换。

## Comfy / Metal：真正需要测的计算路径

本地 image wrapper 的默认 AppleSilicon allowlist 是 `tensor_to_fp8,int_mm_mps`，没有启用 FlashAttention、fused norm 或 standalone RoPE；native FP8 扩展开关为 off。M4 的硬件条件不能通过强制 flag 改造成 M5。视频的已验证补丁也不能未经图像验证照搬。[launcher](../../scripts/start-comfyui-idream.cjs)

更重要的是 [Qwen 2.1 Attention 源码](https://github.com/Comfy-Org/ComfyUI/blob/88ab4a06566454ad89db8f0bedb970d6c08cd1b7/comfy/ldm/qwen_image21/model.py)：普通推理已走 `ck.rms_rope`；standalone `apply_rope1` 只在 training / attention patches 分支。MLP 已把 gate/up 合在一个 GEMM，并通过 `linear_input_act` 处理 SwiGLU。因此“开启 rope_fast 就能整体快很多”没有路径证据。插件的 LTX `rms_adaln` 接点也不等于 Qwen 的 `ck.adaln` 接点。先用真实激活、调用计数和 GPU profile 确认命中，再谈改动。

[mtlflashattn 固定源码](https://github.com/pawel-mazurkiewicz/mtlflashattn/tree/031ec46d9ed5a9c181ac7f4a3628062786e12ee9) 提供 M1+ simdgroup 与 M5 TensorOps 分层，且 dtype、head dim、序列长度决定路由；作者的快倍率是 attention microbenchmark，不是 REDV2 完整生成。M4 的 BF16/D=128 路径不应套用 M5 快 tier。前轮 MPSGraph zero-copy synthetic 对照与 stock BF16 都约 38–40 ms，没有收益；这没有排除另一套 flash kernel，也没有证明实际模型全部 attention 在同一 backend。

应捕获第一步 block-causal 与后续 prefix-cache 两种 Q/K/V、mask/layout，CPU float64 或分块 FP32 作 oracle；要求记录真正执行的 tier 与 fallback 次数，再比完整编辑。FP16 compute、BF16 compute 分开测，切换后的保真也要验收。

[PyTorch MPS 环境变量文档](https://docs.pytorch.org/docs/stable/mps_environment_variables.html) 提供 `PYTORCH_MPS_PREFER_METAL=1`（matmul backend 对照）、`PYTORCH_MPS_FAST_MATH=1`（改变 fast-math 行为）和 profile/signpost。它们都是实验臂，不是已证实收益。CPU fallback 只是支持未实现 op 的兼容机制；allocator watermark 调大只是内存策略，不能当作计算加速。使用同步后的 stage 计时与 `torch.mps.profiler` / Instruments，区分 CPU launch、GPU GEMM、attention、encoder 与加载。

[AppleSilicon-FP8 的 M5 量化实现](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/tree/9c78935963e885ba93313807974dc64d71058c7f) 有真实 INT8 ConvRot W8A8 Metal 路径，依赖 M5 与 Metal/toolchain；FP8 还受 Metal 版本及支持的 layer shape 限制。作者报告的 Krea2 收益不能外推 REDV2。M5 GPU Neural Accelerators 属于 GPU TensorOps 路径，应与独立 Apple Neural Engine 区分；未找到当前 REDV2 完整 ANE 部署证据。

## 4–6 步配方与其他原生实现

Viggle v0.3 r128 的正确受控路径已测：未合并 scale 1、作者六个 raw sigma 节点、动态分辨率 shift、不做 terminal stretch、Euler / BasicGuider。其收益是 93.526→69.450 秒，约 26%，没有证明多参考身份替换质量。[固定作者配方](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/README.md)

[PAI 4 NFE 固定实现](https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Acc-LoRAs/tree/f7545234760e1847cd8e89e52bd951cb0b7e327f) 替换 `proj_out` 为 PDD 输出头，装载额外 head 参数，设置 `QwenImage21PDDScheduler` 并在每步回调选择 block plan。普通 Euler 4 步不等价；其示例使用 CUDA generator / CPU offload，也没有给当前 Mac + REDV2 的兼容和速度验收。先证明输出头、sigmas 和回调正确，再建立 MPS/MLX 实现，不能将 Qwen-Image 旧版 Lightning 当 2.1 LoRA。

[qwen-image-cplus 固定版本](https://github.com/netdur/qwen-image-cplus/tree/027bff8c68ddce06cb7fb318c8c79748b68b1f35) 的原作者提供原生 Metal C/C+ API、多参考编辑和 qipack 格式。M1 Max 的 38–39 秒标题是 FP16 四步文生图，六步 v0.2.1 的 75.974 秒也为文生图；其真正的六步 832×1248 Eiffel 参考编辑报告约 **102.3 秒**，仍不是当前 REDV2 + v0.3。README 另一张表的 1024² 四步 W4A4 编辑约 24.8 秒、512² 单参考约 8.7 秒实际是 **Linux RTX 2060 / CUDA**；不能读成 Mac 数字。[编辑性能条件](https://github.com/netdur/qwen-image-cplus/blob/027bff8c68ddce06cb7fb318c8c79748b68b1f35/docs/performance.md#L300)和 [CUDA benchmark 条件](https://github.com/netdur/qwen-image-cplus/blob/027bff8c68ddce06cb7fb318c8c79748b68b1f35/nums.md) 分别记录模型与组件精度。可以参考 native kernel / 打包契约，REDV2 导入、6 步 v0.3 与当前 8 位编码契约仍需独立验证。

## 后续实验验收表

固定一组单参考局部编辑与一组双参考身份/外观编辑，保持约 1 MP 输出。每个候选至少覆盖冷启动、连续热请求和一次 image→video→image；只修改一个变量。比较完整 end-to-end、采样、encoder/VAE/load/decode 与排队；同时记录内容/身份/构图差异和内存。

先验证 VAE oracle，再验证同一 INT8 文件 MPS encoder；之后分别比较 resident 策略、真实 Metal attention、6 步配方与 MLX Q8。MFLUX 的调度参数必须接到实际 edit Config，并保存真正使用的 sigma 数组；纯“参数接受/生成成功”不能作为通过。迁移仍应落在 Gen workflow-native backend 与原有共享加速器租约内，不恢复退役的 external / mlx / pipeline runner。

## 本地与 Comfy 证据边界

本轮公开 metadata / 小体积源码保存在忽略目录 `.scratch/qwen21-mac-runtime-research-20261001/`。本地编码器头部和运行版本只读获取。报告中的秒数来自前轮真实生成；本轮未给任何候选新增测速或完成生产交付、扣费验收。单例、microbenchmark 和社区报告分别标注，不相互替代。


## 原生后端的固定版本

本节核对 MFLUX/MLX、Draw Things 及一个 MLX 社区 renderer 的实际兼容性。只读取官方文档、发布记录、小体积源码与本地模型头部证据；未安装软件、下载模型、启停服务或运行新的生成请求。既有 ComfyUI 受控实测见 [作者与加速实测记录](QWEN21_MAC_IMAGE_EDIT_ACCELERATION_2026-10-01.md)。原生运行方案的收益均未在本项目完成对照实测。

| 来源 | 固定版本 | 状态 |
| --- | --- | --- |
| MFLUX | `83f4d1dee103674da5f2385251e7794cd7285ba5`，2026-10-01 | 编辑能力来自 main；当前稳定版 0.20.0 只发布旧的 Qwen 2.1 T2I/strength img2img 入口 |
| Draw Things 源码 | `b35f56f95fc009c25cc27c3778b1f8107b956400`，2026-09-30 | 已有 2.1 参考编辑、KV 缓存、量化与 LoRA 实现 |
| Draw Things 发布 | `v26.0928.0`，commit `18b851b0bc75187d2276a131a2cd3fb9cb095e36` | 2026-09-28 已发布支持 2.1 的 macOS CLI/gRPC 二进制 |
| Draw Things 模型配置 | `17d85188676237777fc1f718dcaa350848906c4a` | 官方 2.1 的 q8p/q6p/i8x/i4x 及 Qwen3-VL i8x 元数据 |
| `tillknuesting/qwen-image-2.1-mlx-fast` | `aebe088d5c80df4d4d22a0c11f758d01d7f95899` | T2I renderer，明确拒绝参考图 latent |

版本事实来自 [MFLUX 0.20.0 发布](https://github.com/mflux-community/mflux/releases/tag/v.0.20.0)、[MFLUX 固定源码](https://github.com/mflux-community/mflux/tree/83f4d1dee103674da5f2385251e7794cd7285ba5)、[Draw Things 发布](https://github.com/drawthingsai/draw-things-community/releases/tag/v26.0928.0)、[Draw Things 模型元数据](https://github.com/drawthingsai/community-models/blob/17d85188676237777fc1f718dcaa350848906c4a/models/qwen-image-2.1/metadata.json)及 [MLX-fast 固定文件树](https://huggingface.co/tillknuesting/qwen-image-2.1-mlx-fast/tree/aebe088d5c80df4d4d22a0c11f758d01d7f95899)。稳定版 MFLUX 中 `variants/edit/qwen_image_21_edit.py` 的同路径请求返回 404，不能把 main 的编辑能力等同于已发布的 0.20.0。

## MFLUX：较容易保留 REDV2 的原生 MLX 对照方案

### 实际支持

最新 `QwenImage21Edit` 使用 Qwen 2.1 架构，包含 Qwen3-VL 的视觉塔、DeepStack、多模态位置与参考 VAE latent；最多十张参考图。单/双参考、RGBA、量化保存/加载都已有上游真实权重验证记录，不能与旧 Qwen-Image-Edit 2509/2511 混用。上游报告也保留了未完成指定编辑的样例，并没有宣称全部输入通过。[编辑实现 L31–133](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py#L31)、[验证记录 L38–82](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/reference/VALIDATION.md#L38)。

编辑入口的 q8 会量化满足条件的 diffusion transformer 和文/图 encoder 层，保护 modulation、time embedding 与 norm-out 等层；VAE 固定 FP32 且不量化。这与旧 T2I 入口把 encoder 保留 BF16 的行为不同。其量化是 MLX `nn.quantize` 的原生格式；当前 `qwen3vl_8b_int8_convrot.safetensors` 不能当作同格式文件直接复用。可以保持“8 bit 编码器”的选择，但应使用已验证的 MLX q8 转换，并检查图像条件 hidden states 与编辑质量。[组件定义 L10–26、L81–86](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/weights/qwen_image21_weight_definition.py#L10)、[MLX 量化调用 L174–205](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/common/weights/loading/weight_applier.py#L174)。

### REDV2 权重怎样接入

编辑 loader 需要完整 checkpoint 目录：三个组件的 `config.json`、对应 safetensors，以及 `processor/`。单个 ComfyUI diffusion safetensors 不是完整模型入口，T2I 导出也缺视觉塔。当前 REDV2 BF16 头部共有 297 个 tensor，采用官方 `transformer_blocks.*`、`img_in`、`txt_in`、`modulation.1`、`norm_out`、`proj_out` 布局，无 `diffusion_model.` 前缀；这与 MFLUX 的官方 transformer 布局相符。loader 已将 `modulation.1.*` 规范化为 `modulation.layers.1.*` 并检查完整 key/shape。因此，**把当前 REDV2 BF16 放入完整本地 checkpoint 的 transformer 组件是有源码依据的候选**，无须用官方底模替换 REDV2；仍须实际加载与生成验证。不要直接加载作者 scaled FP8 文件并忽略 scale。[编辑初始化 L29–55](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/qwen_image21_initializer.py#L29)、[规范化及严格检查 L129–180](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/qwen21_initializer.py#L129)。

这里的“相符”是本地头部和 loader 的静态比对，未证明权重加载成功、数值等价或性能收益。参考模型的 configs/tokenizer/processor 必须与 Qwen 2.1 固定 revision 配套。社区 INT8 ConvRot 的旋转与量化格式不能通过改文件名变成 MLX q8。

### LoRA 可以未合并，但 Viggle 调度器尚未接通编辑入口

LoRA loader 支持 PEFT `.default`、`transformer.`、`diffusion_model.` 和 fused gate-up 映射，`bake_lora=False`/`--no-bake-lora` 可保留运行时增量。对于蒸馏 LoRA，应优先保持未合并计算，避免 BF16 或再次量化吞掉小 delta；保存 adapted model 会烘焙，不能重新加载后重复挂同一个 LoRA。[LoRA 映射](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/weights/qwen21_lora_mapping.py)、[应用入口 L98–106](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/qwen21_initializer.py#L98)、[编辑 LoRA 说明](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/reference/README.md#L90)。

上游确有 `ViggleTurboScheduler`，采用六个 raw sigma `[1,.9375,.875,.75,.5,.25]`、分辨率 shift、关闭 terminal rescale；但当前编辑 CLI 只校验参数，**未把 `args.scheduler` 传入 `generate_image`**。该方法签名没有 scheduler，其 `Config(...)` 也未传 scheduler，最终使用 Config 默认 `linear`。直接运行 `--scheduler viggle_turbo --steps 6` 不能证明执行作者采样配方。这一结论已用 Python AST 核对，结果保存于 `.scratch/qwen21-mac-runtime-research/mflux-edit-scheduler-wiring.json`，没有运行 GPU。[调度器 L8–39](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/model/qwen21_scheduler.py#L8)、[CLI 参数与调用 L143–198](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/cli/qwen21_edit_generate.py#L143)、[Config 默认 L31](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/common/config/config.py#L31)。

进入对照实验前，需接通这条参数链、记录真实 shifted sigma、确认末端没有 `.02` stretch，并按 [Viggle v0.3 配方](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/README.md)使用 scale 1、CFG 1 和未合并 r128；不能以“六步正常出图”替代配方验证。

### Cache、融合内核与服务化边界

编辑有请求内 prefix K/V：首步计算文字/参考 prefix，后续重用；`use_step_cache` 则是另一种近似跳块方案，默认关闭。当前编辑的 prompt cache 仅在没有参考图时生效：有参考图仍逐次运行文/图 encoder 和 VAE。因此多次 CLI 执行与长驻模型对象的 warm 请求应分开测量；跨请求图像条件缓存若另行实现，需绑定图片内容、processor 几何、prompt、模型/encoder revision 与精度。[请求内缓存与采样 L122–197](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py#L122)、[prompt cache L351–359](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py#L351)。

MFLUX 已有融合 Q/K RMSNorm+RoPE 的 custom Metal kernel，但编辑实际调用 `forward_reference`，其 L77–82 仍执行独立的 projection、RMSNorm 与 rotate；融合内核仅出现在 `_project` 路径。不能把 T2I README 中的融合收益算作已作用于编辑。这是可研究的优化点，必须用真实编辑 tensor 做数值与完整输出校验。[注意力两个执行路径 L67–135](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/model/qwen21_transformer/qwen21_attention.py#L67)、[融合内核](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/model/qwen21_transformer/qwen21_fused_kernels.py)。

本次找到的是 Python 模型 API、CLI 和 callbacks，未找到 Qwen 2.1 专用的长驻 HTTP 服务入口。可以用一个串行、长驻的 `QwenImage21Edit` worker 做受控 prototype，但生产接入仍要遵守项目现有 workflow-native backend、租约、取消、超时、artifact 交付及恢复契约；不恢复已退役的外部 pipeline adapter。[Python API 与 CLI](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/reference/README.md#L150)。

## Draw Things：已发布原生实现，自定义 REDV2 接入仍有缺口

### 2.1 编辑与 Mac 内核确实存在

`v26.0928.0` 已明确发布 Qwen Image 2.1 模型支持。专用实现分为固定 prefix graph 与每步 target graph，32 层 K/V 只计算一次，并有 block-causal 参考图布局和 RGBA VAE；LoRA 有专用 importer/模型构建与 merged/separate 对照测试。[发布记录](https://github.com/drawthingsai/draw-things-community/releases/tag/v26.0928.0)、[2.1 固定 prefix 说明 L57–94](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/SwiftDiffusion/Tests/QwenImage2_1.md#L57)、[LoRA 实现与验证 L110–139](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/SwiftDiffusion/Tests/QwenImage2_1.md#L110)。

当前社区模型 metadata 提供官方 2.1 diffusion q8p/q6p/i8x/i4x，默认 encoder 为 `qwen_3_vl_8b_instruct_i8x.ckpt`。实际 2.1 text encoder loader 同时读取 `text_model` 和 `vision_model`，支持 i8x 等 native codec，视觉 tower 有 DeepStack 注入。不能把早期仅含 `text_model` 的 q8p 文件用作编辑 encoder，也不能直接复用 Comfy INT8 ConvRot 文件；应核对 native checkpoint 包含视觉部分及其哈希。[模型 metadata](https://github.com/drawthingsai/community-models/blob/17d85188676237777fc1f718dcaa350848906c4a/models/qwen-image-2.1/metadata.json)、[视觉加载 L2163–2231](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/SwiftDiffusion/Sources/TextEncoder.swift#L2163)、[语言与 DeepStack L2237–2348](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/SwiftDiffusion/Sources/TextEncoder.swift#L2237)。

Draw Things 的 Metal FlashAttention 2.5 明确使用 M5 GPU 内的 Neural Accelerators，覆盖矩阵乘、注意力等算子；这不是传统独立 ANE 的 Core ML 转换。2025 年旧发布文章的 BF16 禁用限制已在 11 月 18 日更新为支持 BF16 和 shader binary cache。首次 shader specialization 会带来额外开销，应分别报告 cold/warm。其 4.6×宣传来自两台基础款 iPad M5/M4 的 FLUX.1 schnell 4 步、1280²、5 bit，取第二次运行；不是 M5 Pro、Qwen 2.1 或 REDV2 图生图 benchmark。[开发者内核发布与脚注](https://releases.drawthings.ai/p/metal-flashattention-v25-w-neural)。

### REDV2 safetensors 不能据此认定可直接导入

公开 `ModelImporter.inspect` 的 Qwen 检测仍使用旧架构的 `transformer_blocks.59.txt_mlp`，没有 32 层 Qwen 2.1 的模型识别；`ModelConverter` 的 `.qwenImage2_1` 分支仍为 `fatalError()`。这两份文件在发布 tag 亦相同。于是“官方 2.1 native checkpoint 可跑”并不等于“当前 REDV2 safetensors 可直接通过公开转换工具导入”。需要补齐 Qwen 2.1 converter，或取得经过严格 mapper/key/shape/scale 校验的 REDV2 native checkpoint，再验 LoRA 与量化。没有实际操作 Draw Things App 的私有 UI，不能据公开源码排除其内部另有 importer，但也不能把未知 UI 能力当作本项目可用路径。[识别条件 L190–192](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/ModelOp/Sources/ModelImporter.swift#L190)、[转换入口 L46–52、L160–161](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Apps/ModelConverter/Converter.swift#L46)。

Viggle v0.3 r128 的 LoRA key 属于可映射的 2.1 attention/MLP 家族，但本次没有找到已验证的“REDV2 + v0.3 + 六个作者 sigma” Draw Things 配方。默认是 40 步 DDIM Trailing、CFG 1、resolution-dependent shift；模型 noise discretization 的 terminal 为 `.02`。只改 steps=6、选择一个 Euler 名称仍不等价于 Viggle。未合并执行、真实 sigma 以及关闭 terminal stretch 都应成为接入验收项。[CLI 默认 L1074–1079](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Apps/DrawThingsCLI/DrawThingsCLI.swift#L1074)、[默认 sigma terminal L2871–2872](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/ModelZoo/Sources/ModelZoo.swift#L2871)。

### VAE、双图自动化与 API

VAE 实现并非简单地把所有运算切成 FP16：上游发现最终上采样会超过 FP16 范围，已将最终 upsample/residual 部分置于 FP32，并保留全 FP32 重试。其 parity 和有限值测试不能替代 REDV2 cold/warm 人脸保真验证。[VAE 精度记录 L69–75](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/SwiftDiffusion/Tests/QwenImage2_1.md#L69)。

CLI 支持重复 `--image`：第一张作为主要参考，其余经 `.shuffle` hints 传递，顺序保留；gRPC 的 GenerateImage 接口支持流式结果、生成阶段和 repeated hints/content，macOS 二进制可以长驻。双参考质量证据仍有限：上游两参考测试多为一/两步执行 smoke，不能当产品双人身份质量证明。[CLI 参考传递 L4385–4405](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Apps/DrawThingsCLI/DrawThingsCLI.swift#L4385)、[gRPC 契约 L59–85、L135–145](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/GRPC/Models/Sources/imageService/imageService.proto#L59)、[服务器运行说明](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/README.md#L78)。

HTTP `/sdapi/v1/img2img` 的当前公开实现只有 `init_images.count == 1` 才把图片赋给 Invocation；多张图片会进入 `.prefersDefault`，未通过这条 API 转成双参考。生产双图若用此实现，应走已确认的 CLI/gRPC hints 契约，不把普通 SD WebUI HTTP 参数数组当作支持证明。[HTTP 处理 L59–79](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/HTTPAPIServer/Sources/HTTPAPIServer.swift#L59)。

## `qwen-image-2.1-mlx-fast`：能参考其方法，不能直接用于本次图生图

作者实测的是基础 M4 16 GB、1024²、25 步、407-token prompt、MLX 0.32.2；默认 renderer 536 秒、近似首块 cache 341 秒、Viggle 六步 139–145 秒。与 ComfyUI 的对比使用不同 prompt，renderer 耗时排除了 ComfyUI 文本编码。模型是官方 MLX 4 bit，不是 REDV2；数字不能用于推导本系统的 16 秒或加速倍数。[作者固定 model card](https://huggingface.co/tillknuesting/qwen-image-2.1-mlx-fast/blob/aebe088d5c80df4d4d22a0c11f758d01d7f95899/README.md)。

源码从 ComfyUI 导出的纯文本 condition 进入 MLX；`load_prompt_embeddings` 明确报错拒绝 `reference_latents`。因此它不是当前单/双参考编辑的可替换 runtime。可借鉴 warm 模型、条件缓存、减少 host 同步、RoPE 融合与未合并 LoRA，但当前系统已具备 prefix K/V，不能再次把该项算作新增收益。[拒绝编辑条件 L146–158](https://huggingface.co/tillknuesting/qwen-image-2.1-mlx-fast/blob/aebe088d5c80df4d4d22a0c11f758d01d7f95899/src/qwen_mlx_poc/conditioning_io.py#L146)、[只导出纯文本图 L43–57](https://huggingface.co/tillknuesting/qwen-image-2.1-mlx-fast/blob/aebe088d5c80df4d4d22a0c11f758d01d7f95899/src/qwen_mlx_poc/comfy_workflow.py#L43)。

## M4 与 M5 的边界，以及公平对照条件

MLX 0.30.0 起支持 M5 GPU Neural Accelerators，需要 macOS ≥26.2；0.31.1 增加 M5 Pro/Max 调优。苹果说明它通过 Metal 4 TensorOps/MPP 实现。该硬件路径不适用于当前 M4 Max；原生 MLX 在 M4 仍可能受益于量化与融合，但收益必须测。苹果公开的 Qwen3 LLM TTFT/生成 token/s 和 FLUX 图像数字都不能代替 Qwen3-VL 图像条件 hidden-state 编码或 REDV2 编辑耗时。[MLX 0.30.0](https://github.com/ml-explore/mlx/releases/tag/v0.30.0)、[MLX 0.31.1](https://github.com/ml-explore/mlx/releases/tag/v0.31.1)、[苹果运行说明](https://machinelearning.apple.com/research/exploring-llms-mlx-m5)。

MFLUX T2I 的 M5 Max “约 1.5 秒/步、40 步完整约 78 秒”是官方底模、1024² 文生图，并且 T2I/编辑 encoder 与注意力路径不同；其编辑 validation 的时间又明确含共享机器并发负载。两者都不构成当前 REDV2 单参考的可靠延迟估计。[T2I 原始条件](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/README.md#L28)、[编辑验证计时边界](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/reference/VALIDATION.md#L38)。

对照时至少固定 REDV2 权重哈希、参考图内容与顺序、实际参考尺寸、输出 832×1216、prompt、真实 sigma、CFG、LoRA scale/未合并状态、encoder 8 bit 格式、VAE 精度和设备/OS/runtime 版本；分别计模型加载、文/图编码、参考 VAE、首步 prefix、每步 target、解码、API 全程。报告 cold、warm 且固定缓存状态，禁止并发 GPU 测试。MLX/PyTorch RNG 不同，相同 seed 不保证相同噪声；数值 parity 需同一 tensor 输入，产品质量则比较编辑成功、人脸、构图与双参考绑定。

一个容易漏掉的差异：MFLUX `output_resolution=1024` 是参考像素面积预算，显式 `width/height` 只约束输出；832×1216 参考会按它的公式重采样到 **832×1248**。即使最终输出仍是 832×1216，prefix token 数已改变。测试应记录实际几何，并在同参考尺寸下比较；512 参考预算只能作为另一个降低条件成本的质量试验。[尺寸算法 L19–21](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/latent_creator/qwen_image21_latent_creator.py#L19)、[编辑参考重采样 L108–121](https://github.com/mflux-community/mflux/blob/83f4d1dee103674da5f2385251e7794cd7285ba5/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py#L108)。

## 本节建议的实验顺序

1. 先做 MFLUX main 固定版本的本地 checkpoint 原型：保留 REDV2 BF16，使用完整 Qwen 2.1 processor/VAE 与 MLX q8 encoder，关闭近似 step cache，长驻串行模型。先验证 10 步编辑与双参考契约，再测完整 cold/warm。
2. 接通编辑 scheduler 参数并验证六个实际 sigma，再测试同一个 Viggle v0.3 r128 未合并 LoRA；质量矩阵通过后才讨论发布。不要为测速先叠加近似 cache、低参考分辨率和更低量化。
3. Draw Things 作为第二个原生对照：先解决自定义 REDV2 转换与作者 sigma 配方。公开发布支持官方 2.1 的事实，不足以越过这些接入缺口。
4. 在 M5 Pro 上重跑同条件矩阵，验证当前 runtime 版本确实启用 Neural Accelerator。到那一步才能判断用户 16 秒差异来自硬件、参考分辨率、热缓存、采样配方，还是实现开销。

所有本次下载的文档、API 元数据、小体积源码与静态校验保存在 `.scratch/qwen21-mac-runtime-research/`；模型文件及活动配方均未修改。
