# MiniMax H3：Mac 后端与内核增量调研（2026-09-12）

## 结论

截至 2026-09-12，值得关注的新进展是 **WeeTodd 的原生 Metal 稀疏/混合注意力、分页与权重准备优化**。但公开 H3 性能数据主要来自 M3 Ultra，FastH3 和 Draw Things 文件直读路线又有 T2VA 限制；它们没有证明能直接加速当前 RedCraft I2V + 音频产品工作流。没有发现足以推翻本机 9 月 6 日「继续 ComfyUI」决定的同规格 M4 Max 新证据。

本轮仅查阅项目文件、GitHub API、作者仓库及模型卡；未下载权重、修改代码、启动服务或生成媒体。以下外部链接统一访问于 **2026-09-12**。仓库 HEAD 的日期仅证明有更新，不等于 H3 内核更新。

## 必须优先采用的本机证据

[9 月 6 日实验记录](../../.scratch/minimax-h3-mlx-dq-gemm-validation-2026-09-06.md) 已在 M4 Max / 128 GiB、512×512、124 帧、8 步验证 MLX：Q8 原 QMM 为 955.15 秒，临时反量化后 dense GEMM 为 873.12 秒，后者改善 MLX 自身 8.59%。较早 ComfyUI 为 887.62 秒，相差仅 1.63%，且未交替复测，不能认定稳定更快。MLX 两版音视频完成，视频 SSIM 0.997128、音频余弦 0.998433；峰值 28.04 GiB。原始材料已按用户决定清理，仅保留记录，不能重新审计原日志。

该实验使用 MLX 0.32.0、`appautomaton/mlx-h3@762b280` 加 pruned AdaLN 补丁。GitHub [compare](https://github.com/appautomaton/mlx-h3/compare/762b28040d3923ca4237dc9c8cf82d77879d2fa7...275f3fd311a4aaad40b93712e3e694b55577f364) 显示截至本轮 HEAD，后续仅 README、项目 URL、模型卡及网站链接变化，**没有推理代码更新**。因此不能把其最新提交时间 9 月 10 日当作值得重跑的新加速版本。

## 路线筛选

| 路线 | 当前 RedCraft 文件直接复用 | 当前 I2V + 音频契约 | 新证据与判断 |
| --- | --- | --- | --- |
| appautomaton/mlx-h3 | 非原文件直读；需要转换及兼容处理 | 有路径，本机做过完整实验 | 没有实验后新推理代码；暂不重测 |
| WeeTodd 普通 H3 MLX | 需兼容 MLX pack；当前 INT8 ConvRot 未获直读证明 | 原生支持首帧/首尾帧及参考音视频 | 新分页/驻留优化，值得技术跟踪；没有同规格 M4 Max 数据 |
| WeeTodd FastH3 VSA | 否，要求指定训练后的 VSA student | 当前 production profile 限 T2VA | 不能替换当前 I2V；40 层进一步提速改变生成结果 |
| WeeTodd VDN-H3 | 原 RedCraft + 内置 Turbo 未验证；需额外分支/适配器和 MLX base | 发布的已测图为 T2VA；不能外推所有 conditioning | 新 Metal kernel 有实测，但未胜出普通 H3 的同配置对照 |
| WeeTodd 直读 Draw Things H3 | 只读指定 DT 布局，不是 Comfy ConvRot | 目前 T2VA + 生成音频，不支持图像/参考/音频输入 | 新权重准备 kernel，非当前产品替换路径 |
| stable-diffusion.cpp | 通用 Comfy ConvRot 有 loader；当前精确文件未 smoke | H3 首帧、首尾帧、Ref2VA + 音频 | ConvRot 仍无 Metal 专用 kernel；不应原样迁移 |
| h3.c | BF16/F32 tree，不是当前 ConvRot/GGUF | 有多模态路径 | main 未更新；INT8 TensorOps 主要是 M5 路径 |

## WeeTodd：真正发生在 9 月的新进展

检查 [固定 HEAD](https://github.com/wee-todd/WeeTodd-Nodes/tree/84f252cf3d76c70e07983ac9bd741897309b4172) 与 [STATUS](https://github.com/wee-todd/WeeTodd-Nodes/blob/84f252cf3d76c70e07983ac9bd741897309b4172/STATUS.md)。9 月 8–11 日新增视觉 Qwen 分页、任务匹配 pack、H3 内存策略、DT 权重直读和 Metal 权重准备。不能继续沿用 8 月报告「近期无 H3 新进展」的判断。

普通 MLX H3 新增证据：作者 M3 Ultra / 256 GiB，512×512、124 帧、19 evaluations，普通工作缓冲加 paged 权重为 574.7 秒，旧低内存策略为 1065.8 秒，MP4 相同；完全驻留为 535.1 秒，阶段 MLX 峰值增至 32.32 GiB。这说明过度节省内存可能损害性能，不能说明 MLX 相比本机 MPS 的倍速。完整物理进程峰值与 MLX 分配峰值不是同一计量。

### FastH3：速度亮眼，但不是 RedCraft 原位开关

[FastH3 profile](https://github.com/wee-todd/WeeTodd-Nodes/blob/84f252cf3d76c70e07983ac9bd741897309b4172/README.md#fasth3-production-profile) 使用训练后的 VSA student、compact indexed Metal attention、4 次真实 transformer evaluation。指定模型为 `weetodd-fasth3-vsa-datafree-q8-paged`，当前 profile 在采样前拒绝非 T2VA 任务。

M3 Ultra、768×448、107 帧、24 fps，含文字编码及音视频发布的三个场景：50 层 Balanced 为 146.20–152.35 秒，40 层候选为 124.92–126.08 秒，减少 14.5–17.2%。40 层改变构图与事件时序，声音效果试听仍待接受；它禁止叠加 LoRA、cache、forecast、VDN 等。此路线需要更换模型，且丢失当前已要求的 I2V，不能作为当前 RedCraft 的升级建议。

### VDN：混合注意力的新模型结构，已出现 MLX/Metal 实现

[作者模型卡](https://huggingface.co/OpenVDN/vdn-minimax-h3) 的线性分支与 softmax 分支组合减少注意力成本；8 次评估阶段额外带 default 与 turbo adapters。宣传的 14.4 秒视频 / 11.23 秒生成来自 **8×B200**，不是 Mac。官方 Diffusers 已列 `fl2va` 图像端点路径，但其优化性能来自 CUDA/FP8 分布式栈；网页自动给出的「换成 mps」不是 Mac 验证证据。

[WeeTodd 的 VDN 接入](https://github.com/wee-todd/WeeTodd-Nodes/blob/84f252cf3d76c70e07983ac9bd741897309b4172/README.md#vdn-h3-experimental-integration) 实现分组窗口、FP32 Metal Cholesky、验证后的 scan/state gathering 与 MPP projections。M3 Ultra / 256 GB、672×384、124 帧、8 次评估：paged 287.64 秒；resident warm 249.34 秒；进一步优化 resident 231.11 秒，后者 MLX 峰值 60.75 GB，视频 SSIM 0.9818，AAC 字节相同。该改进比较的是 VDN 自身版本，作者明确没有证明胜过普通 H3。原始发布模型完整数值对齐仍未完成。

这不是只加一个插件：需额外 linear branch、两组 adapter、兼容 MLX base；pruned AdaLN base 还需原始 `h3_silu_temb_grid.safetensors`。当前 RedCraft 已有合并训练内容，不能推断与 VDN 训练基座及 Turbo 叠加有效。当前给出的完整烟测图为 T2VA；不要把上游 Diffusers 的 FL2VA 能力自动视为 WeeTodd 该组合已验证。

### Draw Things 权重直读与准备重叠

9 月 10–11 日的 [Metal 权重准备](https://github.com/wee-todd/WeeTodd-Nodes/commit/01a9812f60) 和 [下一 block 预取](https://github.com/wee-todd/WeeTodd-Nodes/commit/1ebb1b70db) 直接读取 DT row-int8/palette/F16 等文件，减少解包及布局转换开销。M3 Ultra / 256 GiB、512×512、124 帧、19 evaluations，逐步从初始 924.5 秒降至最终 546.8 秒，并保持这些 WeeTodd 版本间的 MP4 相同。最终进程 footprint 9.48 GiB，transformer MLX peak 5.91 GiB。

这不是 DT 原生应用性能，也不是 RedCraft ConvRot 支持。任务目前限 T2VA + 生成音频，I2V/Ref2VA/音频输入未支持或未资格验证；运行间 OS cache 未清空。适合观察权重准备技术，不适合立即迁移产品。

## stable-diffusion.cpp：功能更新了，ConvRot Metal 判断未改变

截至 [7f410a3](https://github.com/leejet/stable-diffusion.cpp/commit/7f410a3793c5bba8eb198e962ce7a3d6095f9d89)（9 月 11 日），[INT8 ConvRot 文档](https://github.com/leejet/stable-diffusion.cpp/blob/7f410a3793c5bba8eb198e962ce7a3d6095f9d89/docs/int8_convrot.md) 仍说明：CPU 有通用实现，CUDA 有加速实现，其他 GPU backend 由调度器回退 CPU。因此格式能加载不等于 Metal 算得快。

[H3 文档](https://github.com/leejet/stable-diffusion.cpp/blob/7f410a3793c5bba8eb198e962ce7a3d6095f9d89/docs/minimax_h3.md) 有 T2VA、首帧、首尾帧和 Ref2VA；[PR #1886](https://github.com/leejet/stable-diffusion.cpp/pull/1886) 已在 **8 月 30 日合并**，纠正旧报告的 open 状态。该 PR 的 M4 Max smoke 不提供可比较的完整 wall time。

若未来独立评估，应测试 Metal 原生量化 GGUF 路径，先核查是否能保留 RedCraft 的训练内容、采样参数与音频质量。直接换作者官方 Q4 base 会改变模型；从当前量化模型转换也无法恢复已经丢失的量化信息。本轮未完成这些验证，不作性能承诺。

## h3.c / mlx-serve / 其它 MLX 包装

- [h3.c](https://github.com/antirez/h3.c/tree/8974cc055ea9c02fcd14cc27dfda3e1027c05153) main 仍停留 8 月 11 日；[Turbo PR #14](https://github.com/antirez/h3.c/pull/14) 仍 open，最后更新 8 月 20 日。其 M5 native INT8/TensorOps 不可外推 M4；M4 使用 BF16 MPSGraph。没有本轮新增的同规格胜出证据。
- [mlx-serve](https://github.com/ddalcu/mlx-serve/tree/fa76a4b50b3f54af7e9cd927279f5ba2870f02c6) HEAD 为 9 月 10 日，但近期提交不能当作 H3 性能更新。[既有 M4 数据](https://github.com/ddalcu/mlx-serve/blob/main/todo_minimax_h3.md) 的 2.83×是 30-step 缓存配方；[Turbo 发布说明](https://github.com/ddalcu/mlx-serve/discussions/134) 是另一条采样轨迹。不能把 30-step 缓存倍数与 4-step 减步相乘，也没有证据胜过本机现有 8-step RedCraft。
- [MacOS-H3-Speedrun](https://github.com/EvolvingLMMs-Lab/MacOS-H3-Speedrun/blob/9326b3e019174b067880572385b5256b910b2dca/README_EN.md) 最新 8 月 21 日，整合 Turbo、SolAttn 与分层量化/streaming；公开数据来自 M3 Ultra / 512 GB 测试主机，所谓 24/32/48 GB 是配置档，不等于在相应硬件实测。MLX 图仍需转换模型和 adapter。
- [Argus ComfyUI MLX](https://github.com/Argus-AiTeam/ComfyUI-MiniMax-H3-MLX/tree/ab1756d571ebb14fed3168354dae42966a04348b) 最新 8 月 12 日，T2V + 立体声音频包装。公开 24 GB M4 Pro、768×448、5 秒、8 NFE 约 23 分钟；不是 M4 Max 或当前 RedCraft 提速证据。

## 对本项目的建议

补查 [maderix/h3.c-ane](https://github.com/maderix/h3.c-ane)（访问 2026-09-12）：这个独立 fork **确实添加了 ComfyUI INT8 ConvRot loader 和 ANE 执行**，不能套用上游 h3.c 仅 BF16 的限制。作者在基础款 M4 / 24 GB 的演示为 4 秒、6 步、约 8.5 分钟，但实际 render canvas 是 **384×384**，不是原生 512×512；原生 512 仍列为后续工作。文本 conditioning 预先在其他 GPU 机器产生，计时不含完整在线文本编码。相同设置单步 ANE 26.3 秒、Metal 31.9 秒，约减 17%，没有 M4 Max 对照。

该 fork 通过私有 AppleNeuralEngine framework 编译固定形状 MIL 图，每个形状约 19 GB 编译缓存，系统 ANE daemon 另存副本。当前官方 ConvRot 路径不能证明当前 RedCraft 变体在 FP16 range guard 下兼容；I2V 的 ANE 完整链路也未见作者实测。它是值得记录的原文件复用技术方向，但作者明确定位 proof of concept，不能作为当前 128 GiB M4 Max 的优先提速方案。

继续保留现有 ComfyUI/RedCraft 产品实现。新后端中最值得跟踪的是 WeeTodd 普通 H3 的内存/计算平衡，以及 VDN 混合注意力的 M4/I2V 资格验证；FastH3 与 DT 直读当前有明确任务缺口。不要重复已经做过、没有新代码变化的 mlx-h3 dense-GEMM 实验。

有资格进入下一轮实跑的前提应是：保留 RedCraft 所需行为或明确接受换模型，支持 I2V 和完整音频，提供实际 M4 可用 kernel，并在相同 512×512、124 帧、相同真实 evaluation 数下记录完整 wall time、生成质量与峰值内存。新实验应与 ComfyUI 交替跑，不能用 M3 Ultra/M5 或历史非交替数字宣布升级成功。
