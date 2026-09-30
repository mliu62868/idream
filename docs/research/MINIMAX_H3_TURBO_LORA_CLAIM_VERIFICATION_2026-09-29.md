# MiniMax-H3：Mac 加速与运行时 LoRA 说法核验

核查日期：2026-09-29，用户时区 America/New_York；来源提交时间在下表使用 UTC。本文包含原始 GitHub/Hugging Face 文档及源码核验、真实 Turbo adapter 的数值加载实验，以及复用本机 RedCraft NSFW 融合模型的原生 Metal 短片实验。没有下载官方完整大模型；只下载一个 1.29 GiB adapter 和 tokenizer/VAE 配置小文件。所有实验代码、权重链接和视频位于忽略目录 `.scratch/h3-lora-20260929/`，未修改产品代码或启停服务。

## 结论

**少步数蒸馏与原生 Metal 优化都是真实技术，但引文把不同仓库、采样耗时、完整生成耗时和不同 LoRA 版本混在了一起。** 本机需要的 NSFW 模型已存在：19.53 GiB 的 RedCraft INT8 ConvRot checkpoint，已融合 NSFW 和 8-step Turbo。它可以直接供支持该格式的原生 Metal fork 使用，无需官方 BF16 大模型。另一个 neysay fork 的真实 Turbo LoRA 数值加载已通过抽样独立校验，但该 fork 不能直接加载此 checkpoint 的 200 个 INT8 projection；不能将两个实验拼成「新四步 LoRA 已完整挂到 NSFW INT8 模型」的结论。[原始性能说明][antirez-readme] · [运行时加载接口][neysay-lora-h] · [ConvRot fork][maderix-readme]

最影响实验的三个区别：

- 引文的 16.7 s / 3.5 s 都是 M5 Max、512×512、22 帧（约 0.917 s）的 **denoise 阶段**；3.5 s 来自上游不挂 Turbo 的直接四步测试。它们不是通常 4–15 秒视频的完整生成时间。[上游教程][antirez-readme]
- antirez 上游当前公开 CLI/API 没有运行时 LoRA；neysay fork 有。不能因 fork 支持，就说 upstream 已合入。[上游 CLI][antirez-main] · [上游 API][antirez-h] · [fork API][neysay-lora-h]
- 主任务本轮从现有 RedCraft checkpoint 的 `__metadata__.prompt` 确认，它已融合 lightx2v 8-step Turbo、NaughtyTimes 和 reference LoRA，随后做 INT8 ConvRot 量化。再叠一个 Turbo 不能构成干净的「普通基础模型 → 少步数蒸馏模型」对照；现有业务基线也已经是少步数路线。此前工作流与研究背景见[9 月 12 日记录](REDCRAFT_H3_MAC_ACCELERATION_UPDATE_2026-09-12.md)。

## 固定的来源版本

| 来源 | 本轮 HEAD / revision | 提交或更新时间（UTC） |
| --- | --- | --- |
| antirez/h3.c | [`8974cc055ea9c02fcd14cc27dfda3e1027c05153`](https://github.com/antirez/h3.c/commit/8974cc055ea9c02fcd14cc27dfda3e1027c05153) | 2026-08-11 13:50:25 |
| neysay/h3.c | [`debd9a1e55815132200ee722c1e27ed22b006f6d`](https://github.com/neysay/h3.c/commit/debd9a1e55815132200ee722c1e27ed22b006f6d) | 2026-09-26 06:43:51 |
| maderix/h3.c-ane（本轮使用其 Metal 路径） | [`6538b226efe5c4fff905d299dcc4426db2f44de4`](https://github.com/maderix/h3.c-ane/commit/6538b226efe5c4fff905d299dcc4426db2f44de4) + 本地解析补丁 | 2026-08-12 17:20:14；本地补丁保存于证据目录 |
| lightx2v/Minimax-h3-Turbo | [`3ec17a324ced54151364f24f8b5fb6bf7e26414f`](https://huggingface.co/lightx2v/Minimax-h3-Turbo/tree/3ec17a324ced54151364f24f8b5fb6bf7e26414f) | 2026-09-10 13:22:26 |
| ModelTC/Minimax-H3-Turbo | [`02e26d591f7a04d5d1a074c9566d5dd4f22f6225`](https://github.com/ModelTC/Minimax-H3-Turbo/commit/02e26d591f7a04d5d1a074c9566d5dd4f22f6225) | 2026-08-27 11:04:13 |
| ModelTC/LightX2V | [`8a97c7591d7252ef491392e83e1eb18617ac9368`](https://github.com/ModelTC/LightX2V/commit/8a97c7591d7252ef491392e83e1eb18617ac9368) | 2026-09-29 17:58:09 |
| JunzoKamahara/h3c-app | [`767b6aaa4a6157f35410956f99ffae864da31cc2`](https://github.com/JunzoKamahara/h3c-app/commit/767b6aaa4a6157f35410956f99ffae864da31cc2) | 2026-09-28 03:02:43 |
| syydaniel/minimax-h3-studio | [`af2ebcb255246ce9d5424f7c54202d569b9f5c07`](https://github.com/syydaniel/minimax-h3-studio/commit/af2ebcb255246ce9d5424f7c54202d569b9f5c07) | 2026-09-12 17:58:29 |
| PipeNetwork/minimax-h3-mlx | [`b2f7e4d2b7861cefe68b75e4b59ab81cc4e7c318`](https://github.com/PipeNetwork/minimax-h3-mlx/commit/b2f7e4d2b7861cefe68b75e4b59ab81cc4e7c318) | 2026-08-10 17:59:48 |
| MiniMax 官方整合目录 | [`7e7d6a53b308268c7bd1fb8d8126bfb172a37cd9`](https://github.com/MiniMax-AI/awesome-minimax-h3-integration/commit/7e7d6a53b308268c7bd1fb8d8126bfb172a37cd9) | 2026-09-17 18:30:14 |

整合目录确实收录 h3.c，并把 stars 写作 1652；本轮 GitHub 仓库 API 为 2797。目录里的关注度是静态快照，不是速度或正确性证明。[目录原文][integration-readme] · [仓库 API](https://api.github.com/repos/antirez/h3.c)

## 从第一性原理拆开「加速」

总耗时可分解为 `加载/文本与参考编码 + NFE × 单次 DiT 成本 + 双 VAE 解码 + 封装`。这是成本模型，不是本机预测。

1. **Turbo LoRA 减少 NFE。** 同样每步一次完整 DiT 调用，从 20 步到 4 步只将采样部分的调用数降到五分之一；加载、参考编码和解码并不随之降到五分之一。蒸馏使少步采样可用，不能证明与高步数相同的质量。[官方模型规格][turbo-spec] · [官方 NFE 处理][turbo-inference]
2. **原生 kernels 降低单次调用成本。** 是否快取决于实际硬件、shape、dtype 和运行路径。M5 的 Metal 4 TensorOps 数据不能直接作为 M4 的收益。跳 block、复用速度场、token reduction 和降低内部画布又是独立近似，各自会影响质量。[上游实现说明][antirez-readme]
3. **量化首先减少权重存储及带宽。** 若剩余主要成本是 attention，压缩线性层并不按 bit 数同比减少总时间。PipeNetwork 作者估计其 4-bit 在典型长度约 1.2–1.4×，且展示 3-bit 质量崩溃；这不是「4-bit 必然四倍快」。[MLX 作者分析][mlx-readme]

少步数、cache 和稀疏近似的倍速不能直接相乘：步数减少后，原有缓存机会也会变化。收益应以同规格视频、相同输入及近似相同机器负载下的总耗时与质量对照来判定。

## 引文中的性能口径

| 说法 | 原始资料实际支持的范围 |
| --- | --- |
| fast 约 16.7 s | 512×512、22 帧；20 个采样转换，`layers 45 + reuse 2`，只有 11 次新的 denoiser 计算。16.69 s 是 denoise profile。 |
| 四步约 3.5 s | 同样是 512×512、22 帧 denoise；完整 50 blocks、reuse 1。狐狸/冲浪样例对 29-pass 参考的 full-video SSIM 分别约 0.556 / 0.547，不能描述为等质。 |
| 完整生成也只要几秒 | 没有该证明。上游另有含 image+audio / embedded-video+audio references 的完整运行记录 74.58 / 76.99 s，但输入链路不同，不能与上面直接算倍速。 |
| 权重约 33 GB、峰值约 40 GB | 该 README 对有效常驻 DiT 描述约 37 GiB、tracked storage 约 36.5 GiB；40.1 GB 是具体 M5 Max 参考输入运行的 physical footprint。它不是所有模式、分辨率和时长的统一上限。 |

上述数据均来自[固定上游 README][antirez-readme]，没有本轮独立复现。短片 benchmark 的长度和仅计采样的口径，是引文最重要的遗漏。

## neysay 的 LoRA 加载确实存在，但不是任意文件保证

`H3_MAX_LORAS=8`，可在 transformer 加载时叠加，文件本身不变；未知 target 会失败。源码支持 native/ComfyUI 的低秩 pairs、diffusers/PEFT 的 split Q/K/V 与 FC1 映射，以及 `.diff`/`.diff_b` 全权重增量。QKV 要重排到 checkpoint 的逐 head 交错布局，diffusers FC1 要交换 value/gate 半区。[接口与约束][neysay-lora-h] · [解析和重排实现][neysay-lora-c]

需要纠正「kohya 都支持，所以 Civitai 大多能直接用」：源码第 388–393 行**明确拒绝扁平 `lora_unet_...` keys**，要求转换成 native/diffusers keys。它支持 kohya 风格的 `lora_down/lora_up + alpha`，不等于支持所有 kohya/musubi 命名形式，也不等于所有 Civitai adapter 对其 target mapping 都成立。[实际拒绝逻辑][neysay-lora-c]

现有测试检查 native、diffusers 与两者叠加的 QKV/FC1 数值、alpha、磁盘权重恢复及未知 key 拒绝；它证明加载和排列处理有测试，不证明任意 NSFW adapter 的最终视频质量。[现有测试][neysay-test]

该 fork 的 LoRA 与 `--ssd-streaming` 不能同时使用，源码显式拒绝。最新 `--shift` 只改 video sigma，audio 仍为 3。[生成参数校验][neysay-generation] · [sigma 构建][neysay-host]

## LightX2V：必须绑定具体版本、任务和 alpha

以下 alpha/rank 来自同一 HF revision 的实际文件头；ComfyUI 的 out-proj 与 QKV alpha 又以小范围读取确认。不是根据文件名猜测。

| 精确文件家族 | 任务 / 建议 NFE | video/audio shift | diffusers alpha / rank | strength=1 时低秩乘积的系数 |
| --- | --- | --- | --- | --- |
| `fl2v_turbo_8step_v1.0_bf16`（544p） | FL2VA/T2VA；8，官方也列 4 | 12 / 3 | 8 / 128 | 0.0625 |
| `fl2v_turbo_4step_v1.0_768p_bf16` | FL2VA/T2VA；4 | 6 / 3 | 128 / 128 | 1 |
| `fl2v_turbo_4step_v1.1_768p_bf16` | FL2VA/T2VA；4 | 6 / 3 | 128 / 128 | 1 |
| `fl2v_turbo_4step_v1.2_768p_bf16` | FL2VA/T2VA；4 | 6 / 3 | 8 / 128 | 0.0625 |
| `fl2v_turbo_8step_v1.0_768p_bf16` | FL2VA/T2VA；8 | 6 / 3 | 8 / 128 | 0.0625 |
| `ref2v_turbo_4step_v0.1_bf16` | Ref2VA；4 | 12 / 3 | 8 / 128 | 0.0625 |

来源：[固定 HF 文件目录][hf-files]、[官方任务/shift 规格][turbo-spec]、[最新 fork 对 v1.2 的 shift=6 示例][neysay-readme]。官方规格页尚未单独列 v1.1/v1.2；其 768p shift 的使用口径与该系列官方配置、最新 fork 示例一致，文件头本身没有记录训练 shift。

有效更新是 `ΔW = strength × (alpha/rank) × B@A`。v1.0/v1.1 的 768p 四步版与 v1.2 的 alpha 不同，不能复用 alpha=128。官方示例对 **v1.0** 指定 128 是正确的；对 v1.2 应按其实际 metadata 的 8 处理。ComfyUI 版本通过每模块 alpha 保留相同系数：普通 projection rank128，v1.2 alpha8；拼接 QKV rank384、alpha24。v1.0/v1.1 对应 alpha128/384。[官方 alpha/scale 注入][turbo-inference] · [文件原件][hf-files]

**strength 0.65–0.8 不是普遍的官方推荐。** 当前官方 Diffusers runtime scale 默认 1.0，ComfyUI 示例也用 1.0。使用 0.75 可以是已有融合模型或特定组合的经验选择，需要以具体样例评估，不能当作所有版本的最佳范围。[运行参数][turbo-inference] · [官方 I2VA workflow][turbo-i2v]

官方 LightX2V 配置是 `enable_cfg=false`；ComfyUI 示例用 BasicGuider，仅 positive conditioning。不要额外加一次 CFG 的正/负分支，再把减少步数等同减少相同数量的模型调用。[官方四步配置][lightx-config] · [官方 workflow][turbo-i2v]

FL2VA 的 first/last-frame 与 Ref2VA 的 ordered references 是不同 transformer/checkpoint。FL2VA LoRA 不应因 shape 能对上就给 Ref2VA 使用；官方脚本明确要求 LoRA 是针对 `transformer_ref` 训练的。[官方任务限制][turbo-diffusers]

## 前端相关说法的必要核验

| 项目 | 当前证据与限制 |
| --- | --- |
| h3c-app | 原生模型/LoRA 管理及直接 HF 下载有原始说明，作者报告 4-step Turbo 可完整运行。**当前三个 compute modes 均支持 LoRA**，引文的 streaming 限制已过期；源码有流式 projection patch。 |
| h3c-app 的 768p Turbo 采样 | 当前源码仍固定 video/audio shift 12/3，API 没有 video-shift 参数，生成直接调用固定 schedule builder。作者的「跑通」不能证明在 768p LoRA 训练建议的 6/3 下采样正确。 |
| minimax-h3-studio | 自带 fork 的做法仍是提前折叠 LoRA，并有 lightx2v 转换脚本。作者 M3 Max 128 GB 记录：864×480、4.5 s、Turbo 5 步约 13 分钟含加载；不是几秒出完整视频。Ref2VA Turbo 还涉及手动 shift 补丁门槛。 |
| PipeNetwork MLX | 4-bit 降低内存的说法成立；约 1.2–1.4×是作者对该实现与长度的分析，不能外推为本机或所有 Mac 的固定收益。 |

来源：[h3c-app 当前模式表][app-readme] · [流式 LoRA 实现][app-dit] · [固定 shift][app-host-h] · [schedule 源码][app-host] · [生成调用][app-generation] · [studio Turbo 记录][studio-turbo] · [MLX 作者分析][mlx-readme]

本轮没有对 Wild H3C、ltx-video-mac 或具体 rzgar motion enhancer 做完整源码/训练谱系审计，不能转述它们的任意 workflow 兼容性或专用内容质量为已核实结论。

## 「能叠加」与「组合质量已验证」之间的边界

加载器做的是 `W' = W + ΔTurbo + ΔStyle`。网络对权重是非线性的，因此 delta 能相加并不保证蒸馏后的四步轨迹仍符合某个风格 adapter 的预期，也不保证角色身份、肢体、运动和音频同步。上述原始文档/测试中，没有指定 NSFW LoRA 与指定 Turbo 版本、固定输入、种子、sigma、完整音视频的受控质量对照；结论只能是**技术上有叠加入口，具体组合仍待测**。[fork 数值测试][neysay-test]

足够的小实验可以先证明：真实 adapter 非空解析，target shapes 匹配，alpha/rank 正确，QKV/FC1 变换与 CPU oracle 对得上，原文件未变。这只证明 **所测权重上的 LoRA 数值加载正确**。评估新 Turbo 的增量收益，需要与它任务匹配且未融合该 Turbo 的基础模型对照；这并不要求官方 BF16 权重，NSFW 基础模型也可以。对已融合 NSFW + Turbo 的当前模型，4/8 步完整生成可评估该模型的少步效果，但不能分离新 adapter 的收益。

## 本机实验：优先复用 NSFW 小模型

本机为 M4 Max、40-core GPU、128 GB unified memory、macOS 26.5.1。仓库 source revision 为 `21303399a021cc3e06c26baad0a9d000ecc4774c`；用户原有 Admin 未提交改动不属于本任务。实验经 `withGenerationAcceleratorLease` 串行获得生成加速器租约，先确认 8188/8189/8190 三个 ComfyUI 队列均 idle；编码前调用 idle runner 的 `/free` 释放缓存，未启停任何服务。

实际 checkpoint 为 `/Users/kk/ComfyUI-Shared/models/diffusion_models/REDMix-MiniMaxH3-A2Ab1-pruned-int8-convrot-ComfyMCP.safetensors`，20,970,384,488 bytes（19.53 GiB），SHA-256 为 `fc99ff051283ee05f29b1ebcb14e0d7b36c03e93512ac5479411cdfa2e284122`。其内嵌保存工作流记录：`10Eros_Max_h3_fl2va_beta1_pruned` 基础模型、LightX2V 544p 8-step v1.0 Turbo strength 0.75、SexGod/NaughtyTimes NSFW strength 0.75、reference LoRA strength 0.5，最后进行 INT8 ConvRot 量化。这是文件 provenance，不能替代专用内容质量测试。

### 真实新 LoRA 的加载与数值校验

- 下载的精确文件为 `minimax_h3_fl2v_turbo_4step_v1.2_768p_bf16.safetensors`，1,383,677,808 bytes，SHA-256 `c3d4a2cf618efea71b9e21a4baaa12d412f1eb6c2b6f86efacaf0ebb6814b689`，与固定 HF revision 文件校验一致。
- neysay 原生数值测试通过。真实 adapter 解析出 312 low-rank pairs、208 个 targets，208 个目标 shapes 均与现有 checkpoint 对应；其中 200 个为该 loader 不支持的 I8，8 个为支持的 BF16。
- 从现有 NSFW 文件只读提取 token-refiner 第 0 block 的四个 BF16 大矩阵及一个未适配 norm；QKV 转到 native 所需布局。真实 Metal loader 对四个矩阵应用了新 adapter，日志为 `applied=4 scale=0.0625`，而非把只读取 metadata 算成加载。
- strength=1，alpha=8，rank=128；四个矩阵各取 71 行，共 2,290,176 个元素，与独立 CPU float64 `B@A`、重排及 BF16 round-to-nearest-even oracle **逐元素 bit-exact**（max BF16 ULP=0）。这是抽样验证，未声称比较完整矩阵的全部元素。未适配 norm 整体不变，原 checkpoint size/mtime 与 fixture SHA-256 不变。
- `apply` 0.256 s；selected-tensor 进程 1.035 s，physical footprint 约 2.22 GiB。这是权重 patch 开销，不能当作视频生成耗时。
- neysay 对原 INT8 checkpoint 的真实完整 loader 测试明确失败：`blocks.0.attn.out_proj.weight` dtype/rank 为 `I8/2`，而当前路径要求 `F32/2`。因此本轮没有在该 fork 上证明完整 NSFW INT8 模型的运行时新 LoRA 叠加。

### 原生读取现有 NSFW ConvRot 权重

maderix fork 支持 ComfyUI pruned AdaLN table、INT8 ConvRot、普通 Comfy QKV 布局和 FP16 视频 VAE。本轮清除所有 `H3_ANE_*` 环境变量，只跑默认 Metal GPU 路径，没有启用 ANE 私有接口或产生 ANE 编译缓存。此路径把量化权重反量化到 BF16 常驻；**19.53 GiB 文件不代表同样大小的运行内存**。

NSFW 与 Turbo LoRA 主要改变权重行为，并不把主干的 50 层 transformer 缩小。当前文件体积主要因 INT8 量化而减少；「NSFW 版本」本身不是低内存或更快的保证。

该 fork 的量化 marker 解析器只接受 JSON 中带空格的 `"format": "int8_tensorwise"` / `"convrot": true`，当前合法紧凑 marker `{"format":"int8_tensorwise","convrot":true,"convrot_groupsize":256}` 被误拒绝。先加入 compact-marker 回归，复现 raw/rotation 元数据错误与真实权重加载失败，再仅在实验 clone 修复字符串外空白处理。修复后 compact/spaced markers、原拒绝测试、ConvRot 数值及真实 NSFW QKV 读取测试全部通过；保留 red/green 日志和补丁，不修改模型文件。

文本条件使用现有 `qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf` 在 CPU 编码，产生 `[1,49,5120]` BF16 H3CD，编码调用 13.277 s，整个编码进程 17.730 s。没有下载 51 GB BF16 encoder，也没有宣称 GGUF 与 BF16 encoder 的数值等价。复用现有视频/音频 VAE，通过 symlink 组成 native 模型目录；从固定官方 revision 下载 tokenizer 和两个归一化 config（两个 config 合计 3,780 bytes），并核实其 mean/std 与现有 VAE 内嵌 tensors 完全相同。

控制 prompt 是成年女性穿红色晚礼服微笑挥手、室内环境音，无露骨内容。所有生成均为纯 T2V、512×512、22 帧、24 fps、seed42、50 blocks、reuse1、Euler、video/audio sigma shift12/3、无额外 CFG。4/8 步使用 **同一份已经融合的 NSFW + 8-step Turbo 模型**，没有再次叠加新四步 Turbo。该 fork 的预计算条件入口显式不支持 first/last frame 或 references，因此本轮不是产品 I2V 工作流替换验证。

### 完整短片实测与质量

| 运行 | DiT 加载 | DiT 采样 | 音频 VAE | 视频 VAE | 进程总时间（含加载、解码、FFmpeg，不含预计算文本） | physical footprint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 步 | 50.607 s | 102.567 s | 2.572 s | 18.824 s | 175.398 s | 38.21 GiB |
| 8 步 | 15.557 s | 90.977 s | 0.259 s | 11.346 s | 118.906 s | 38.47 GiB |

两段都解码确认 22 帧、512×512、24 fps（video 0.916667 s），带 32 kHz 双声道 AAC（容器 0.925 s）；完整帧非空，完整音频解码后 finite。4 步输出 SHA-256 为 `0a0736c61df2fda842769486d68f885a503a58c6662f9adf330210e775d02315`，8 步为 `f34f8cfb90a3d4381fbc18b34c25d19f829307843e094a7f3df3d7d8d33b204a`。

总时间没有包括独立的 17.730 s 文本编码进程。简单顺序相加得到 193.128 / 136.636 s，但两次共享同一个预计算条件文件，不能把这个相加值当作单个集成服务已测得的端到端 latency。

抽取帧 0、10、21 视觉检查：均能表现成人、红裙、室内和挥手。4 步脸部和运动有明显重影/畸变；8 步脸部、手部更清楚。两段仍有右上水印和底部伪文字，不能视为成片质量已达标。音频验证覆盖容器、解码及有限数值，未做主观音质评价；没有生成露骨内容，因此没有验证专用内容能力。

本轮有一个保留的失败尝试：4 步 DiT 采样 30.161 s，随后因目录未放入 audio VAE config 而退出，不能算完成视频。补齐并与 VAE tensors 核对 config 后成功。该失败采样、成功 4 步和成功 8 步的耗时相差很大，加载与 VAE 时间也明显不同；测试期间其他桌面/开发进程仍运行，没有控制冷暖缓存、功耗或整机负载。**因此本轮只确认可运行及样例质量，不计算 4/8 步或原生/ComfyUI 的稳定倍速。** 与既有产品 512×512、124 帧、8 步 I2V 的历史 667 s 总时间也不可直接比较。

本机视频与抽帧：

- [4 步短片](../../.scratch/h3-lora-20260929/nsfw-native-4step.mp4) · [4 步抽帧](../../.scratch/h3-lora-20260929/nsfw-native-4step-contact.png)
- [8 步短片](../../.scratch/h3-lora-20260929/nsfw-native-8step.mp4) · [8 步抽帧](../../.scratch/h3-lora-20260929/nsfw-native-8step-contact.png)

### 证据与边界

小型证据保存在 [evidence/h3-lora-2026-09-29/](evidence/h3-lora-2026-09-29/)：固定模型/源码摘要、真实 LoRA oracle 结果、回归 red/green 日志、原生完整生成日志、视频解码检查及实验脚本。大权重和短片保留在本机 `.scratch/h3-lora-20260929/`，未写入 Git。

本文结论适用于固定版本。本轮证明了真实 LoRA 对所测 BF16 权重的正确数值加载，以及现有 NSFW 量化模型的原生短片生成路径；没有证明新四步 Turbo 对整个 NSFW INT8 checkpoint 的动态叠加、专用内容质量、产品 I2V 交付或稳定端到端倍速。

[antirez-readme]: https://github.com/antirez/h3.c/blob/8974cc055ea9c02fcd14cc27dfda3e1027c05153/README.md
[antirez-main]: https://github.com/antirez/h3.c/blob/8974cc055ea9c02fcd14cc27dfda3e1027c05153/main.c
[antirez-h]: https://github.com/antirez/h3.c/blob/8974cc055ea9c02fcd14cc27dfda3e1027c05153/h3.h
[neysay-readme]: https://github.com/neysay/h3.c/blob/debd9a1e55815132200ee722c1e27ed22b006f6d/README.md
[neysay-lora-h]: https://github.com/neysay/h3.c/blob/debd9a1e55815132200ee722c1e27ed22b006f6d/h3_lora.h
[neysay-lora-c]: https://github.com/neysay/h3.c/blob/debd9a1e55815132200ee722c1e27ed22b006f6d/h3_lora.c
[neysay-test]: https://github.com/neysay/h3.c/blob/debd9a1e55815132200ee722c1e27ed22b006f6d/tests/test_lora.c
[neysay-generation]: https://github.com/neysay/h3.c/blob/debd9a1e55815132200ee722c1e27ed22b006f6d/h3.c
[neysay-host]: https://github.com/neysay/h3.c/blob/debd9a1e55815132200ee722c1e27ed22b006f6d/h3_host.c
[turbo-spec]: https://github.com/ModelTC/Minimax-H3-Turbo/blob/02e26d591f7a04d5d1a074c9566d5dd4f22f6225/README.md
[turbo-inference]: https://github.com/ModelTC/Minimax-H3-Turbo/blob/02e26d591f7a04d5d1a074c9566d5dd4f22f6225/inference_minimax_h3.py
[turbo-diffusers]: https://github.com/ModelTC/Minimax-H3-Turbo/blob/02e26d591f7a04d5d1a074c9566d5dd4f22f6225/DIFFUSERS_SETUP_AND_INFERENCE.md
[turbo-i2v]: https://github.com/ModelTC/Minimax-H3-Turbo/blob/02e26d591f7a04d5d1a074c9566d5dd4f22f6225/example_workflows/video_minimax_h3_i2v_lightx2v_turbo.json
[hf-files]: https://huggingface.co/lightx2v/Minimax-h3-Turbo/tree/3ec17a324ced54151364f24f8b5fb6bf7e26414f
[lightx-config]: https://github.com/ModelTC/LightX2V/blob/8a97c7591d7252ef491392e83e1eb18617ac9368/configs/minimax_h3/dmd/minimax_h3_bf16_4step.json
[app-readme]: https://github.com/JunzoKamahara/h3c-app/blob/767b6aaa4a6157f35410956f99ffae864da31cc2/README.md
[app-dit]: https://github.com/JunzoKamahara/h3c-app/blob/767b6aaa4a6157f35410956f99ffae864da31cc2/h3_dit.c
[app-host-h]: https://github.com/JunzoKamahara/h3c-app/blob/767b6aaa4a6157f35410956f99ffae864da31cc2/h3_host.h
[app-host]: https://github.com/JunzoKamahara/h3c-app/blob/767b6aaa4a6157f35410956f99ffae864da31cc2/h3_host.c
[app-generation]: https://github.com/JunzoKamahara/h3c-app/blob/767b6aaa4a6157f35410956f99ffae864da31cc2/h3.c
[studio-turbo]: https://github.com/syydaniel/minimax-h3-studio/blob/af2ebcb255246ce9d5424f7c54202d569b9f5c07/docs/TURBO.md
[mlx-readme]: https://github.com/PipeNetwork/minimax-h3-mlx/blob/b2f7e4d2b7861cefe68b75e4b59ab81cc4e7c318/README.md
[integration-readme]: https://github.com/MiniMax-AI/awesome-minimax-h3-integration/blob/7e7d6a53b308268c7bd1fb8d8126bfb172a37cd9/README.md
[maderix-readme]: https://github.com/maderix/h3.c-ane/blob/6538b226efe5c4fff905d299dcc4426db2f44de4/README.md
