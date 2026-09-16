# RedCraft H3：Mac 加速技术更新与本机适用性

调研日期：2026-09-12。范围是当前 RedCraft H3 I2V + 音频，在 M4 Max / 128 GiB 上的加速；所有外部链接本日访问。本文是资料与源码核查，没有安装插件、下载权重、启停服务或运行新生成。

后续进展：同日已按用户授权完成[完整 Metal attention 算子测试](REDCRAFT_H3_METAL_ATTENTION_OPERATOR_BENCHMARK_2026-09-12.md)。两套库在隔离环境实际运行，当前 H3/VAE 代表性形状没有速度收益，部分路径未通过数值筛选；因此下面的 attention 候选已完成第一阶段筛选，不建议按原调研优先级直接接入。

## 结论

保留 ComfyUI 的选择目前仍合理。最值得验证的是 **8→6→4 步的质量边界、Spectrum 或 FirstBlockCache 的单独缓存对照，以及按真实 H3 shape 测试完整 Metal attention**。这些是候选，不是已证明的本机加速。

9 月确实有新技术：Spectrum 0.2.27、FirstBlockCache deep-reuse、WeeTodd 的 FastH3/VDN/DT Metal 路线。但新的发布日期不等于能直接加速当前 RedCraft：有的是 CUDA 内存修复，有的要求专用学生模型，有的只有文生视频或 M3 Ultra 数据。

## 当前基线与已有实测

- iDream source revision：`bd42bcd0b1772bd579b2c2229c4c3e236b5a39f9`。
- 本地 ComfyUI revision：`c645560264062e6a5b0688d25eaf3ee9906a7709`；本次读取时 git 工作树无修改。
- 8190 `/system_stats` 本日确认：ComfyUI 0.34.2、PyTorch 2.13.0、Python 3.13.12、MPS、128 GiB、`--use-pytorch-cross-attention`。
- [产品工作流](../../packages/gen/workflows/minimax-h3-redcraft-i2v.json)：v4，`REDMix-MiniMaxH3-A2Ab1-pruned-int8-convrot-ComfyMCP.safetensors`，Qwen3-VL 32B Q4 GGUF，Euler/simple，8 steps，video/audio shift 12/3，512×512，124 帧，24 fps，音视频双 VAE。
- [启动器](../../scripts/start-comfyui-idream.cjs)给 H3 默认仅启用 `tensor_to_fp8,int_mm_mps` 两个兼容补丁；LTX 专属 fused norm/RoPE 白名单不能视为 H3 已有加速。
- 已安装 AppleSilicon-FP8 revision `911294ca35093eef56f7f2695414ff8810e88e50`；SolAttn-MPS revision `45071126b0c1ee30b0e6b7103fa9d70924828ba5`。对应 Python 环境未安装 `mtlflashattn` 或 `mps-flash-attn`。Spectrum/FBC 不在本次列出的 custom_nodes 中。

必须优先采用后来证据，而非重复 8 月 20 日的候选推荐：

| 历史验证 | 结果 | 解释 |
| --- | --- | --- |
| 8/29 exact SDPA vs SolAttn-MPS | 663s vs 655s；采样 572.3s vs 567.9s | 总耗时仅降约 1.2%；RGB RMSE 10.57/255，原位近似收益不足 |
| 9/6 MLX 原 QMM vs 临时反量化 dense GEMM | 955.15s vs 873.12s | MLX 自身改善 8.59%，不能等同相对 ComfyUI 的提升 |
| 较早 ComfyUI vs 上述 MLX | 887.62s vs 873.12s | 非同期交替对照，只差 1.63%，未证明稳定更快 |

来源：[8/29 修复报告](REDCRAFT_H3_MAC_RUNTIME_REPAIR_2026-08-29.md)、[9/6 MLX 实验记录](../../.scratch/minimax-h3-mlx-dq-gemm-validation-2026-09-06.md)。9/6 原始媒体和日志已按当时用户决定清理，只保留结论记录。以上不是本日工作流 v4 的性能复测，不应混成新的平均耗时。

## 1. 少步数：最大且最直接的计算量杠杆

[LightX2V 作者规格](https://github.com/ModelTC/Minimax-H3-Turbo#1-model-specs)将 FL2VA 8-step v1.0 的建议步数列为 8/4，544p 版本 shift 为 12/3；768p 版本为 6/3。不同版本不能只按文件名 Turbo 互换。当前 RedCraft 已合并 LightX2V 的记录见[旧基线](MINIMAX_H3_APPLE_SILICON_ACCELERATION_2026-08-20.md)，但不能据此证明具体合并版本、合并强度或 4 步等质。

最低成本试验是保留当前权重、参考图、输出包络和其余参数，只测 8→6→4 步。如果合并模型在 4 步质量不足，再考虑匹配基础模型与独立新版 Turbo；后者属于模型行为变更，不能直接在已合并 Turbo 上再叠一个加速 LoRA。

计算量推断：当前 Euler 每步一次 H3 调用，8→6 减少 25% 调用，8→4 减少 50%。以 8/29 的单次历史数据仅作算术示例，固定开销 `663−572.3=90.7s`，理想 6 步约 520s、4 步约 377s；这不是预测或 SLA。检查人物一致性、肢体、快速动作、闪烁、口型与音频同步，不能只确认 MP4 可解码。

## 2. Spectrum：仍值得原位对照，但最新版本主要是兼容性与内存工作

本日 GitHub API HEAD 为 [`120d72e`](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3/commit/120d72e2f48b781235b34149e39bbdf0f1317d82)，2026-09-12，v0.2.27；比搜索缓存里显示的 0.2.26 更新。

它预测 H3 最终隐藏状态，跳过一部分 transformer 计算，保留原 checkpoint 和音视频输出路径；属于有损近似。当前 README 的普通 20 步示例是 11 次真实计算 + 9 次预测，不能直接套给我们已加速的 8 步。旧报告里的 `AFAFAFAA` 来自 v0.2.16 的静态模拟，也不能视为新版实际执行序列。

0.2.27 的 CUDA forecast-head streaming 把贡献者测试中的增量峰值约降 66.7%，但 stock 总耗时反而增加约 3%；另一个 Mixed-Grid/BSA 场景的收益来自 Blackwell。它们不构成 MPS 倍速证据。当前默认还包含 system-RAM history 和离线 replay，需要记录真实 NFE、预测数、fallback、内存与总时长。来源：[固定版本 README](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3/blob/120d72e2f48b781235b34149e39bbdf0f1317d82/README.md)、[发布说明](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3/releases/tag/v0.2.27)。

判断：可复用当前 RedCraft，优先级较高；本机 8 步收益未知。先单独测，不叠加其他缓存和稀疏 attention。

## 3. FirstBlockCache：今天新增 deep-reuse，但应先试保守模式

本日 HEAD [`f7a2712`](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache/commit/f7a27128e73e1859f2295e64698164203799029d)，2026-09-12，新增 experimental deep-reuse。标准模式每步执行首 block，按 residual 变化决定复用剩余 blocks；新模式源码保留前四、后四 blocks，复用中段。

实现无自定义 CUDA/Triton 内核，原则上能沿用当前 MPS tensors 和原权重；这是源码适用性判断，不是已完成的 MPS 兼容测试。作者公开基准仍为 RTX 5090、20 步、5 秒，标准 Fast 比同 attention 基线少约 30–33% 时间；预设明确围绕 20 步校准。当前 8 步可能命中很少，Experimental 的约 1.6×也不能直接外推。

优先试 Safe 或标准 Fast，记录 cached/full steps。它和 Spectrum/CacheDiT/EasyCache 等应作为互斥候选。来源：[固定 README](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache/blob/f7a27128e73e1859f2295e64698164203799029d/README.md)、[实现](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache/blob/f7a27128e73e1859f2295e64698164203799029d/nodes.py)。[CacheDiT](https://github.com/Jasonzzt/ComfyUI-CacheDiT/commit/1d92bbd86ec59aa6223fe2368849b7413a1acb93) HEAD 仍停留 8/4，本次没有发现足以优先替代上述两项的新证据。

## 4. 完整 Metal attention 与 fused kernels：先看 shape 和真实路由

这条路线可以保持权重、8 步和完整 attention 算法，通常仍存在浮点执行差异，不能承诺逐像素相等。

- **mps-flash-attention**：本日 HEAD [`41c7e20`](https://github.com/mpsops/mps-flash-attention/commit/41c7e20c86d1b783a4f7bb29c2db7bfe4b758c43)，9/1，0.6.3。作者声明支持 M1–M5、FP16/BF16/FP32、PyTorch 2.13。README 的 1.8×平均值是 attention microbenchmark，未给出当前 H3 M4 Max 整片对照。可先取 H3 DiT/VAE 实际 dtype、head_dim、序列长度和 mask，检查数值误差与单调用耗时，再决定是否做整片。
- **mtlflashattn 0.2.0**：[作者说明](https://github.com/pawel-mazurkiewicz/mtlflashattn)区分 M1+ 的 simdgroup_matrix v1 与 M5 TensorOps v2/v2r；3–11×宣传数字来自 M5 Max。v1 主要是 FP16 路径，M4 上 BF16 的实际选路必须确认，可能落入 chunked torch 路径而变慢。不能仅安装就假定 H3 提速。
- **AppleSilicon-FP8 1.3.2**：本机版本落后一个 release，但[上游硬件门槛](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/74734a108eb1640c24e131ee088b995ff962c47f/README.md)明确更重的 INT8/INT4 TensorOps 核心是 M5 路线；不能强开到 M4。fused RMSNorm/RoPE 可在 M4 工作，但当前 H3 DiT 已调用 `comfy_kitchen.rms_rope_split_half[_]`，旧 `apply_rope_split_half` 补丁并不自动覆盖这个融合入口；视频 VAE 则仍有独立 RMSNorm/RoPE 调用。须先查命中和耗时占比，不能把 LTX 结果转移到 H3。

两套 flash 库应单独试，不同时全局替换 SDPA。共享 Python 环境里的自动 shim 也会影响其他 runner，因此若进入实现阶段，必须做 H3 进程范围隔离。

## 5. 新后端与学生模型

详见本次[后端专项核查](MINIMAX_H3_MAC_BACKEND_ACCELERATION_2026-09-12.md)。关键判断：

- WeeTodd 9 月的 FastH3/VDN/DT 是真正的新路线，需区分专用权重、T2V/I2V能力和 M3 Ultra 数据，不能视为给现有 RedCraft 插一个节点即可提速。
- appautomaton/mlx-h3 在 9/6 本机实验采用的核心 revision 后，没有足以推翻实验结论的新 kernel 证据。
- stable-diffusion.cpp 的部分 H3 修复已合并，但 ConvRot 的 Metal 执行路径仍是关键限制；“loader 能读”不等于快。
- SolAttn-MPS 上游 HEAD 与本机已测版本一致，当前包络不应优先重复已失败的收益假设。

## 建议验证顺序与停止条件

1. 固定本日 source、runner、权重 hash、输入及包络，先补一个当前 warm 基线；单独记文本编码、采样、双 VAE、封装与总时长。
2. 对照当前权重 6 步、4 步；保留原 8 步作为质量基准，不直接改变产品默认值。
3. 若需保留 8 步，分别测 Spectrum 和 FirstBlockCache，实际无预测/缓存命中就停止调高复杂度。
4. 同时可先做完整 Metal attention 的真实 shape 小基准；只有数值与性能均通过才运行整片，不先全局安装替换。
5. 新后端仅在提供当前任务兼容性与明显收益依据后重开，不重复 9/6 已清理的同版本 MLX 实验。

收益采用同规格交替 warm A/B 判断；保持机器负载一致，记录 request/prompt ID、NFE、fallback、峰值内存/swap、视频/音频 artifact。少步数与缓存的理论倍速不能相乘，缓存机会会随着步数减少而变化。建议把“稳定减少至少约 15% 总时长且代表样例质量可接受”作为是否值得维护新路径的工程筛选线，而非模型本身的保证。

本次只新增调研文档。以上优先级是基于证据的工程判断；未做本日真实生成，未证明任何候选在当前 source revision 上已经更快。
