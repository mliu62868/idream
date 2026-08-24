# MiniMax H3 在 Apple Silicon 上的社区加速方案（2026-08-20）

## 结论

截至 2026-08-20，**没有找到一个已经在 M4 Max 上实测、能直接替代当前 RedCraft + ComfyUI/MPS，并确定更快的社区方案**。今天出现的 Civitai 工作流也不是新的 Mac 内核：它只是把 Spectrum、FirstBlockCache 和 CUDA 专用组件组合起来；Spectrum 与 FirstBlockCache 仍须二选一，CUDA 组件在 Apple Silicon 上不起作用。

当前最值得做的是保留现有 RedCraft INT8 ConvRot、Q4 文本编码器和 VAE，在原 ComfyUI 图上进行两个互斥的缓存 A/B：

1. **先测 Spectrum**。本机按当前 Euler/simple、8 steps 和 Spectrum v0.2.16 配置直接模拟出的执行序列为 `AFAFAFAA`，即 5 次真实 transformer 计算、3 次预测；理论上跳过 37.5% transformer。用现有 706 秒采样耗时粗算，理想总耗时约 9–10 分钟，但这只是上限估算，不是实跑结果。
2. **再测 FirstBlockCache**，不要与 Spectrum 叠加。它能原位复用当前 checkpoint，公开的 20-step CUDA 测试约省 30% denoise 时间，但没有 M4/MPS 数据，8-step 的命中数也未知。
3. 若要试另一个执行后端，优先用 **stable-diffusion.cpp + Q4 DiT GGUF**；可以复用现有 Q4 文本编码器与 VAE。不要把当前 RedCraft ConvRot DiT 当作 Metal 加速路径：文件虽能加载，但 Metal 没有专用 ConvRot kernel，会回退 CPU。
4. 暂不下载 h3.c BF16 或 60+ GiB 的 MLX 权重。h3.c 的公开 M4 数据不快，MLX/WeeTodd 的亮眼 H3 数据来自 M3 Ultra 或 M5，且不能复用现有 RedCraft 权重。

## 范围和证据口径

- 只采用项目作者的 GitHub/Hugging Face、源码、README、commit、PR/issue，以及工作流作者自己的发布页。
- “支持 Apple Silicon”“可加载 checkpoint”和“在 M4 Max 上更快”是三件不同的事；没有相同硬件、分辨率、帧数和步数的 wall time，不作倍速承诺。
- VPIPE 不在本次候选范围。
- “I2V”以下包括首帧、首尾帧或 reference conditioning；各项目的具体能力单独标注。

## 当前可比基线

本机已经验证的基线是：

- M4 Max，ComfyUI/MPS；
- RedCraft MiniMax H3 A2A-RED，INT8 ConvRot，合并 LightX2V Turbo/NSFW LoRA，8 steps；
- I2V，512×512，124 帧 / 5.167 秒；
- 端到端 792.917 秒（13 分 13 秒），其中采样约 706 秒；
- 输出 H.264 + AAC 已验证。

因此下面所有公开数字只有在硬件、分辨率、帧数、steps、模型量化和是否包含编码/解码均相同的情况下才可直接比较。当前没有候选提供这样的同规格 M4 Max 数据。

## 候选总览

| 方案 | I2V / 音频 | 复用现有 RedCraft | M4 H3 实测 | 最近活动 | 判断 |
| --- | --- | --- | --- | --- | --- |
| ComfyUI Spectrum | 沿用原 H3 I/O；未单测音频质量 | **是** | 无；仅本机执行序列模拟 | 2026-08-19 | **第一优先 A/B**；8-step 可理论跳 3/8 transformer |
| ComfyUI FirstBlockCache | 沿用原 H3 I/O；未单测音频质量 | **是** | 无 | 2026-08-07 | **第二优先 A/B**；与 Spectrum 二选一 |
| stable-diffusion.cpp | T2VA、首帧、首尾帧、Ref2VA；32 kHz 立体声 | TE/VAE 可复用；通用 ConvRot 格式可读，当前 RedCraft 尚未 smoke；Metal 会回退 CPU | 无 wall time | 2026-08-19 release | 后端试验用 Q4 DiT；不直接跑现有 ConvRot DiT |
| h3.c | T2VA、首尾帧、图片/视频/音频 refs；H.264/AAC | **否**；只读 BF16/F32 safetensors tree | 有，但公开 5 秒样例约 27–28 分钟 | main 2026-08-11；PR #14 仍 open | 当前不值得迁移 |
| mlx-serve | T2VA、FL2VA、Ref2VA、立体声音频、LoRA/Turbo | **否**；需 MLX pack | 有，但非同规格，30-step 480p 约 9 分钟 | 2026-08-20 repo 更新 | 功能完整，缺同规格证明 |
| WeeTodd ComfyUI MLX | T2V/I2V/FL2V/Ref2VA + 音频、Turbo/LoRA | **否**；另需约 64+ GiB 权重 | 无；H3 数据来自 M3 Ultra | repo 2026-08-16；H3 2026-08-12 | 快速但不适合当前磁盘/M4证据条件 |
| mlx-h3 | T2VA、FL2VA、Ref2VA、32 kHz 立体声 | **否**；需约 68+ GiB MLX pack | 无；W8A8 数据为 M5 | 2026-08-17 | 预览级，不迁移 |
| CacheDiT / T8 BlockCache | 沿用原 H3 I/O | **是** | 无 | 2026-08-04 / 2026-08-20 | 可作后续备选，证据弱于前两项 |

## 今天的新工作流：不是新的 M4 加速内核

[Civitai 模型 2875853，版本 3249819](https://civitai.com/models/2875853?modelVersionId=3249819) 发布于 2026-08-20 21:37Z。作者组合了：

- Spectrum；
- FirstBlockCache；
- Sol/KJ 等 CUDA 路径。

作者明确 Spectrum 与 FirstBlockCache 只能二选一。对当前 M4 Max 来说，真正可能生效的仍只有前两个跨设备缓存；CUDA 组件没有 Metal 路径。因此这条更新的价值是工作流打包和配置参考，不是“今天出现了新的 Mac 加速器”。

本机当前 ComfyUI commit `cc0fc21` 晚于 Spectrum 的最低兼容 commit `e377e263`，版本门槛满足。对当前 Euler/simple、8 steps 运行 Spectrum v0.2.16 的调度模拟得到：

```text
A F A F A F A A
```

即 5 actual + 3 forecast。若把 706 秒采样时间按 transformer 跳过比例线性估算，理想可省约 265 秒；加上 forecast 自身开销和不被缓存覆盖的 VAE/音频/封装，端到端合理试验目标是 **9–10 分钟**，而不是未经实跑就宣称 8 分 49 秒。

## 1. ComfyUI 原位缓存

### Spectrum：当前第一优先

[xmarre/ComfyUI-Spectrum-MiniMax-H3](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3) 是纯 PyTorch/ComfyUI 的 H3 频谱预测缓存，不要求 CUDA/Triton，也不换 checkpoint。它在 denoise 轨迹中用 forecast 替代部分真实 transformer 计算。

已知证据：

- 项目最近 commit [`88af9b3`](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3/commit/88af9b36370a0b46b8002ad5b072f9748ebac826) 为 2026-08-19，仍在维护。
- 作者公开的 20-step、864×480、107 帧、AMD Radeon AI PRO R9700/ROCm 测试为 212.73 → 160.97 秒，约 -24.33%；这不是 M4 数据。
- 当前 8-step 配置的本机调度模拟能形成 `AFAFAFAA`，比保守的长 warmup preset 更有试验价值。

限制：

- forecast 是近似计算；保留 H3 的视频/音频输出结构不等于已证明音频和嘴型完全无漂移。
- 37.5% 是 transformer 调用跳过比例，不是端到端加速比例。
- 不应与 FirstBlockCache 同时开启，否则无法归因，也可能重复干预同一轨迹。

### FirstBlockCache：第二个互斥 A/B

[duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache) 根据首 block residual 的变化决定是否复用后续 block。项目没有 CUDA/Triton 依赖，缓存 tensor 留在当前 device，代码层面没有排除 MPS。

作者公开的 RTX 5090、960×544、124 帧、20-step T2V warm run：

- native attention：90.64 → 60.82 秒（-32.9%）；
- SageAttention：57.96 → 40.26 秒（-30.5%）。

但仓库只有一个 [2026-08-07 初始 commit](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache/commit/725973c3bfd9de6dce249bc93dc5fe27f820df31)，作者只验证 RTX 5090/Windows。Fast preset 对 no-cache 结果的 SSIM 为 0.6873，说明它不是无损缓存。当前 8-step RedCraft 能命中多少次必须实跑。

### CacheDiT、T8 和其它缓存

- [Jasonzzt/ComfyUI-CacheDiT](https://github.com/Jasonzzt/ComfyUI-CacheDiT) 在 [2026-08-04 commit](https://github.com/Jasonzzt/ComfyUI-CacheDiT/commit/1d92bbd86ec59aa6223fe2368849b7413a1acb93) 加入 H3。作者称官方 T2V/I2V/R2V、20 steps 可达 1.41–1.50×，并保留立体声音频，但未公开硬件、原始耗时或质量指标；低步数会受 warmup 限制。
- [T8mars/comfyui-minimax-h3-blockcache-T8](https://github.com/T8mars/comfyui-minimax-h3-blockcache-T8) 是 joint audio/video F1B0 缓存。2026-08-20 的 [`28eda98`](https://github.com/T8mars/comfyui-minimax-h3-blockcache-T8/commit/28eda9860e19adabb2312ba254bd468bee32688e) 只增加 Comfy Registry 发布；核心缓存是 8 月 4 日、音频修复是 8 月 7 日。公开 RTX 4060 极小规格只有约 1.09–1.20×，124 帧质量/性能矩阵仍是 TODO。
- [linjian-ufo/comfyui-speed-minimaxH3](https://github.com/linjian-ufo/comfyui-speed-minimaxH3) 支持 I2V/Ref2V/audio 和 TE cache，但 [源码](https://github.com/linjian-ufo/comfyui-speed-minimaxH3/blob/main/nodes.py) 仅在 CUDA 使用 SageAttention，非 CUDA 会选 CPU cache；在 MPS 上可能产生 CPU↔GPU tensor 搬运。无 M4 benchmark，最近 commit 为 [2026-08-09](https://github.com/linjian-ufo/comfyui-speed-minimaxH3/commit/2f507d687cd6767212ae003d272042bf886a3cd3)，不作为首选。
- [HM-RunningHub/ComfyUI_RH_MinMaxH3](https://github.com/HM-RunningHub/ComfyUI_RH_MinMaxH3) 的 3.20×/1.99×来自 4×H200、50 steps；单 GPU 示例也不是 M4。最近 commit 为 [2026-08-06](https://github.com/HM-RunningHub/ComfyUI_RH_MinMaxH3/commit/d6c5f7b0d4e03936ac4a9834be63ecc6b5637dad)，不适用于当前 8-step/MPS 归因。

## 2. stable-diffusion.cpp

[MiniMax H3 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/minimax_h3.md) 显示 H3 支持在 [2026-08-04 commit `ea7f0c8`](https://github.com/leejet/stable-diffusion.cpp/commit/ea7f0c8) 合入，覆盖：

- T2VA；
- 首帧 I2VA；
- 首尾帧 FL2VA；
- 图片/视频/音频 Ref2VA；
- audio VAE 输出 32 kHz 立体声。

权重边界：

- DiT 和 text encoder 可用 safetensors 或 GGUF；VAE/audio VAE 使用 safetensors。
- 当前 Q4 text encoder 和两个 VAE 有复用路径；另下载作者提供的 [MiniMax-H3-GGUF](https://huggingface.co/leejet/MiniMax-H3-GGUF) Q4 DiT 即可形成低磁盘成本试验。
- [`safetensors_io.cpp`](https://github.com/leejet/stable-diffusion.cpp/blob/97d2990807fe6d558e395f8764198d7c7e7b411c/src/model_io/safetensors_io.cpp#L109-L135) 会读取每个模块的 `.comfy_quant` JSON；[后续 loader 分支](https://github.com/leejet/stable-diffusion.cpp/blob/97d2990807fe6d558e395f8764198d7c7e7b411c/src/model_io/safetensors_io.cpp#L286-L324) 识别 `format == "int8_tensorwise"`、校验 I8 dtype 和 `convrot_groupsize`，再设置 ConvRot storage 元数据。官方文档也明确 ComfyUI INT8 ConvRot safetensors 可不转换地传给 `--diffusion-model`。
- 最新源码还在 [`merge_safetensors.py`](https://github.com/leejet/stable-diffusion.cpp/blob/97d2990807fe6d558e395f8764198d7c7e7b411c/scripts/merge_safetensors.py#L33-L38) 直接列出 `.minimax_h3_fl2va_pruned_int8_convrot.safetensors`，说明 MiniMax H3 ConvRot 文件确实是开发对象。

然而 [`int8_convrot.md`](https://github.com/leejet/stable-diffusion.cpp/blob/97d2990807fe6d558e395f8764198d7c7e7b411c/docs/int8_convrot.md#backend-support) 明确只有 CUDA 有专用 ConvRot kernel；其它 GPU backend 会由 scheduler 回退 CPU，预期显著慢于 CUDA。Metal 属于该类。因此：

- 官方 loader 和文档已经推翻“Comfy-specific ConvRot 一定不能读”的笼统判断；
- 但本轮没有用 `sd-cli` 对**当前这一个 RedCraft 文件**完成 load-only/smoke test，所以只能确认它若符合上述通用元数据约束就有加载路径，不能把当前 checkpoint 的全部 tensor 命名/shape 兼容写成已实测；
- **计算上却不是 M4 的快路径**。

项目也有通用 [Spectrum/EasyCache/DBCache/Cache-DiT](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/caching.md)，但没有 H3+M4 实测。开放 PR [#1886](https://github.com/leejet/stable-diffusion.cpp/pull/1886) 只在 M4 Max 验证 reference-audio encoder 与 4-step smoke，没有 wall time，且尚未合入。最近自动 release 是 [2026-08-19 `master-827-97d2990`](https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-827-97d2990)。

结论：若测试 sd.cpp，应使用 Q4 DiT GGUF；即使当前 RedCraft 通过 load-only smoke，把 ConvRot DiT 直接塞给 Metal 也不会带来预期加速。

## 3. h3.c

[antirez/h3.c](https://github.com/antirez/h3.c) 是 Apple 原生实现，README 覆盖 T2VA、首尾帧、图片/视频/音频 Ref2VA，最终输出 H.264 + 32 kHz 立体声 AAC。

但它和当前资产不兼容：

- [`h3_weights.c`](https://github.com/antirez/h3.c/blob/main/h3_weights.c) 只扫描 safetensors shards，并按 BF16/F32 checkpoint tree 加载；没有 GGUF loader。
- 当前 RedCraft INT8 ConvRot、Q4 GGUF 不能直接复用。
- [实现说明](https://github.com/antirez/h3.c/blob/main/README.md#implementation-and-performance-notes) 明确 native INT8 MLP/QKV/attention-output TensorOps 是 M5 路径；不具备这些 TensorOps 的 M4 自动走 BF16 MPSGraph。

官方 issue 内的 M4 Max 64 GB 用户实测：

- 512×512、22 帧、20 steps、reuse2：81.7 秒；
- 960×544、121 帧、16 steps、reuse2：1606–1680 秒，即 26.8–28.0 分钟；
- 243 帧优化配置：2113.9 秒。

来源：[issue #5 评论](https://github.com/antirez/h3.c/issues/5#issuecomment-5256459202)。另一个 M4 Max 128 GB 测试在 512×512、243 帧、20 steps、45 layers 下为一图+音频 cold 32 分钟、四图+音频 warm 21 分钟，见[后续评论](https://github.com/antirez/h3.c/issues/5#issuecomment-5308786815)。

当前本机 5.167 秒视频是 13 分 13 秒，但只有 512×512、8 steps；h3.c 的约 5 秒公开数据是 960×544、16 steps，所以不能做严格倍速比较。它至少没有给出迁移后会更快的证据。

2026-08-20 有活动的是尚未合入的 [PR #14](https://github.com/antirez/h3.c/pull/14)：离线把 Turbo LoRA fold 进 BF16 shards，在 M5 上把 960×544、124 帧从 8.8 分钟降至 6.2 分钟，约 1.35×，使用 5–6 steps；没有 M4 数据，也不是 runtime LoRA/GGUF/INT8 支持。main HEAD `8974cc0` 最后提交 2026-08-11，项目没有 release。

## 4. MLX 原生路线

### mlx-serve

[ddalcu/mlx-serve](https://github.com/ddalcu/mlx-serve) 的 [App 文档](https://github.com/ddalcu/mlx-serve/blob/main/docs/app.md) 和 [H3 reference](https://github.com/ddalcu/mlx-serve/blob/main/docs/reference.md) 覆盖 T2VA、FL2VA、Ref2VA、立体声音频、stacked LoRA 和 Turbo。

它有真正的 M4 Max 128 GB 数据，但不是当前同规格：

- 864×480、73 帧、30 steps：约 9 分钟；
- 1344×768、124 帧、30 steps：约 49 分钟；
- fast recipe 在 1344×768、124 帧、30 steps 上相对 2 小时 19 分约 2.83×。

这些原始表在历史 commit 的 [`todo_minimax_h3.md`](https://github.com/ddalcu/mlx-serve/blob/19403ef431153f8b75eaac5e10b5547c6aa27bb6/todo_minimax_h3.md)。当前 [gotchas](https://github.com/ddalcu/mlx-serve/blob/main/docs/gotchas/models-media.md) 又说明 fast recipe 的 broadcast schedule 在 ≤6 steps 无效，Turbo 还会关闭 fast recipe，因此不能把 4-step Turbo 与 2.83×相乘。

它需要单独转换的 4-bit/8-bit MLX pack，当前 RedCraft GGUF/ConvRot 不能复用。文档给出的 H3 pack 约为 26/40 GB 或 44/69 GB（RAM/download 组合，视量化而定）。repo 在 2026-08-20 仍有 commit，但当天改动主要是广泛的 pre-release/ANE/chat 工作，没有新的 H3 M4 wall time。

### WeeTodd ComfyUI MLX

[wee-todd/WeeTodd-Nodes](https://github.com/wee-todd/WeeTodd-Nodes) 配合 [MiniMax-H3-MLX-q8-extended-paged](https://huggingface.co/Vayden/MiniMax-H3-MLX-q8-extended-paged) 和作者的 [H3 MLX collection](https://huggingface.co/collections/Vayden/weetodd-minimax-h3-mlx-for-comfyui)，支持 T2V/I2V/FL2V/Ref2VA + 音频，并支持 Turbo/LoRA。

这是目前公开数字最亮眼的 ComfyUI/MLX 路线：M3 Ultra、384p、4-step q8-paged sampling 为 113.35 秒，MPP 后 108.49 秒，峰值约 7.23 GB；但它**不是 M4 Max**。仓库 CSV 中 640×384、124 帧、4 次 transformer eval 的 dense sampling 约 91.72–98.64 秒，trajectory/block cache 可到约 65.67–75 秒，但部分近似结果的视频 SSIM 只有约 0.54–0.61，音频相关性也低，不能当成无损倍速。

磁盘也不满足当前条件：q8 paged transformer 约 33.38 GB，TE 约 27.46 GB，VAE 约 2.94 GB，合计已约 63.78 GB，尚未计所有附加资产；当前约 57 GiB 可用空间装不下。现有 RedCraft checkpoint 也不能复用。repo HEAD [2026-08-16](https://github.com/wee-todd/WeeTodd-Nodes/commit/e91dc8735f52159af37c339a8c847cd5be5c0e62)，H3 pipeline 最近实质修改为 8 月 12 日，今天没有新 H3 加速。

### mlx-h3

[appautomaton/mlx-h3](https://github.com/appautomaton/mlx-h3) 是 pre-alpha 的纯 MLX port；[README](https://github.com/appautomaton/mlx-h3/blob/main/README.md) 覆盖 T2VA、FL2VA、Ref2VA、32 kHz 立体声和 community Turbo 4–8 steps。

[权重文档](https://github.com/appautomaton/mlx-h3/blob/main/docs/weights.md) 显示另需约 34.8 GiB DiT、27.7 GiB TE、约 5.8 GiB VAEs，且明确 Comfy `int8_convrot` 不能直接用于 MLX。作者的 W8A8/NAX 数据为 M5：864×480、56 帧、20 steps 从 W8A16 9.3 分钟降至 7.3 分钟；M4 没有 native W8A8 和完整 H3 benchmark。最近 commit [2026-08-17](https://github.com/appautomaton/mlx-h3/commit/762b28040d3923ca4237dc9c8cf82d77879d2fa7) 主要是命名说明，不构成今天的加速方案。

## 推荐的最小实跑顺序

保持同一 NSFW 输入图、prompt、seed、512×512、124 帧、8 steps、Euler/simple，不改模型或其它节点：

1. 复跑 no-cache 基线，记录 sampler wall、端到端 wall、峰值内存和输出哈希。
2. 只开 Spectrum，保存实际 `A/F` 序列、forecast 次数、sampler wall 和端到端 wall。
3. 关闭 Spectrum，只开 FirstBlockCache Safe；记录 cache hit/miss、threshold 和 wall time。
4. 若 Safe 有收益，再试 Fast；否则停止，不继续叠加缓存。
5. 对每个结果用 ffprobe 检查 124 帧、时长、H.264/AAC，再抽首/中/尾帧及音频同步作人工比较。

停止条件：

- 0 次有效命中/forecast；
- sampler 提升小于 10%；
- 端到端没有提升；
- 出现明显身份、运动、音频或同步漂移。

只有在上述两个零下载试验都失败后，再考虑 stable-diffusion.cpp + Q4 DiT GGUF。h3.c 和 MLX 路线要等到出现相同规格 M4 Max 数据、或释放足够磁盘后再测。

## 最终判断

“今天社区有没有更快方案”的准确回答是：

- **有新的工作流打包和持续维护，没有新的 M4 Max 胜出实测。**
- 当前最有希望把 13 分 13 秒压到约 9–10 分钟的是 Spectrum，但这是根据 8-step `AFAFAFAA` 调度做的理论区间，必须实跑确认。
- FirstBlockCache 是同一现有栈上的第二候选，不能和 Spectrum 同时开。
- stable-diffusion.cpp 值得关注，但 M4 上应改用 Q4 DiT GGUF；其 loader 已明确支持通用 ComfyUI ConvRot 格式，当前 RedCraft 精确文件仍未 smoke，且 ConvRot 无论如何都不是 Metal 快路径。
- h3.c、mlx-serve、WeeTodd 和 mlx-h3 都尚未提供足以取代当前方案的同规格 M4 证据。
