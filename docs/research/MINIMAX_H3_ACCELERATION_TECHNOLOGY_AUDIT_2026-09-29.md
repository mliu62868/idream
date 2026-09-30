# MiniMax H3：加速技术与当前 M4 NSFW 路径审计

本轮于 2026-09-29 发起，访问与本机快照延续至 2026-09-30；用户时区为 America/New_York。来源日期使用 UTC，结论绑定具体 revision。本轮核对第一手来源、实际运行配置及已安装源码，没有下载新大权重、安装新插件、启停服务或重新运行生成。

## 结论

**h3.c 之外确实有多种 H3 加速，但本机已在用最主要的少步数与低内存措施；目前没有证据证明某个最新方案在 M4 Max 上同时胜过现有 NSFW I2V 的速度和质量。** 当前模型已融合 LightX2V 544p 8-step v1.0，不是普通高步数基础模型。新版四步 LoRA、TaoMate、FastH3 V2、HyperFlow 和 LynnReal 改变的是训练轨迹或模型结构，不能把它们直接叠到现有融合模型上，当作独立引擎升级。[当前融合与实验记录](MINIMAX_H3_TURBO_LORA_CLAIM_VERIFICATION_2026-09-29.md) · [LightX2V 规格][turbo-spec]

“最新”确有差距：LightX2V 有 v1.2 四步 768p；FastH3 有 9/15 的八步 V2；HyperFlow 9/19 发布；Spectrum 已是 v0.2.28；[ComfyUI 9/29 发布 v0.38.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.38.0)。**这些版本号不能证明升级会让当前 M4 NSFW 任务更快。** Spectrum 最新变更是 Windows CRLF 审计修复；新 MLX NAX 路径限定 M5；CUDA/VSA/NVFP4 的数据中心成绩不适用于 M4。[HF 文件版本][turbo-hf] · [FastH3 V2][fasth3-v2] · [HyperFlow][hyperflow] · [Spectrum 发布说明][spectrum-release] · [NAX 门槛][app-mlx]

优先保持现有 NSFW 权重，评估它的 8/6/4 次调用质量边界、单独的扩散缓存及编码/解码成本。更新 Turbo 应以匹配任务且未融合旧 Turbo 的 NSFW 基础模型作对照；不要求重新下载官方完整 BF16 树。现有短片的四步重影结果说明，还不能把四步设为默认。[本轮短片及边界](MINIMAX_H3_TURBO_LORA_CLAIM_VERIFICATION_2026-09-29.md#完整短片实测与质量)

## 从第一性原理拆分

成本模型是 `加载 + 文本/参考编码 + Σ 每次 DiT 计算 + 视频/音频 VAE + 封装`；它不是本机 latency 预测。

| 方法 | 改变的成本 | 必须付出的代价或满足的条件 |
| --- | --- | --- |
| 少步蒸馏 | 减少完整 DiT 调用数 NFE | 需要匹配的学生模型/adapter、sigma、任务；少步不是相同质量保证 |
| feature cache / forecast | 部分调用复用历史 residual 或预测隐藏状态 | 引入近似；已有四/八步时可复用机会更少 |
| sparse attention / token reduction / 跳层 | 减少单次调用里的 token、注意力或层计算 | 改变模型计算；训练配套、角色一致性、动作与同步需要验证 |
| kernel fusion / Flash / 编译 | 减少 kernel launch、数据搬运或改善算子吞吐 | 依赖硬件、shape、dtype、mask 与实际选路；冷编译也有成本 |
| INT8/FP8/4-bit | 主要减少权重存储、驻留与带宽 | 只有命中该硬件的量化 GEMM 才可能减少算力成本；反量化开销与 attention 仍在 |
| paging / offload / pruning | 减少驻留或重复计算/传输 | 能放得下不等于更快；小文件不等于小运行内存 |
| 少 token 编码、轻 VAE、复用 conditioning | 减少采样外固定开销 | 必须保持 conditioning 和 latent/归一化契约；解码器也会影响质量 |

Euler 无 CFG 时通常每步一次 H3 调用；多阶段 sampler 的 UI steps 不等于 NFE。Spectrum 明确区分 SEEDS-2 的 `2N−1`、SEEDS-3 的 `3N−2` 与普通 Euler 的 `N`，不能只看 steps 比速度。[调用数说明][spectrum-readme]

## 本机核对：实际启用的路径

本轮直接读取 8190 `/system_stats`、PM2 状态、启动 wrapper、工作流及已安装源码。运行快照完成于 2026-09-30 00:11 EDT，仓库 HEAD 为 `21303399a021cc3e06c26baad0a9d000ecc4774c`；本报告文件名沿用 9/29 的任务起始日期。

- 硬件：Apple M4 Max，128 GiB 统一内存，macOS 26.5.1。
- H3 服务：ComfyUI **0.34.2**，源码 `c645560264062e6a5b0688d25eaf3ee9906a7709`，PyTorch 2.13.0，comfy-kitchen 0.2.31。当前最新发布版为 [v0.38.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.38.0)；“版本更晚”不能替代相同工作流的性能与质量对照。
- 当前 [工作流](../../packages/gen/workflows/minimax-h3-redcraft-i2v.json) 是 v4：RedCraft NSFW INT8 ConvRot **19.53 GiB**，已融合 544p 8-step Turbo v1.0；Qwen3-VL Q4_K_M 文本编码器；单首帧 I2V，512×512、124 帧、24 fps，Euler/simple **8 步**，BasicGuider，无双分支 CFG，video/audio shift 12/3，官方 FP16 视频 VAE。既有 checkpoint provenance 见 [先前证据](evidence/h3-lora-2026-09-29/checkpoint-provenance.json)。
- `--use-pytorch-cross-attention` 正在启用；启动日志确认 PyTorch attention。comfy-kitchen 的可用后端只有 **eager**，CUDA/HIP/Triton 均不可用，没有 Metal INT8 后端。
- `--cache-ram 10 128` 是 ComfyUI 图节点结果的 RAM 缓存，**不是** Spectrum/FBC 的跨扩散步骤特征缓存。自定义节点目录没有 Spectrum、FirstBlockCache 或 LynnReal；工作流也未接入相应 patch。
- SolAttn-MPS 节点虽然已安装，工作流没有调用它，也没有全局 Sol 环境覆盖；不能将安装目录算作生效。
- [启动 wrapper](../../scripts/start-comfyui-idream.cjs) 给 H3 的 `ASFP8_ENABLE_ONLY` 仅为 `tensor_to_fp8,int_mm_mps`。日志确认 fused_norm、rope_fast、flash_attn、原生 INT8 与 MLX 等均跳过。LTX runner 启用的 norm/RoPE patch 不能算成 H3 已启用。

### 为什么当前 INT8 不等于 M5 INT8 算子加速

已安装 `comfy/quant_ops.py` 的 `int8_tensorwise` 设置 `quantize_input=False`。`comfy/ops.py` 按它选取 weight-only 路径，将量化权重转成输入的浮点 dtype 后进入 `F.linear`；ConvRot 权重经 comfy-kitchen eager 解量化与反旋转。因而当前路径可概括为 **INT8 存储 → 浮点解码 → 浮点 GEMM**，不是原生 W8A8 整数 GEMM。量化确定减少文件与驻留体积，速度需实测，不能按存储位数直接推倍率。证据见 [执行路径片段](evidence/h3-acceleration-audit-2026-09-29/installed-mps-execution-seams.json) 与 [实际启动日志](evidence/h3-acceleration-audit-2026-09-29/runtime-backends.log)。

AppleSilicon-FP8 本机 revision `911294ca...` 落后于 v1.3.4 的 `9c789359...` 共 32 个 commit。新增的 chip gate/self-check 修复旧版在 M4 上报告 `tensor_ops(M5/Metal4)=yes` 的错误；这个日志不证明 M4 有 M5 Neural Accelerators。[上游 README](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/9c78935963e885ba93313807974dc64d71058c7f/README.md) 明确原生 INT8/FP8 matmul 要 M5，而 M1–M4 走 weight-only 路径。新 `ASFP8_INT8_DEQUANT` 的约 19× 是 MiniMax Music 3 自回归解码测量，作者明确不宣称 batched diffusion 有收益，不能列为 H3 视频已证实加速。

本轮没有重新跑生成或 profiler，因此以上为实际配置、启动状态及可达源码路径的核验；没有给各算子补造耗时占比。完整快照见 [current-runtime.json](evidence/h3-acceleration-audit-2026-09-29/current-runtime.json)，上游版本 pin 见 [upstream-versions.json](evidence/h3-acceleration-audit-2026-09-29/upstream-versions.json)。

## 少步数与专用学生模型

| 技术与本轮固定版本 | 第一手资料支持的事实 | 对当前 NSFW I2V 的判断 |
| --- | --- | --- |
| LightX2V Turbo；HF `3ec17a3`，9/10 | 最新 FL2VA 四步 v1.2 768p，video/audio6/3；实际文件 alpha8/rank128。现融合 544p 八步 v1.0 为12/3。FL2VA 与 Ref2VA adapter 分开。[版本目录][turbo-hf] · [规格][turbo-spec] | 可做替换蒸馏对照；当前模型上重复叠加不能作为干净升级 |
| PDD；Alibaba HF `335001f`，8/27 | FL2VA/Ref2VA 八步，rank/alpha64，并包含 interval 输出 head bank。专用 loader 与 sigmas 才能保留蒸馏；普通 LoRA loader 不足。[作者卡][pdd-hf] · [Comfy 实现][pdd-comfy] | 技术可支持 ConvRot，但必须移除旧 distill，保留 NSFW 的组合质量未验证 |
| FastH3 四步 Preview；HF `f509e62`，9/4 | 有 dense 与 VSA adapters；VSA 含额外 gates/delta，需要专用 VSA-H3；作者发布范围是 T2VA。[作者卡][fasth3-lora] | 不能当作当前 I2V 的通用四步 LoRA；有专门 Apple 移植，见下文 |
| FastH3 八步 V2；HF `3da2ddf`，9/15 | DMD2＋80% VSA，video shift10，八次 forward；四 B200 为默认测试平台。作者明确 FL2VA/Ref2VA 未蒸馏。[作者卡][fasth3-v2] | 比旧 Preview 新，但仍是 T2VA 专用模型；本机本来已8NFE，不因名称更新就减少调用 |
| FastH3 V2 Comfy / NVFP4；9/16 / 9/23 | 官方有 pruned BF16/INT8 ConvRot repack；NVFP4 derivative 保留 VSA、shift10 与四B200/UniServe执行合同。[Comfy 文件][fasth3-comfy] · [NVFP4 卡][fasth3-nvfp4] | repack 不改变任务训练；NVFP4 无本机 M4 实测支持 |
| HyperFlow；HF `5bde94d`，9/19 | 八步 data-free self-distillation；rank/alpha256、316 modules，新增 endpoint time embedder。必须专用 `load_hyperflow_lora`，固定12/3 grid；支持 T2VA/FL2VA/Ref2VA。[作者卡][hyperflow] | 不是普通 adapter；需新增两时间 conditioning。对已8步、AdaLN-pruned、NSFW融合模型无直接收益证明 |
| TaoMate-H3；作者 HF `7d7a51f`，9/17 | 三步分块 streaming，当前作者只发布 T2AV；FL2AV/Ref2AV 待发。验证配置为 Linux/CUDA、8×H20 96GB。[作者卡][taomate] | 社区转换能 attach 不等于其 I2V/Ref2V 质量受作者验证；不能拿3步直接替代当前产品 I2V |
| RAVEN；GitHub `927255c`，9/29 | 四NFE causal streaming preview；作者注明 undertrained、细节有限，构建目标是 Linux/Hopper。[作者 README][raven] | 改变 bidirectional H3 的生成契约，无 M4/当前 NSFW I2V 合格证明 |

LightX2V 的 `strength × alpha/rank` 必须按精确版本处理：v1.2 的 alpha8 不能继承旧 v1.0/v1.1 四步768p示例的 alpha128；官方例子的 strength1 也不能被通用0.65–0.8范围替代。具体文件头、真实 adapter oracle 和模型融合证据见[前一报告](MINIMAX_H3_TURBO_LORA_CLAIM_VERIFICATION_2026-09-29.md#lightx2v必须绑定具体版本任务和-alpha)。

PDD 的32个 interval head copies不是把 H3 attention 改成32 heads。其 Comfy 作者要求 Euler、专用 grid、12/3、单分支，且明确移除 LightX2V 等其他 distill；原位缓存也不能直接叠。社区 character LoRA 的加载支持不构成某个 NSFW组合已完成质量验证。[专用加载合同][pdd-comfy]

TaoMate 社区转换卡称FL2VA底模可用于T2V/I2V，推荐 strength1；第三方整合配置又使用0.7并复用Ref2VA。**这里的证据应以原作者仅发布T2AV为边界**，不能把第三方选项当作官方训练范围。[原作者发布范围][taomate] · [转换作者说明][taomate-comfy]

HyperFlow 作者约175→60秒来自4×H200、1344×768、124帧、49→8NFE，计编码/采样/双VAE但不含进程启动与权重加载。它说明少步技术成立，不说明替换本机已8NFE模型还能得到3倍。[作者性能边界][hyperflow]

FastH3 V2 NVFP4 的五组同种子配对检查来自校准源数据，报告明显轨迹漂移；作者明确不承诺感知等质，也不是独立holdout质量验收。最新低bit checkpoint因此不能自动视作更好的成片模型。[实际验证口径][fasth3-nvfp4]

## LightX2V 引擎：按 H3 可达源码判断

固定 HEAD `8a97c7591d7252ef491392e83e1eb18617ac9368`，2026-09-29。H3实际支持模型/块offload、离线AdaLN缓存、SP/TP、量化DiT、compile/warmup、DMD LoRA，以及以下受条件限制的 feature caching；这些并不是所有设备共享同一组快路径。[H3运行指南][lightx-guide]

- **MPS 路径确实存在。** 当前JSON使用 `torch_sdpa_mps`、query chunk512、DiT/encoder disk streaming；源码在默认stream上预取到两个共享MPS buffers。主要解决驻留/流式权重问题，未提供本机同输入NSFW I2V对照。[MPS配置][lightx-mps] · [MPS offload实现][lightx-mps-offload]
- `minimax_h3_t2av_4step_512_22.json`只有4NFE/512²/22帧，**没有LoRA字段**；仅有四步配置不证明已运行蒸馏Turbo。且 `dit_disk_streaming` 入口禁止LoRA，streaming也禁止feature caching。[四步MPS配置][lightx-mps-four] · [实际选择与校验][lightx-model]
- **当前 H3 selector 只接受 NoCaching 或 DPCache。** 仓库虽有MagCaching类，选择入口仍拒绝该名字；不能据“文件存在”宣称可用。TeaCache/TaylorSeer/AdaCache的通用Wan示例也不能当H3支持/性能证据。[H3 selector][lightx-model]
- 现成DPCache preset是Ref2AV、29NFE、8卡SP、SM120 Sol/Triton、FP8 VAE，使用预算14与预校准cost文件。这不是可直接加载到M4的Comfy cache插件，也没有当前8步质量/命中证明。[精确配置][lightx-dpcache]
- AdaLN缓存是按模型、步数和video/audio shift严格匹配的timestep调制缓存，与预测DiT residual不同。开启CPU offload时强制要求，缓存不匹配会失败。[缓存约束][lightx-guide]
- Sage2/SGL、FP8/INT8/ConvRot、SP/TP、Triton/compile有对应H3配置；NVIDIA多卡/Ulysses不能外推到单台AppleGPU。量化动态LoRA目前只接受一个adapter，BF16可加载时合并；不是任意8-stack接口。[H3任务/LoRA说明][lightx-guide] · [compile配置][lightx-compile]

结论：LightX2V是独立完整引擎，也有MPS实现，但当前Diffusers组件、cache/offload与adapter合同不同于本机Comfy单文件/GGUF组合。不能因为同属LightX2V就把Turbo模型、CUDA引擎和Mac原生kernel的倍速相乘。

## ComfyUI：attention、缓存与编译

H3会调用通用 `optimized_attention`；核心提供PyTorch、Sage/Flash等路由。Sage官方依赖CUDA/Triton并针对Ampere/Ada/Hopper/Blackwell，Comfy的Sage3入口也明确检查CUDA。**在Mac启用PyTorch SDPA不等于运行NVIDIA FlashAttention或SageAttention。** MPS专用flash库是另外的实现。[H3 attention调用][comfy-h3] · [核心路由][comfy-attention] · [Sage硬件要求][sage-readme]

| 候选 | 最新核验及性能口径 | 对当前 M4 的优先级 |
| --- | --- | --- |
| Spectrum v0.2.28 `5161f04`，9/18 | 预测H3末端隐藏状态；普通20步常见11 actual＋9 forecast。最新release修Windows CRLF源码审计，采样/调度未改变。[README][spectrum-readme] · [release][spectrum-release] | 可保持当前checkpoint；8步命中未知。作者提醒与Turbo组合会增加构图、动作、细节漂移，必须单独对照 |
| FirstBlockCache `f7a2712`，9/12，未变 | 每步运行首block，变化小时复用后续residual；experimental deep reuse保留更多端点层。5090/20步同attention对照少约30–33%时间，预设按20步调校。[作者基准][fbc-readme] | 无自定义CUDA/Triton，源码层面可作为MPS候选；未证明8步收益，先Safe/标准Fast，记录actual/hit |
| mps-flash-attention0.6.3 `41c7e20`，9/1 | 当前HEAD与9/12测试时一致；作者算子均值不能代表H3整片。[上游][mps-flash] | 本机代表shape已测未获收益，不原样重复 |
| mtlflashattn `031ec46`，7/9 | M1+旧simdgroup与M5 TensorOps路径不同，M5成绩不能外推M4。[上游][mtl-flash] | 同上；若版本/shape/执行路由无变化，不重复失败筛选 |
| AppleSilicon-FP8 v1.3.4 `9c78935`，9/23 | 本机版本落后；更新修正硬件 gate、自检与量化兼容。[上游固定版本][as-fp8] | M5 INT8 和 Music3 自回归速度不等于 H3 M4 收益，详见本机执行路径核对 |
| torch.compile / fused ops | LightX2V有Sage/SGL的compile preset，WeeTodd有小范围AdaLN compile实验；不是通用Mac全图加速开关。[LightX2V配置][lightx-compile] · [WeeTodd说明][wee-readme] | 量化、GGUF、可变packed shapes与offload需检验实际编译覆盖；本轮没有H3 M4同规格加速证据 |

两套Metal flash的具体本机数值筛选和速度结果见[9/12算子报告](REDCRAFT_H3_METAL_ATTENTION_OPERATOR_BENCHMARK_2026-09-12.md)。Spectrum、FBC、EasyCache/CacheDiT应作为单独候选；多个double-block/feature替换不能默认可组合。Comfy图缓存与这些扩散近似不能混为一谈。[FBC组合约束][fbc-readme]

## 新候选：LynnReal Flash 与轻量视频 VAE

[LynnReal 官方 ComfyUI 文档](https://github.com/LynnReal-AI/LynnReal-Omni/blob/ad16ac787430bd22456ee55f018764cf53c25935/comfyui/README.md) 当前提供 Standard 四步及 Flash 三步的 T2V、首帧 TI2V、Ref2V 工作流。Flash Lite INT8 主模型文件 **16.7 GiB**，Standard Lite INT8 **20.4 GiB**。Lite 把已训练采样时刻的 adaLN 调制向量预存成精确 step table；作者同模型 H100 对照验证这些固定 schedule 的采样状态相同，但明确 Lite 主要减体积，**没有在原 Flash 上再提速**。它是更换主 checkpoint 的候选，不能据此声称已有 RedCraft NSFW 能力会保留，也没有当前 M4 的等质量速度证据。

作者较早的 H100 80 GB、1344×768、5 秒首帧 TI2V 实测为 Generate 8.9 秒、click-to-video 13.0 秒。它包含三步、W8A8、GPU attention/kernel 与轻 VAE 的组合，且作者要求记录 backend/工作流版本；这个数不能移植成 M4 倍率，也不能将 Flash Lite 的“Lite”解释为另一倍加速。

**更接近本项目的是单独替换轻 VAE、保留现有 NSFW DiT。** [作者 Light VAE 卡](https://huggingface.co/stdstu123/LynnReal-Onmi-light-vae) 明确 encoder 不变，decoder 从官方 36 个 block 蒸馏为 **26** 个，24 latent channels、归一化和空间/时间压缩接口保持一致；但同一 latent 的 RGB 重建会改变。官方 ComfyUI bundle FP16 轻 VAE 文件约 **3.6 GiB**。这减少的是 VAE 解码工作，不能按 36→26 直接宣称全流程快 28%。

ComfyUI 在 9/29 合入 [PR #16657](https://github.com/Comfy-Org/ComfyUI/pull/16657)，按 checkpoint 的 decoder block 数构造 VAE，并指向 [Kijai 的 INT8 ConvRot 轻 VAE](https://huggingface.co/Kijai/MiniMax-H3-experimental/blob/main/minimax_h3_lynnreal_light_vae_int8_convrot.safetensors)。**已检查 v0.38.0 的原始 `comfy/sd.py`，该 tag 没有层数检测，仍固定构造官方 VAE**：不能只升级到 v0.38.0 就假定有该支持。需含此 commit 的版本或作者专用 loader。旧 stock loader 可出现 missing keys 后继续执行，不能把“产出文件”算作正确加载。

本轮只核对 metadata、源码及作者验证记录，没有下载新主模型/VAE、安装节点或生成视频。作者未给当前 RedCraft + M4 的配对数据；验证应固定同一 latent，比较脸部、纹理、动作连续性、色彩、tile 接缝、解码耗时及峰值内存。源码差异、模型配置与 tag 反证见 [light-vae-support.json](evidence/h3-acceleration-audit-2026-09-29/light-vae-support.json)。

## MLX、稀疏/混合注意力与其他引擎

| 技术 | 第一手证据与限制 |
| --- | --- |
| appautomaton/mlx-h3 `adee6a3`，9/13 | 独立MLX，支持显式FL/Ref条件与communityTurbo。新NAX W8A8替换200个主DiT linears，要求M5、macOS26.4+、Xcode26/Metal Toolchain；默认仍W8A16。此更新不能加速M4。[当前README][app-mlx] |
| PipeNetwork/minimax-h3-mlx `b2f7e4d`，8/10，未变 | 量化主要减内存，attention仍主导；作者估算4-bit端到端约1.2–1.4倍而非4倍。没有当前M4NSFW I2V优势证据。[作者分析][pipe-mlx] |
| WeeTodd-Nodes `7038ce6`，UTC9/30／纽约9/29 | 有独立MLX H3、paging、dense GEMM、fused/MPP、VSA稀疏、token pairing/跳层、EasyCache/BlockCache/forecast。已发布FastH3 production profile要求专用四步VSA学生，**T2VA only，拒LoRA/cache/forecast/VDN/token pairing**；40层候选会改运动/音频，M3Ultra成绩不是M4NSFW资格。[作者合同][wee-readme] |
| OpenVDN `64b91c4`，9/24；HF `50744d8`，9/19 | 新增frame-wise线性分支＋softmax分支＋配套default/Turbo adapters。作者8×B200/14.4秒视频约9秒整链、6.9秒采样。支持I2VA/FL2VA和经FL2VA的Ref2VA-like，后者不等于原Ref2VA分区。[作者仓库][vdn-readme] |
| WeeTodd VDN-Metal | Apple移植的M3Ultra/672×384/124f八步resident warm231.11秒是优化自身VDN端口；README明确未证明胜过普通H3。需要额外linear branch/adapters，pruned底模还需原始silu timestep grid。[Apple移植说明][wee-readme] |
| Sol-Engine / Sol-H3 `670482d`，9/29 | NVIDIA完整stack结合kernel、缓存、Sol/BSA、并行VAE。Sol-H3的8×B300/124f1.653秒计编码/采样/双VAE，不含加载/预热/MP4；四forward学生对49forwardbase，不能称纯engine倍速。I2V部署smoke也不等于上游FastH3已做I2V训练。[Sol-H3测量合同][sol-h3] |
| stable-diffusion.cpp `3f8527a`，9/27 | 可直接读ComfyINT8ConvRot并runtimeLoRA。当前ConvRot原生快路径列CPU/CUDA/HIP/Vulkan，其他GPUbackend回CPU；9/27新增HIP，不是MetalConvRotkernel。[当前backend合同][sd-convrot] |
| MacOS-H3-Speedrun `9326b3e`，8/21，未变 | Mac端封装与配置；24–64GB MLX路线要求转换checkpoint/adapter，不能直接接通用ComfyLoadLoRA；内存档位测量主要来自512GB M3Ultra，并非各档物理Mac实测。[作者限制][speedrun] |
| MiniMax-H3-Swift `d9bc402`，8/29 | 独立MLX/Swift runtime，结合quant/kernel/cache；公开速度为M3Ultra与其配置/权重，非本机RedCraft I2V对照。[作者README][swift-h3] |
| DiffSynth-Studio `d393669`，9/29 | H3 NF4与disk/CPU/VRAM管理可降低GPU内存门槛；官方示例为CUDA。低VRAM门槛不证明更低latency，也不是本机ConvRot/GGUF直接复用路线。[官方H3文档][diffsynth-h3] |
| ANE | maderix是h3.c fork，不计为另一个独立引擎；权重/形状编译、daemon驻留与并行布局另有成本。上一轮只测默认Metal，没有M4Max ANE A/B。[已有明确边界](MINIMAX_H3_TURBO_LORA_CLAIM_VERIFICATION_2026-09-29.md) |

上述token reduction、稀疏和层数削减是改变单次DiT计算的近似；不能因为“蒸馏LoRA能装上”就要求现有NSFW底模无损适配。VDN混合注意力和FastH3 VSA尤其需要训练匹配的额外分支/gates或学生权重。NSFW组合的质量缺口不能用无NSFW的作者演示替代。

## 对当前目标的实验排序

1. **先分阶段计时。** 在当前source、权重hash、参考图、124帧、512²下获取warm基线，分别记编码、实际DiT调用、双VAE、封装、峰值与swap。研究的新方法不能和历史不同任务耗时直接算倍速。
2. **保持现有NSFW权重测6步/4步。** 8→6/4分别只减少25%/50%理论Euler调用；不会同比减少总时长。已见短片四步重影，评估应含身份、肢体、闪烁、快速运动、口型和音频。
3. **需要保留8步时，独立比较Spectrum/FBC。** 不同时混cache与稀疏；记录actual、forecast/cache hit、fallback。命中少或质量明显改变时，不靠不断调大阈值追宣传倍速。
4. **比较保留 DiT 的固定开销。** 轻 VAE 已确认 latent 接口兼容，但仍需配对解码质量与耗时证据；选择已含 PR16657 的 runtime 或作者 loader。重复 prompt 的 conditioning 复用只加速可复用请求，不能算新 prompt 加速。
5. **新学生模型只作明确任务的替换对照。** LightX2Vv1.2、HyperFlow、TaoMate、FastH3、LynnReal必须分别固定训练范围、sigma、loader和NSFW组合。T2VA学生不能仅凭Comfy可加载就当作I2V生产升级。

软件升级可以修正真实兼容性问题，但“版本更高”“文件更小”“作者 GPU 上几秒”不足以选择本机默认。当前证据足以排除直接照抄 M5/NVIDIA 成绩与重复叠 Turbo；还不足以指定一个已经实测的“最新最好 M4 NSFW 方案”。本轮完成来源、运行状态与源码路径核对，新增方法尚未在本机进行同规格速度/质量 A/B。

[turbo-spec]: https://github.com/ModelTC/Minimax-H3-Turbo/blob/02e26d591f7a04d5d1a074c9566d5dd4f22f6225/README.md
[turbo-hf]: https://huggingface.co/lightx2v/Minimax-h3-Turbo/tree/3ec17a324ced54151364f24f8b5fb6bf7e26414f
[pdd-hf]: https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs/blob/335001fb9e5455d68a0caa18ec2e319072150328/README.md
[pdd-comfy]: https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc/blob/311a65dd53832d8a5f8177a9d5fb923c09e35a90/README.md
[fasth3-lora]: https://huggingface.co/FastVideo/FastVideo-FastH3-4-step-Preview-v1-LoRA/blob/f509e629374cac104e7f62daecce6d1488a3041d/README.md
[fasth3-v2]: https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2/blob/3da2ddfe1954d9cda4c05b643dc0f26007a655c5/README.md
[fasth3-comfy]: https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy/blob/ec1e3aa374a91c57b0b94a1623b7e657c0498cf2/README.md
[fasth3-nvfp4]: https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2-NVFP4/blob/0aa5247ba4a5d3f9f4fdb99536d8cf55bdc5e2f0/README.md
[hyperflow]: https://huggingface.co/videorebirth/hyperflow/blob/5bde94d7de3e78dafa2abc43ee2f280a1cb244e8/README.md
[taomate]: https://huggingface.co/TaoLiveAIGC/TaoMate-H3/blob/7d7a51f3e63972138882ec2f0e4d1d47728110cf/README.md
[taomate-comfy]: https://huggingface.co/CZMartin22/TaoMate-H3-3step-ComfyUI/blob/3fc6fda82a6684543235b38bcd45f075530ed1c6/README.md
[raven]: https://github.com/mvp-ai-lab/RAVEN/blob/927255c3c7f52ff4513a456f1cfe68726f68d919/README.md
[lightx-guide]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/scripts/minimax_h3/README_zh.md
[lightx-model]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/lightx2v/models/networks/minimax_h3/model.py
[lightx-mps]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/configs/platforms/mps/minimax_h3_t2av.json
[lightx-mps-four]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/configs/platforms/mps/minimax_h3_t2av_4step_512_22.json
[lightx-mps-offload]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/lightx2v/models/networks/minimax_h3/infer/offload/mps_transformer_infer.py
[lightx-dpcache]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/configs/minimax_h3/decache/minimax_h3_ref2av_sp_k14_sol.json
[lightx-compile]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/configs/minimax_h3/minimax_h3_compile.json
[comfy-h3]: https://github.com/Comfy-Org/ComfyUI/blob/v0.38.0/comfy/ldm/minimax/model.py
[comfy-attention]: https://github.com/Comfy-Org/ComfyUI/blob/v0.38.0/comfy/ldm/modules/attention.py
[sage-readme]: https://github.com/thu-ml/SageAttention/blob/d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5/README.md
[spectrum-readme]: https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3/blob/5161f0457bc8c52535212d6783eee73f439e1537/README.md
[spectrum-release]: https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3/releases/tag/v0.2.28
[fbc-readme]: https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache/blob/f7a27128e73e1859f2295e64698164203799029d/README.md
[mps-flash]: https://github.com/mpsops/mps-flash-attention/tree/41c7e20c86d1b783a4f7bb29c2db7bfe4b758c43
[mtl-flash]: https://github.com/pawel-mazurkiewicz/mtlflashattn/tree/031ec46d9ed5a9c181ac7f4a3628062786e12ee9
[as-fp8]: https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/9c78935963e885ba93313807974dc64d71058c7f/README.md
[app-mlx]: https://github.com/appautomaton/mlx-h3/blob/adee6a39f8d0dc639e6c5e371fdafb7ef19e4dad/README.md
[pipe-mlx]: https://github.com/PipeNetwork/minimax-h3-mlx/blob/b2f7e4d2b7861cefe68b75e4b59ab81cc4e7c318/README.md
[wee-readme]: https://github.com/wee-todd/WeeTodd-Nodes/blob/7038ce6c0a4c834f51b47f4eedb27d2833b9d3e8/README.md
[vdn-readme]: https://github.com/OpenVDN/vdn-minimax-h3/blob/64b91c48d1abe0293b760326f951bbb3927ce23e/README.md
[sol-h3]: https://github.com/NVlabs/Sana/blob/670482d8a857d578ac8a2ea89b052d0fb47badba/models/minimax_h3/Sol-H3/README.md
[sd-convrot]: https://github.com/leejet/stable-diffusion.cpp/blob/3f8527a46c54ecf4cb4ed6003da8e8982283c73c/docs/int8_convrot.md
[speedrun]: https://github.com/EvolvingLMMs-Lab/MacOS-H3-Speedrun/blob/9326b3e019174b067880572385b5256b910b2dca/README.md
[swift-h3]: https://github.com/loading-awesome/MiniMax-H3-Swift/blob/d9bc40215bea02bf98a7fb53416cc3acf74c5e3f/README.md
[diffsynth-h3]: https://github.com/modelscope/DiffSynth-Studio/blob/d3936694ca81bc7f8bfc6038e4a3eb087447cfac/docs/en/Model_Details/MiniMax-H3.md
