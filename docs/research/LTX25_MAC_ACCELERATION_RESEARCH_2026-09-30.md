# LTX 2.5 / RedGraft 在 Mac 上的加速调研

日期：2026-09-30。范围：Apple Silicon 本地视频生成，重点是当前 M4 Max / ComfyUI / RedGraft 路线。本文记录最初的只读调研阶段；后续已开始隔离实验，结果与证据限制见[实验记录](LTX25_MAC_ACCELERATION_EXPERIMENTS_2026-09-30.md)。下文“未执行”均指最初调研阶段。

证据区分：**官方事实**来自 Lightricks / Comfy-Org / Apple / MLX；**作者报告**来自实现者维护的仓库、源码、模型卡；**工程判断**是对本项目的候选实验排序。社区作者的一手报告不等于 Lightricks 官方支持或本机验收。

## 结论

当前已经是 LTX 2.5 的短步数、无 CFG、Conv VAE 路线；新增机会主要在**文本编码设备、真正的 Metal attention，以及 MLX 原生量化算子**。继续把“换 distilled / 换 Conv VAE”列作新增加速会重复已经完成的工作。

- **最小改动候选：保留 RedGraft，单独比较 CPU 与 MPS 文本编码，再比较 split 与 MPSGraph / Metal attention。** 优先核验官方 LTX 已接入的 `mps-sdpa`，再试 `mtlflashattn`；这可以区分设备/attention 收益与模型变化，不能预先承诺倍数。
- **最值得建立的后端候选：WeeTodd 的 MLX Q8 ComfyUI 节点，其次是 dgrauet MLX 独立 pipeline。** 两者已有 LTX 2.5 实现，但要准备其接受的 MLX 权重；尚无证据证明它们直接接受当前 RedGraft W4A8 + INT8 ConvRot 文件。[WeeTodd 固定版本](https://github.com/wee-todd/WeeTodd-Studio/tree/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba)、[dgrauet 固定版本](https://github.com/dgrauet/ltx-2-mlx/tree/1724ca673d59f023a8a95efee06e5d36d61c2765)
- **M5 原生低精度 kernel、CUDA SageAttention / NVFP4、LTX-2.3 TeaCache 的宣传数字不适用于当前 M4 RedGraft。** 稀疏 attention 与减少 refinement 步数可以作为质量换速度的后续实验，不能当无损替换。

## 本地现状

本轮读取 canonical workflow、PM2 wrapper、8188 `/system_stats`、监听进程参数及筛选后的加速环境变量；没有提交生成任务。硬件与运行版本为现场事实，采样规格为当前代码契约。

| 项目 | 2026-09-30 核对结果 | 证据 |
| --- | --- | --- |
| Mac | M4 Max，40 GPU cores，128 GB unified memory，macOS 26.5.1 | `system_profiler` / `sw_vers`；未保存设备唯一标识 |
| 默认模型 | `redgraft-ltx25-fast2k-int8-convrot`；实际文件 `redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors` | [Gen 运行约定](../../packages/gen/README.md)、[workflow](../../packages/gen/workflows/redgraft-ltx25-i2v.json) |
| 输出契约 | 768×1152，121 帧，24 fps，约5.042秒，MP4带音频；名称里的2K不是当前交付尺寸 | 同上 |
| 采样 / 解码 | deterministic Euler，8+3次采样，CFG=1；×2 latent upscale；Conv BF16 VAE；tiled decode | [workflow](../../packages/gen/workflows/redgraft-ltx25-i2v.json) |
| 文本编码 | LTX专用Gemma4 12B INT8 ConvRot，`CLIPLoader.device=cpu` | [workflow](../../packages/gen/workflows/redgraft-ltx25-i2v.json) |
| 运行进程 | 8188，split attention，`--cache-ram 10 128`；ComfyUI0.34.2，PyTorch2.13.0，Python3.13.12 | 当前 `/system_stats` / 进程参数；[wrapper](../../scripts/start-comfyui-idream.cjs) |
| 已启用补丁 | `tensor_to_fp8,int_mm_mps,fused_norm_mps,rope_fast_mps`；native FP8开关为off；TE device / Metal flash patch未列入allowlist | 当前进程环境 / [wrapper](../../scripts/start-comfyui-idream.cjs)；启用不等于已证明每个kernel命中 |
| 生命周期 | conditioning完成后卸载off-device模型并驱逐RAM缓存 | [生命周期节点](../../packages/gen/comfyui_nodes/idream_memory_lifecycle/__init__.py) |

**因此不应把 fused RMSNorm / RoPE、Conv VAE、短步数或当前阶段卸载再次列作新增收益。** 原来的8月笔记只启用两个补丁、使用旧PyTorch；当前已有四个补丁和PyTorch2.13，历史速度不能直接当本轮基线。

本轮仓库HEAD为 `c1d4508e11dd306b36cd4cfd38163a6fd3ea34a6`，工作树含其它任务修改。本次读取的workflow SHA-256为 `362c5361425a046254c479c080117f390a2cc709f4cbb07182e5f35980cde131`，wrapper为 `283283c69ca91a31e0a93eae67ad01a7530a5ddf155dc1d1f3bed9e2879dff3f`。外部Comfy checkout为 `c645560264062e6a5b0688d25eaf3ee9906a7709`；AppleSilicon-FP8 checkout为 `911294ca35093eef56f7f2695414ff8810e88e50`，但其fused norm代码有本地修改，不能只凭commit复现。所读 `fused_norm_mps.py` SHA-256为 `1fd7ff808b3787f342c3de889711ed78677888b23d9bbd17b59e927c73bf56c8`。这些是源码/运行配置快照，不是绑定当前revision的性能验收。

### 已有本机性能证据

| 历史实验 | 观察 | 使用边界 |
| --- | --- | --- |
| 2026-09-02完整RedGraft日志 | stage1约185秒，stage2约355秒，总783秒；另一次约725秒 | 高分辨率stage2是明确的大开销；剩余时间含编码、加载、解码，不能全归为CPU文本编码。最初读取的原始本机日志 `.tmp/product-audit-20260902/iteration3-final-r5-video-redgraft-backend-comfy.log` 后因临时目录清理已不可访问 |
| 2026-09-12 SDPA候选 | 820.656秒，对比历史split 841.614 / 864.129 / 890.340秒；相对中位数省时约5.0% | 不是同轮交错A/B；是普通PyTorch SDPA，不是新的MPSGraph或Metal flash。不能证明它们只有5%收益。[历史研究](LTX25_ACCELERATION_MODELS_RESEARCH_2026-09-12.md)；最初读取的本机原始JSON `.tmp/redgraft-sdpa-probe.json` 后因临时目录清理已不可访问 |
| BF16计算候选 | 历史A/B/A完整工作流为1005.2 / 878.0 / 1096.9秒，候选端到端省时约12.7%–20.0%；其中两阶段采样分别为732.7 / 588.0 / 773.8秒 | 平均逐帧SSIM0.875，运动/表情变化；是有质量差异的候选，不能称无损。9月12日摘要把采样耗时写成完整工作流，本表按原归档区分。[验证归档](DIFFSYNTH_LTX25_INT4_VALIDATION_2026-09-05.pdf)、[历史摘要](LTX25_ACCELERATION_MODELS_RESEARCH_2026-09-12.md) |

第一行对应旧运行条件，第二行的历史报告还包含不同revision/冷热状态；第三行本轮读取原PDF的已索引文本并复核算术，未重跑。以上均不替代当前运行版本的fresh benchmark。

## 查询版本与官方配方差异

| 实现 | 本次固定版本 | 可核验范围 |
| --- | --- | --- |
| WeeTodd-Studio（原 WeeTodd-Nodes） | `85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba`，2026-09-30 | ComfyUI MLX 节点、Q8-paged conversion、Sol 实验路径 |
| dgrauet/ltx-2-mlx | `1724ca673d59f023a8a95efee06e5d36d61c2765`，v0.15.12，2026-09-27 | 2.5 packs、conv decoder、TeaCache 限制 |
| ComfyUI-AppleSilicon-FP8 | `9c78935963e885ba93313807974dc64d71058c7f`，v1.3.4，2026-09-23 | M4 / M5 capability gating、SDPA patch、TE device patch |
| Lightricks/LTX-2 | 当前 main / CHANGELOG v1.4.0，2026-09-29 | 本次未取得固定 SHA；以下官方 main 链接可能继续变化 |

官方 `pipelines.md` 当前称 Distilled stage 1 为 8 步、stage 2 为 4 步；但是 `constants.py` 的 stage 2 仍为 `[0.909375, 0.725, 0.421875, 0.0]`，Euler 与 ancestral loop 都遍历 `sigmas[:-1]`，因此源码是 **8 + 3 次 transformer evaluation**。这是文档/源码不一致，不能据文档断言升级新增了一步。[pipeline 文档](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/pipelines.md)、[sigma 常量](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/src/ltx_pipelines/utils/constants.py)、[sampler 循环](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/src/ltx_pipelines/utils/samplers.py)

真正已确认的官方变化是 **v1.4.0 对 2.5+ 两阶段采用 Euler ancestral（eta=1）**。dgrauet 的当前说明仍是 stage 1 ancestral、stage 2 deterministic；本地 RedGraft 是既有 deterministic Euler 配方。换 runtime 可能同时改变采样和画面，速度对照必须固定 sigma、实际 forward 次数和噪声规则。[官方 changelog](https://github.com/Lightricks/LTX-2/blob/main/CHANGELOG.md)、[官方 distilled 实现](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/src/ltx_pipelines/distilled.py)、[dgrauet 版本说明](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/README.md#ltx-25)

## MLX Q8：已有实现，仍需转换与质量对照

**MLX 的 affine Q8 是一个真实计算路径，不只是更小的磁盘文件。** `mx.quantized_matmul` 接受压缩 weight、group scales / biases；group-wise 格式与 Comfy 的 tensorwise INT8、ConvRot、W4A8 metadata 并不相同。应区分“MLX kernel 能执行 Q8”与“某个 loader 能正确转换 RedGraft”。[MLX quantized_matmul API](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.quantized_matmul.html)、[WeeTodd converter](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/scripts/convert_ltx25_paged_q8.py)

### WeeTodd：接入现有 ComfyUI 的首选候选

原仓库已重定向为 WeeTodd-Studio，ComfyUI nodes 仍维护。它提供 Component Loader、Generation Config、Media Conditioning、Generate Video + Audio 和 Unload MLX Runtime，以及 `768×512` 二阶段图；核心 LTX 2.5 generation 节点仍标为 Experimental。[固定版本节点清单](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/README.md#node-reference)、[二阶段 workflow](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/workflows/balance/t2v/ltx25_768x512_two_stage.json)

转换入口 `convert_ltx25_paged_q8.py` 明确面向官方 BF16 transformer / LTX Gemma 4 encoder，默认 group size 64；README 也使用官方 BF16 输入。作者还提供预转换的 distilled Q8 pack。**这不是现有 Comfy `.safetensors` 原生量化文件的通用导入器。**[转换代码](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/scripts/convert_ltx25_paged_q8.py)、[作者模型包](https://huggingface.co/Vayden/LTX-2.5-MLX-Q8-Paged)

可落地的两种验证边界：

1. **官方 BF16 → MLX Q8 对照。** 先证明官方 LTX 2.5 distilled 在 MPS / MLX 的算子与完整 I2V 契约，再与现有 RedGraft 比业务画面质量；这项同时更换权重，不能把全部收益归于 MLX。
2. **保持 RedGraft 模型内容的转换实验。** 必须先还原其 W4A8、INT8、ConvRot 与混合层，保留模型参数/融合内容，再校验 MLX tensor names、layout、encoder 全部 hidden states 和双投影。转换是否可用尚未证明，不能直接再次量化已量化权重并声称等价。

公开速度数字的适用范围：

| 作者报告 | 条件 | 结论与限制 |
| --- | --- | --- |
| 87.79 秒 generation / 110.31 秒 complete Comfy；19.07 GB peak | LTX 2.5 Q8-paged、baked Union Canny、768×512、121 帧、24 fps、8+3 | 证明完整 Comfy 路径已有作者验收；该段未绑定生成硬件、精确 runtime commit 或原始 timing JSON，不能当本机结果或与768×1152 RedGraft算倍数 |
| 305.43 → 287.22 秒；MP4 相同 | 768×448、121 帧、10 forwards，live Q8 LoRA fusion → baked Q8 | 隔离的是 LoRA 预融合收益；当前无对应 live LoRA 开销时不能照搬 |
| 379.15 → 343.74 秒（9.3%）；sampling 358.94 → 323.46 秒 | compact Ingredients、paged-speed Sol、17,472 rows | 稀疏路径；改变 routing / precision，composition和trajectory可变化 |

上述数字来自作者的[固定 README](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/README.md#ltx-25-model-layout)及[优化表](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/README.md#performance-and-memory-optimizations)，是候选筛选证据，缺少与当前 M4 RedGraft 同输入的 A/B。

### dgrauet / xocialize：独立 MLX 对照臂

dgrauet 当前 2.5 路线支持 distilled T2V/I2V 与 joint audio，并有 local split pack / Q8 / Q4 loading；conv 是速度默认。其 README 明确 2.5 TeaCache 未校准而拒绝。xocialize fork另提供2.5 MLX split/Q8转换，特性和 parity 进度与主线不同；不要混用两者 pack 命名或默认配置。[dgrauet 当前 README](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/README.md)、[xocialize runtime](https://github.com/xocialize/ltx-2-mlx)、[MLX 2.5 模型卡](https://huggingface.co/mlx-community/ltx-2.5-mlx)

`--low-ram` block streaming 是内存工具：作者称 transformer peak 降约75%、每步增加约5%时间。128 GB机器应先试常驻 Q8；只有峰值/swap确实限制吞吐时再试streaming。Q4亦不能保证比Q8快；一份明确仅针对LTX-2.3的MLX实现报告Q4/Q8 denoise接近，其M5 128GB数字不是LTX2.5 M4 benchmark。[streaming说明](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/docs/PIPELINES.md#memory)、[LTX-2.3量化说明](https://github.com/appautomaton/ltx-video-mlx/blob/main/docs/quantization.md)、[对应性能条件](https://github.com/appautomaton/ltx-video-mlx/blob/main/docs/performance.md)

## M4 上保留模型的 attention 与文本编码机会

### Metal attention

`mtlflashattn` 提供 `F.scaled_dot_product_attention` patch。M4使用v1 `simdgroup_matrix`或安全的chunked-fp32 fallback；M5才使用TensorOps v2/v2r。README的3–11×是M5/macOS27、局部attention，不能作为当前端到端收益。[kernel tiers与基准](https://github.com/pawel-mazurkiewicz/mtlflashattn/blob/main/README.md)

AppleSilicon-FP8 的 `flash_attn_mtl` patch 只接管 SDPA / flash import seam。当前 split attention 不会自动变成该 kernel；实验需要明确路由到 SDPA / 对应attention seam，并开启trace核对实际调用、shape、dtype和tier，保留masked cross-attention fallback。[patch代码](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/9c78935963e885ba93313807974dc64d71058c7f/_patches/flash_attn_mtl.py)、[trace接口](https://github.com/pawel-mazurkiewicz/mtlflashattn/blob/main/README.md#diagnostics)

另一个优先候选是 `mps-sdpa` 的 zero-copy MPSGraph fused attention；Lightricks当前源码已采用它作为Apple Silicon的自动attention后端。作者M4/macOS26.4.1/torch2.13 nightly、BF16、B1/H8/D64报告L8192从317ms降到44.3ms；这是attention微基准，且非bitwise相同。**官方LTX pipeline接入不等于当前Comfy0.34.2已经接入**，只换 `--use-pytorch-cross-attention` 也不能证明命中此库。[官方接入源码](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-core/src/ltx_core/model/transformer/attention.py)、[实现者基准](https://github.com/crlandsc/mps-sdpa#measured-performance)

attention换核必须先对真实LTX Q/K/V和mask与chunked-fp32 reference核验，再看完整画面。LTX-Desktop #165存在2.5 MPS绿色视频报告，根因尚未确认；Comfy #15818存在默认SDPA黑色视频、split正常的复现。它们证明运行完成不能替代产物验收，不能证明所有当前版本仍失败。[Desktop报告](https://github.com/Lightricks/LTX-Desktop/issues/165)、[Comfy报告](https://github.com/Comfy-Org/ComfyUI/issues/15818)

### 文本编码设备 / conditioning缓存

AppleSilicon-FP8的 `te_device_mps` patch专门修复Comfy在SHARED模式下默认把TE放CPU：只改load device，保留offload device。本项目实验不能直接写不被CLIPLoader接受的`device=mps`；需要`default`配合该patch或专用loader，并确认编码后释放与采样峰值。[patch源码](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/9c78935963e885ba93313807974dc64d71058c7f/_patches/te_device_mps.py)

相同prompt的conditioning复用能省重复编码，但首个新prompt没有收益，且cache key必须包含encoder版本/权重、tokenizer、padding、projection、prompt等。降低Gemma padding的1024上限会偏移RoPE位置，应与设备/量化实验分开。[dgrauet padding限制](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/docs/PIPELINES.md#speed)

## 应排除或后置的宣传路线

| 路线 | 本次判断 | 来源 |
| --- | --- | --- |
| M5 W8A8 / FP8原生Metal matmul | AppleSilicon-FP8新gate要求M5+；M4不启用重型kernel。约24%端到端来自Krea2而非LTX2.5 | [v1.3.4 README](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/9c78935963e885ba93313807974dc64d71058c7f/README.md#quick-start--by-machine) |
| ANE | 未找到本次候选提供LTX2.5 22B DiT ANE可用路径；MLX/Metal GPU和M5 GPU Neural Accelerators不能等同Apple Neural Engine | [MLX框架](https://github.com/ml-explore/mlx)、[Metal attention tiers](https://github.com/pawel-mazurkiewicz/mtlflashattn/blob/main/README.md#kernel-tiers) |
| SageAttention / FA3 / FA4 / NVFP4 | 原生快路径依赖CUDA/NVIDIA架构；官方NVFP4明确Blackwell，不适用于当前M4 | [Sage安装要求](https://github.com/thu-ml/SageAttention#installation)、[LTX官方优化](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/optimization.md)、[官方changelog](https://github.com/Lightricks/LTX-2/blob/main/CHANGELOG.md) |
| TeaCache /普通DiT residual cache | dgrauet当前sha明确拒绝2.5；2.3 dev/CFG的1.46×/1.78×不能套到当前8+3 distilled | [当前版本限制](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/README.md#ltx-25) |
| WeeTodd Sol sparse attention | Experimental，需至少16000 video tokens、reference suffix 64-row alignment；改变routing与精度，当前目标未必触发 | [固定优化表](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/README.md#performance-and-memory-optimizations) |
| 更少refine步数 / full-res single-stage | 可单列预览档；不是无损计算优化，不能同时改配方后声称后端等价加速 | [MLX step flags](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/docs/PIPELINES.md#speed)、[WeeTodd single-stage graph](https://github.com/wee-todd/WeeTodd-Studio/blob/85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba/workflows/speed/t2v/ltx25_1344x768_sol_paged_speed.json) |

## 本机实验顺序与验收

以下是建议的下一轮实验，尚未执行。先记录当前运行版本的冷/热态分段耗时，再按单变量排序；所有测试使用隔离runner，避免改变现有8188或占用H3的8190。

1. **文本编码CPU → MPS。** 保持同一INT8 Gemma权重、tokenizer、1024 padding、全部hidden states及LTX双投影。`device=default`需配合明确的TE device patch或loader；不使用全局 `--gpu-only` 来改变整个工作流。当前内存节点跳过 `loaded.device == render_device` 的模型，移到MPS后原有卸载不会照常发生，必须同时验证编码器释放、物理RSS、采样峰值与swap活动。先测encode，再以完整视频核验conditioning变化。
2. **split → MPSGraph `mps-sdpa`，再比较 `mtlflashattn`。** 保留模型与采样规则，记录真实kernel调用、LTX shape、dtype、mask、峰值内存与完整耗时；先验证tensor误差和有限值，再检查首/中/末帧及全视频。旧的普通SDPA结果只作为第三个控制组。出现黑/绿/灰片或后段塌缩时即判失败。
3. **保留RedGraft采样，试独立MLX Q8 Gemma编码。** 必须先校验LTX conditioning契约，再计入MLX → PyTorch传递与加载开销；Q8先行，Q4后置。不能用普通Gemma聊天服务的最后一层输出代替。
4. **完整MLX Q8 / WeeTodd Comfy路径。** 先以官方BF16与其Q8转换隔离runtime收益，再单独评估RedGraft导入。保持5秒/121帧、768×1152、首帧条件及音轨；另一个768×512模型的秒数不能算本项目加速。128GB允许优先比较常驻模式，paging只在实际内存压力下加入对照。

每个候选固定输入图SHA、prompt、seed、checkpoint SHA、runtime与本地patch hash、sigma及实际forward次数。相同seed用于复现，不保证不同引擎的RNG输出像素相同。记录加载、encode、两段sampling、upscale、VAE、编码保存、端到端时间和完整进程物理峰值；核实没有命中整图结果缓存而跳过计算。最小性能对照先做交错A/B/A，进入默认路由前再用至少3个seed检查身份、肢体、动作、音画同步和失败恢复。

若业务愿意新增较低规格预览，可以单独比较跳过stage2或降低分辨率；这会改变产品配方/交付契约，必须作为明确的新profile评估。当前两阶段目标video token粗算为 `24×36×16=13,824`，还需实测reference/audio行数与Sol实际gate，所以不先投入要求≥16,000 video tokens的稀疏方案。继续保留当前Conv VAE，不把Diffusion VAE/DFR扩展作为速度优化。

## 本次验证与局限

已读本项目2026-09-12加速研究及2026-09-05 Gemma Q4研究，核实最新一手仓库/源码与模型卡，固定主要社区runtime SHA，交叉核对官方sigma与sampler，并只读核对本机硬件、8188运行配置及历史日志。未进行本机编码或视频A/B，没有新的实测加速百分比。公开社区benchmark的硬件/配方/权重与当前RedGraft不一致，不能转成项目性能承诺。

## Gemma 量化选择补充

针对当前 M4 Max 128GB / RedGraft Comfy 路线，工程建议继续用已安装的 `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`。LTX 官方将 BF16 列为参考配置，将 INT8 ConvRot 列为低内存配置；Comfy-Org 当前 LTX 2.5 模板默认选择 INT8 ConvRot。它是当前可核验的标准模板选择，不能据此声称整个社区的实际使用占比。[官方配置](https://docs.ltx.io/open-source-model/integration-tools/comfy-ui)、[官方模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_ltx2_5_t2v.json)

社区 elix3r 发布 Q2_K / Q4_K_M / Q5_K_M 的 LTX 专用 GGUF，其中 Q4_K_M 为 8.41GB、Q5_K_M 为 9.51GB，安装示例选择 Q4。作者报告 Q5 已完成单阶段、双阶段音视频生成；Q4 和 Q2 只声明 loader 与完整 encoder forward 验证，不声明相同端到端验证。作者明确数值兼容检查不等于感知质量对照。因此，低内存 GGUF 试验优先 Q5、再考虑 Q4；不是当前128GB机器提速的默认动作。[发布者模型卡](https://huggingface.co/elix3r/gemma4-12b-with-proj-ltx-2.5-GGUF)

补充定位到 RedGraft 作者 EllaPriest45 发布的 `REDGraft (NSFW) INT8 - LTX2.5.json`。其 `Models & Setting` 子图中，启用且有下游连接的 `CLIPLoader` 节点425配置正是官方 Gemma 4 INT8 ConvRot，并附官方模型下载链接；旧 Gemma 3 / LTX2.3 DualCLIPLoader 节点424为 bypass且无输出连接。它支持“沿用作者提供的Gemma 4 INT8配置”，不是作者对所有量化版本的性能比较。[作者随附workflow](https://huggingface.co/EllaPriest45/LTX2.5_checkpoints/blob/main/REDGraft%20%28NSFW%29%20INT8%20-%20LTX2.5.json)、[本机下载副本](../../.scratch/ltx25-mac-optimization-20260930/redgraft-author-workflow.json)

本轮没有代表性的社区使用比例统计。FP8 / NVFP4 的 NVIDIA 快路径不能用作 M4 性能依据；模型文件更小不保证当前 Comfy MPS forward 更快。必须使用 LTX 2.5 专用 Gemma 4 与双投影，普通聊天 Gemma 或旧 Gemma 3 不可直接替换。[LTX 兼容要求](https://docs.ltx.io/open-source-model/ltx-trainer/quick-start)
