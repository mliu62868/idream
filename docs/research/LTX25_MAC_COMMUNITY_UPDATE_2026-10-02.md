# LTX 2.5 Mac 社区加速复核（2026-10-02）

本轮只调研和读代码，不下载大权重、不运行 GPU、不调整默认服务。在线复核截止 2026-10-02；下面区分作者实测、源码支持和本机尚未验证的推断。后半部分结合本机计时给出实施顺序。

## 结论

**当前优先复验已实现的模型局部 MPSGraph attention；采样占最近一次完整视频耗时的91.64%，Gemma加载与编码只占0.64%。** 社区MLX路线再重点筛选常驻权重下的FFN融合、共享编译block及预览中间状态复用。降低量化位数、切换整个MLX pipeline、照搬H3跳层，都没有当前规格下的确定收益；本机数据与依赖限制见后半部分。

社区项目支持“LTX 2.5 图生视频并生成音轨”，不等于已兼容我们的 RedGraft 有效权重、conditioning、sigma 表和随机数路径。公平实验须优先使用当前有效权重转换出的 MLX pack，并固定视频与音频契约。

**“本轮新找到”与“9 月 30 日之后新发布”必须分开。** 本轮新增价值主要来自 vanch 的完整等价基准、COEY 的算子剖析以及 janishar 的直接加载源码；这些证据均早于 9 月 30 日。

## 固定版本与时效

在线读取 GitHub 提交及完整文件树，再抓取固定 SHA 源码；日期为 UTC 提交时间。

| 项目 / 分支 | 2026-10-02 可见固定提交 | 日期 | 与上一轮关系 |
| --- | --- | --- | --- |
| WeeTodd-Studio / main | [4cf1b07a7e84](https://github.com/wee-todd/WeeTodd-Studio/commit/4cf1b07a7e846ec3ded4d24a918c3053d2208b58) | 10-01 | 新提交为 Swift 原生模型安装入口；不能据此声称 DiT 新提速 |
| dgrauet/ltx-2-mlx / main | [1724ca673d59](https://github.com/dgrauet/ltx-2-mlx/commit/1724ca673d59f023a8a95efee06e5d36d61c2765) | 09-27 | v0.15.12，仍是 9/30 已调查版本 |
| vanch007/ltx-2.5-mlx / main | [183268443cca](https://github.com/vanch007/ltx-2.5-mlx/commit/183268443cca73d3856884d31f8a40201d8cdf21) | 08-14 | 本轮深入复核的旧证据 |
| xocialize/ltx-2-mlx / ltx-2.5 | [c952c8f601e4](https://github.com/xocialize/ltx-2-mlx/commit/c952c8f601e4fc5371d91b609ef5e0d85ba23751) | 08-16 | 与上一轮一致，最后改动为长提示词截断 |
| janishar/ltx-2-studio / main | [b63613e0a896](https://github.com/janishar/ltx-2-studio/commit/b63613e0a896e6809ec989af7c533fc11aed924c) | 09-24 | 本轮新增审查；最近合入官方蒸馏 LoRA 的第二阶段接线 |
| COEY speed study / main | [8606f9924980](https://github.com/coeyai/ltx-2-mlx-speed-study/commit/8606f992498072c199525643e1913a243a5d87c4) | 09-19 | 本轮新增剖析；并非 10 月新优化 |
| mflux-community/mflux / main | [8e3c29c1d962](https://github.com/mflux-community/mflux/commit/8e3c29c1d962a8d4c3d587781e60cfcd65752669) | 10-02 | 新提交为 ERNIE 图片命令，未发现 LTX 支持 |

WeeTodd 依赖固定的 dgrauet revision 与该项目 main 并不相同；本机旧 MLX 实验使用 `91e6f6c9bd621ff2ae31adfee643e113d67d6ae8`。比较性能时必须同时记录上层节点与实际加载的库，不能只记仓库名。

## 实际兼容范围

| 路线 | I2V / 音轨 / 两阶段 | 量化、LoRA 与限制 |
| --- | --- | --- |
| dgrauet | 2.5 pack 支持 I2V、48 kHz 立体声、distilled / dev 两阶段 | BF16 / MLX Q8 / Q4；通用 LoRA 与任务 LoRA 分开；2.5 TeaCache 明确拒绝启用 |
| vanch | 有 5 个图像 anchor、8+3 两阶段与音轨的完整实测 | Q8 DiT / Q4 Gemma，group 64；存在 LoRA 加载接口，但当前 RedGraft 全部适配尚未验证 |
| WeeTodd LTX 2.5 | 原生组件、I2V、音轨、两阶段及独立 IC-LoRA 路径 | 支持普通 LoRA / 预烘焙 paged Q8；Sol、paging、FFN 实验后端有互斥和门槛 |
| janishar | 源码 / CLI 提供 I2V、音轨、两阶段、LoRA | 官方 BF16 文件加载时 MLX 量化；未找到 INT8 ConvRot 的逆变换实现 |
| COEY | 使用 dgrauet 2.5 distilled 两阶段与视频 / 音频 latent | 是测量与实验工具；没有可直接替换默认服务的独立产品运行时 |
| mflux | 未发现 LTX 2.5 模型或 pipeline | 不能作为本任务的现成 MLX 后端 |

范围依据：[dgrauet 的 2.5 限制表](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/README.md#ltx-25)、[vanch 完整基准](https://github.com/vanch007/ltx-2.5-mlx/blob/183268443cca73d3856884d31f8a40201d8cdf21/benchmarks/ltx25-mlx/optimization-m3-max-128gb/README.md)、[WeeTodd runtime](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/runtime.py)、[janishar README](https://github.com/janishar/ltx-2-studio/blob/b63613e0a896e6809ec989af7c533fc11aed924c/README.md)。

### 量化格式不能直接互换

这些 MLX 路线的量化 Linear 使用打包权重、scales / biases 的 affine 格式；group size 与模块量化元数据也是加载契约。Comfy INT8 ConvRot 的整数、缩放和旋转表示必须先恢复有效权重再转换，不能把其原始整数直接交给 `mx.quantize`。

当前 Gemma 采用官方 INT8 转本地 MLX Q8，来源与已完成验证见 [Gemma 实施记录](LTX25_GEMMA4_MLX_IMPLEMENTATION_2026-10-02.md)。本研究不把未完成下载 / 实测的社区 Q4 当作已切换项。

## vanch：共享编译 block 的实证最完整，但不能重复计算 residency 收益

作者使用 **M3 Max 40 核 GPU / 128 GiB**，Q8/group-64 DiT、Q4/group-64 Gemma，**1024×768、241 帧、24 fps、5 anchors、8+3**。这与当前单图、121 帧规格不同；所有表格行均是单次本地运行，并非稳定分位数。

| 同源 A/B | stream | full resident + shared graph | 作者验证 |
| --- | ---: | ---: | --- |
| 48 block 微基准 | 3.5198 s | 0.4090 s | 数组字节相等；8.61× 仅限该微基准 |
| 完整 1+1 | 653.8579 s | 593.5473 s | MP4 相等；墙钟减少 9.22% |
| 完整 8+3 | 2379.45 s | 1866.0959 s | MP4 相等；墙钟减少 21.57% |

实现保留 48 组独立参数，通过一个共享 `mx.compile` block 执行，每层仍有 `mx.eval` 边界；主要移除了逐步 shard remap / rebind。自动启用还要求物理内存至少 112 GiB，且各阶段只有一个全局 attention tile。[固定基准与门槛](https://github.com/vanch007/ltx-2.5-mlx/blob/183268443cca73d3856884d31f8a40201d8cdf21/benchmarks/ltx25-mlx/optimization-m3-max-128gb/README.md)、[FullResidentLTXModel 源码](https://github.com/vanch007/ltx-2.5-mlx/blob/183268443cca73d3856884d31f8a40201d8cdf21/ports/ltx-2.5-mlx/src/ltx25_mlx/transformer_runtime.py#L133)。

本机 9/30 的 MLX runner 已 `load_weights(strict=True)`、`mx.eval(model.parameters())`、`low_ram_streaming=False`，全部 DiT 常驻，FFN 为 `reference_fp32`。所以 **21.57% 不能当作我们现在的可新增收益**；剩下可测的是共享编译图与权重绑定方式本身。

作者的失败实验同样有价值：48 个分别编译的常驻图反而慢于 streaming；AdaLN dtype 变更改变旧输出且变慢；空间 attention 分两块产生明显重影。上述完整基准只证明同一 Q8 路径优化前后的等价，不能推导出 Q8 与源 BF16 全流程无损。[失败实验与证据范围](https://github.com/vanch007/ltx-2.5-mlx/blob/183268443cca73d3856884d31f8a40201d8cdf21/benchmarks/ltx25-mlx/optimization-m3-max-128gb/README.md#rejected-experiments)。

## COEY：已用 MLX flash attention 的路径，热点仍在 block / GEMM

作者实测 **M3 Max / 64 GB、dgrauet 0.14.23、MLX 0.32.2、2.5 Q8**，使用同一提示词 / seed，内存从进程外采样 `ri_phys_footprint`；作者也记录了机器负载导致 183.1 / 209.9 s 波动。因此引用其配对比值，不跨机器比较绝对时间。[作者文章](https://coey.com/resources/blog/2026/09/19/ltx-on-a-mac-memory-not-attention)、[固定研究报告](https://github.com/coeyai/ltx-2-mlx-speed-study/blob/8606f992498072c199525643e1913a243a5d87c4/STUDY.md#1-method)。

- 768×512×121 的 stage 2：6144 tokens，SDPA 0.098 s / block 0.976 s，约 10%。
- 704×1280×121：14080 tokens，SDPA 0.706 s / block 3.963 s，约 17.8%。
- FFN 形状 6144×4096×16384：BF16 0.115 s、Q8/g64 0.130 s、Q4/g64 0.128 s；Q4 没有明显速度优势。
- 完整 block 普通 0.976 s，`mx.compile` 0.967 s，变化输入版本 0.979 s；没有实用收益。

这是**已经使用 flash kernel 的 MLX 路径**，不能覆盖当前 Comfy split attention 的瓶颈判断。与 vanch 也不矛盾：一个测常驻完整 block 的编译，另一个同时改变 shard 生命周期和共享图；需要各自在现有常驻路径下测增量。[算子数据](https://github.com/coeyai/ltx-2-mlx-speed-study/blob/8606f992498072c199525643e1913a243a5d87c4/STUDY.md#2-the-profile)。

### 预览与续算可以省重复工作，但会改变交付策略

作者把第二阶段改为 sigmas `[0.421875, 0]` 的单步预览：183.1 → 118.2 s；SSIM 0.919、LPIPS 0.162、VMAF 9.1，**质量差异明显**，不能默默替换正式 8+3。跳过第二阶段也不是无损优化。[配对质量表](https://github.com/coeyai/ltx-2-mlx-speed-study/blob/8606f992498072c199525643e1913a243a5d87c4/STUDY.md#3-the-candidates)。

短 schedule 必须保留终点 sigma=0。[PR #141](https://github.com/dgrauet/ltx-2-mlx/pull/141) 已合并，但 stage 1 有 ancestral 重加噪；调整步数会改变轨迹。当前 Comfy 配方与该 MLX 默认 sampler 不能仅靠“8+3”名称认定相同。

缓存第一阶段**视频和音频 latent** 后，预览确认再完成第二阶段，可避免第二次重跑第一阶段；作者的 preview+finish 合计相对 preview+full 减少约 18–20%。[续算提案 #143](https://github.com/dgrauet/ltx-2-mlx/issues/143) 仍未合并为正式上游接口，属于可实施的独立方案，不缩短首次直接生成完整视频的耗时。

缓存键须包含源权重 / adapter、图像与 conditioning、提示词编码、尺寸 / 帧率 / 帧数、sigma / sampler、seed，以及 ancestral 情况的 RNG 状态；两阶段音频处理必须一起复原。不能只凭 prompt + seed 复用。

### VAE 内存结论需要按当前实现重新判断

作者 64 GB 机器原始 VAE 出现 53.4 GB footprint；空间 / 时间 tile 可降峰值，但 blend 改变像素且可能更慢。同一 tile 几何下，在 decode 时将 MLX allocator cache limit 暂设 0，44.2 → 25.8 GB，像素相同。它支持“受内存限制时测缓存与 tiling”，不证明当前已优化 ConvVAE 再分块一定更快。[VAE 与 cache 测量](https://github.com/coeyai/ltx-2-mlx-speed-study/blob/8606f992498072c199525643e1913a243a5d87c4/STUDY.md#4-the-decode)、[估算错误 #142](https://github.com/dgrauet/ltx-2-mlx/issues/142)。

## WeeTodd：必须分清 LTX 与 H3，也要检查优化开关的实际生效

### FFN 可迁移候选

LTX 2.5 提供三个后端：[feed_forward.py](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/feed_forward.py#L303)。

- `reference_fp32`：当前参考实现。
- `mlx_fused_experimental`：融合 RMS / AdaLN、GELU FFN、gate、residual，报告 `approximate=False`；小形状完整 block 有数组相等测试，尚未找到当前生产尺寸的完整速度与视频 / 音轨等价证据。
- `bf16_mpp_experimental`：macOS 26+ 的 Metal Performance Primitives 实验，接受无 bias、BF16 权重的普通 `nn.Linear`；Q8 `QuantizedLinear` 不会被包装，可能全部回到 reference。它还有 BF16 中间值近似，不能称作当前 Q8 的直接加速。

小测试仅证明覆盖形状：[test_ltx25_feed_forward.py](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/tests/test_ltx25_feed_forward.py)。首个实验应输出实际 wrapped / fused 模块数和 resolved backend，再做当前 Q8 与真实 token 数 A/B；开关设置成功不等于 kernel 已运行。

### Paging / Sol 与两阶段存在实码约束

`runtime.py` 明确：paged pack 会启用 streaming，streaming 将 FFN 收敛为 `reference_fp32`；非 `ic_lora_single_stage` 路径会关闭 Sol。因此现成上游的这些开关不能任意组合，更不能据 README 性能表宣称普通 8+3 已得到全部收益。[解析规则](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/runtime.py#L879)。

LTX Sol 是视频 self-attention 的近似 Metal 路由，实际有 head dim=128、约 16000 video tokens 起效、BF16 Q/K/V、reference suffix 对齐等条件。README 报告 Ingredients 17472 rows 的 sampling 358.94 → 323.46 s；这些属于适用 conditioning / 单阶段案例，不是当前两阶段 RedGraft。[Sol 代码](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/sol_attention.py)、[对应性能表](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/README.md#performance-and-memory-optimizations)。

当前 768×1152×121 的普通 stage-2 video grid 推算为 24×36×16=13824，低于上述门槛；额外 reference tokens、mask 与实际路由应从运行记录读取。即使移植到两阶段，也需要质量验证和 fallback / 调用次数证据。

### DFR 是另一种细节生成配方

DFR 组合 dev、蒸馏辅助 LoRA、第二阶段 Pixel-Spatial adapter，并保留第一阶段音轨。它可能增加权重加载、LoRA 融合和 decoder 成本，不能当成通用减少 block 工作量的开关。[配方解析](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/runtime.py#L74)。

WeeTodd 的 Metal DiffVAE 966.45 → 74.72 s 是特定 DFR 对照，对源 decoder 属数值近似；不能用来预测当前 ConvVAE 的收益。Temporal DFR 还有中段色彩异常，属于诊断路径。[DFR 性能与质量限制](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/README.md#performance-and-memory-optimizations)。

LoRA 预烘焙可以去掉重复 live fusion；前提是当前实际存在这项工作。当前已烘焙 RedGraft 权重不能再领取假想的融合收益。

### 排除误套的跳层和 FFN slicing

README 的“保留 40 层 / 跳过 10 层 / 160 Metal calls”属于 **FastH3**，`H3 Low-Memory Tuning` 的 attention head / FFN row chunking 也属于 H3。[H3 的明确限制](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/README.md#fasth3-production-profile)。

`benchmark_ltx25_depth_windows.py` 的 depth 是 VAE staged convolution 的时域窗口，不是 DiT 跳层。[脚本](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/scripts/benchmark_ltx25_depth_windows.py)。本轮没有找到适合当前 LTX 2.5 的已验证跳层方案。

FFN 按 token 行分块具有控制激活峰值的理论依据，但会改变 GEMM 形状与调度；可能更慢。当前 LTX FFN 后端未提供一套已验证的通用 row slicing 方案，若做实验应先测峰值 / kernel 时间，不能把 H3 百分比带过来。

## janishar：直接加载可参考，INT8 ConvRot 兼容仍缺失

作者在 **M5 Pro / 64 GB、704×448×49、distilled** 下报告 PyTorch BF16 142.0 s 与 MLX 加载时 INT8 39.9 s，约 3.56×。它同时改变运行时和精度；43.7 GB footprint 与 20.9 GiB MLX allocator peak 也不是相同内存口径。[固定 README 基准](https://github.com/janishar/ltx-2-studio/blob/b63613e0a896e6809ec989af7c533fc11aed924c/README.md#motivation)。

实码的 `OFFICIAL_FILENAMES` 指向官方 **BF16** 文件；`load_virtual` 读原始 tensor、改键 / 卷积布局，再对符合条件的二维权重做 `mx.quantize(..., bits=4/8, group_size=64)`。未找到 `.comfy_quant` 解析、ConvRot 缩放解码或逆旋转，故不能声明它已直接支持本机 INT8 ConvRot RedGraft。[official_pack.py](https://github.com/janishar/ltx-2-studio/blob/b63613e0a896e6809ec989af7c533fc11aed924c/packages/ltx-core-mlx/src/ltx_core_mlx/loader/official_pack.py#L755)。

可以借鉴键映射与组件加载，但不要新下载整套 BF16 以追求该基准；我们已经有有效权重的转换入口。其官方蒸馏 LoRA 的 stage-2 接线也不能证明任意 RedGraft LoRA 的加载 / 强度 / 两阶段应用完全一致。

## mflux 与其他包装项目

当前 mflux 完整递归树有 1232 个路径，未出现 LTX 路径；README、模型配置与依赖也未提供 LTX pipeline。最新提交为 ERNIE 图片能力。结论只限本次固定 revision 的公开源码，不推断未来计划。[固定源码树](https://github.com/mflux-community/mflux/tree/8e3c29c1d962a8d4c3d587781e60cfcd65752669/src/mflux/models)、[README](https://github.com/mflux-community/mflux/blob/8e3c29c1d962a8d4c3d587781e60cfcd65752669/README.md)。

没有找到可据一级源码与可比基准证明优于上述核心运行时的其他现成 LTX 2.5 Metal 实现。封装 dgrauet CLI 的桌面 / Web 项目不因增加 UI 就构成新的 kernel 加速证据。Vpipe 的 SOL-H3 / Sage Metal 也不能作为 LTX2.5 支持证据。

## 从社区证据可落实的实验

这些是隔离候选，不是默认切换承诺；总体优先级以本机附录为准。

1. **常驻 MLX block 的融合 / 共享图 A/B。** 复用当前有效权重与 `reference_fp32` 基线，分别测共享 compiled block、`mlx_fused_experimental`，不同时改 sampler、dtype 或量化。测真实 stage-2 token 数，再测整个 8+3；先确定可新增收益。
2. **在真实峰值存在时测 FFN 行分块。** 只改 FFN 临时激活生命周期，记录物理峰值和逐 kernel 时间；分块尺寸是实验变量，不先增加产品配置。无速度或内存问题改善则删除候选。
3. **预览确认后续算。** 若产品明确需要快速试镜，独立设计预览规格并缓存视频 / 音频 latent，再接正式三步 refine。必须展示质量区别，绑定缓存与随机状态；不改变当前一次性交付完整视频的默认路径。
4. **持久化已验证 MLX pack。** 可减少重复进程启动的转换 / 准备耗时；本机旧约 70 s 转换属于 preparation，不能计成采样提速。

暂不选择：Q4 作为速度默认、未校准的 2.5 TeaCache、H3 跳层、空间 attention 切块、Temporal DFR，以及只依据跨芯片 README 的整条 MLX 替换。

## 验证口径与剩余限制

- 统一输入图、prompt / negative、有效权重 hash、LoRA、seed、sigma、sampler、尺寸、帧数、fps、音频 conditioning；固定 source revision 与实际库 revision。
- 准备 / 加载、Gemma、两阶段采样、VAE、音频、编码分别计时；冷启动与温启动分开，同机空闲顺序执行。
- 同时记录 `ri_phys_footprint`、MLX allocator peak、swap；RSS、allocator 和总物理 footprint 不互换。
- 先比较同权重 block / latent，再比较解码视频帧与音频 PCM、帧数 / 时长 / 采样率；MP4 hash 仅在容器编码确定时有意义。
- 近似 attention / dtype / quant / sampler 的质量必须单独验收；SSIM 或 cosine 单项通过不能替代视频动态、图像保持与听感。

本轮未运行任何社区 GPU benchmark；数值均明确归属作者，不能当作本机实测。部分项目只给小形状测试或 README 单次数据，缺少多种 I2V 内容和当前规格的完整质量证据；社区总体采用比例也未有可信统计，不声称“大家通常用某一位数”。

抓取记录在 `.scratch/ltx25-community-update-20261002/`：`pinned-repositories.json`、各仓库 commit / tree JSON、`source-downloads.json` 及固定 SHA 源码。本文仅新增研究文件，未修改默认服务。

## iDream 当前瓶颈与优先级

以下为主任务对本地代码、已保存实测和本轮在线来源的交叉核查。2026-10-02 的 `/system_stats` 仍为 ComfyUI 0.34.2 / PyTorch 2.10.0，启动参数仍选择 split attention。canonical workflow v3 已用 Gemma MLX Q8、Conv VAE 加速、8＋3 次 Euler、CFG=1；这些已完成项不再计入新增收益。

最近一次完整 backend 视频为 768×1152、121 帧、24 fps、带音轨，耗时 735.826 秒。它是一次已保存的测量，不是本轮新跑或延迟分布：

| 阶段 | 秒 | 占整段 |
| --- | ---: | ---: |
| 低分辨率 stage 1，8 次前向 | 240.35 | 32.66% |
| 高分辨率 stage 2，3 次前向 | 433.96 | 58.98% |
| 视频 VAE 解码 | 42.29 | 5.75% |
| Gemma 加载＋两分支编码 | 4.69 | 0.64% |

余下约 14.53 秒包含图像准备、其它加载、latent upscale、音频解码、保存等。证据：[Gemma 实施与完整视频记录](LTX25_GEMMA4_MLX_IMPLEMENTATION_2026-10-02.md)、[原始计时](../../.scratch/ltx25-gemma4-mlx-20261002/backend-report.json)、[本轮只读快照及算术](../../.scratch/ltx25-community-update-20261002/local-evidence.json)。

第一性原理上，总耗时约等于固定开销＋8次小图 DiT＋3次大图 DiT。基础 video token 从 `16×18×12=3,456` 增至 `16×36×24=13,824`，不计额外参考等 token；线性层工作量随 token 数增长，dense attention 的理论配对数随 token 数平方增长。因此只有3步的精修也可能更慢。单个未分块 `[32,13824,13824]` BF16 attention 矩阵理论上就占11.39 GiB，但当前 split 会分块；这个数不是实测峰值，也不能由阶段计时直接判定 attention 已占绝对多数。

以当前固定开销不变作条件推算：**两阶段采样耗时减少30% → 总计533.53秒，约8分54秒；采样耗时减半 → 总计398.67秒，约6分39秒。** 这些是 Amdahl 算术，不是社区方案在本机的预测或承诺。即便消除 Gemma 全部加载与编码，也只省约4.7秒。

### 1. 优先复验现有模型局部 MPSGraph 节点

官方 LTX 当前 Apple 路径使用 `mps-sdpa` 的 fused MPSGraph，而本项目仍是 split。库要求 `torch>=2.11.0`；主分支 SHA `3e114e924e1228928569cb889e6c5c78f0cf404f`，最新提交日期2026-05-04，不能把它描述为本周新发布。[官方 attention 源码](https://github.com/Lightricks/LTX-2/blob/2d6e71c88be37b55a2dd698c2dff447edfbe5898/packages/ltx-core/src/ltx_core/model/transformer/attention.py)、[依赖要求](https://github.com/crlandsc/mps-sdpa/blob/3e114e924e1228928569cb889e6c5c78f0cf404f/pyproject.toml)、[作者兼容矩阵](https://github.com/crlandsc/mps-sdpa/blob/3e114e924e1228928569cb889e6c5c78f0cf404f/COMPAT.md)。

已有 `packages/gen/comfyui_nodes/idream_mps_attention/__init__.py` opt-in 节点。9/30 的历史候选采样530.70秒，对比两次split的838.20/765.17秒，减少30.6%–36.7%。但当时Torch2.13、部分原片与日志丢失、仅单seed，不能以此验收今天Torch2.10默认环境，也不能拿它直接与735.826秒完整流程比较。[实验边界](LTX25_MAC_ACCELERATION_EXPERIMENTS_2026-09-30.md)。

具体下一步：在隔离且受支持的Torch环境先建立split基线，再做相同环境的MPSGraph A/B/A；保持权重、conditioning、sigma、两阶段seed、VAE一致。记录真正命中的 `mpsgraph_zc` 调用及fallback，避免校准阈值使所有请求偷偷退回stock。通过后再与现行完整流程对照，并验证Torch升级没有抵消VAE/Gemma收益。无需先迁移整个DiT或更换模型。

### 2. 对 MLX 只测尚未取得的增量

本地9/30 MLX实验已执行 `model.load_weights(..., strict=True)`、`mx.eval(model.parameters())` 并设置 `low_ram_streaming=False`，整个Q8 DiT已经常驻。因此社区由stream改成full-resident的21.57%不能再次算给本项目。共享编译图、FFN精度、矩阵与激活融合需要分别在实际RedGraft形状下测量；先分解单个完整block的耗时，确认优化落在真正的大头。

旧MLX两阶段采样571.07秒，比历史MPSGraph530.70秒慢，环境和浮点路径又不完全相同；它证明可运行，尚未证明迁移更快。约70秒的有效权重恢复与Q8转换可离线准备、保存pack，但省去转换属于准备时间，不是采样提速。新MLX能力仍应集成在Gen workflow-native / Comfy节点内，保持已退役runner取值退役。

### 3. 将预览与正式交付作为不同配方评估

预览可以尝试stage2的3→2→1步或较低分辨率；sigma必须正确到达0，并与起始加噪一致。这样会改变画面，不能默默替换当前正式规格。若用户随后选择精修同一候选，复用该候选的stage1视频/音频latent、conditioning和后续seed，可以避免再次执行约240秒的第一阶段；正式单次生成本身不会因此凭空减少240秒。

缓存必须绑定模型/adapter与runtime版本、源图及预处理、prompt conditioning、尺寸帧数、两阶段sigma与随机状态等生成输入；跨prompt或跨seed的latent不能混用。预览作为新profile/recipe发布，保持旧任务、正式交付、计费与版本契约，且中断后需要释放对应缓存所有权。

### 4. 稀疏 attention、残差缓存放在后面

NVIDIA Sol的4.68×来自4张B200、30步guided配方；与当前8＋3、CFG1不符。其distilled单卡实验使用NVFP4、4K、5秒，端到端提升约1.45–1.90×，主要针对stage2；说明方向有价值，不提供M4倍率。[作者实验](https://nvlabs.github.io/Sana/Sol-Engine/LTX25/)。

本轮找到的Halo-TeaCache证据是AMD Strix Halo、LTX2 19B、15步，不是当前LTX2.5 22B / M4 / 8＋3配方；dgrauet仍拒绝在2.5启用未校准TeaCache。[Halo作者README](https://github.com/bkpaine1/Halo-TeaCache/tree/61097c7495022641ab800e5972c3afb250edb71c)、[dgrauet性能开关](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/docs/PIPELINES.md)。不把不同模型、长步数或CUDA数字当成M4收益。

## 官方版本变化是否值得直接升级

截至本轮查询，Lightricks最新为 `2d6e71c88be37b55a2dd698c2dff447edfbe5898` / v1.4.1（9/30），新增内容是HDR EXR/HLG流式编码。v1.4.0（9/29）带来长视频chunk、transformer tiling、CUDA编译kernel改进，并将2.5 distilled的两阶段改为ancestral采样。当前5秒SDR、Conv VAE、deterministic Euler没有可直接认领的新增倍数，整体升级还会改变采样画面。[固定版本CHANGELOG](https://github.com/Lightricks/LTX-2/blob/2d6e71c88be37b55a2dd698c2dff447edfbe5898/CHANGELOG.md)。

`ComfyUI-AppleSilicon-FP8`仍为9/23的v1.3.4 / `9c78935963e885ba93313807974dc64d71058c7f`，与9/30调研相同；`mtlflashattn`主分支仍为7/9的 `031ec46d9ed5a9c181ac7f4a3628062786e12ee9`。M5/Metal4.1 kernel数字不据此套到M4/macOS26。[FP8固定版本](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/tree/9c78935963e885ba93313807974dc64d71058c7f)、[Metal attention固定版本](https://github.com/pawel-mazurkiewicz/mtlflashattn/tree/031ec46d9ed5a9c181ac7f4a3628062786e12ee9)。

## 下一轮实验的完成标准

- 先按一个变量筛选候选；进入默认配方前，补齐3个固定seed的完整同规格视频，并比较人物、手部、动作、音轨/口型与失败率，不把latent有限值或MP4可解码当成全部画质验证。
- 同时记录加载、两阶段采样、VAE、总耗时与实际内核命中；GPU物理footprint、MLX allocator峰值和RSS分列，排除swap/并行GPU任务干扰。所有真实GPU实验继续使用共享generation lease。
- 保留每次source revision、checkpoint hash、prompt/attempt/artifact标识及原片；验证取消与内存释放。通过后更新canonical workflow、recipe/profile版本与必要的preflight，不直接改旧版本历史。
- 本轮只做在线研究、本地源码/日志核查及算术推演，未更换模型、安装依赖、重启服务或执行新的GPU基准；因此不报告新增实测加速。
