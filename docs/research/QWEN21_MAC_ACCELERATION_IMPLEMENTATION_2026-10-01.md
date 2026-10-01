# Qwen 2.1 Mac 加速：实施与真实交付记录

2026-10-01。已确认正式使用现有原生方案：**REDQW21 V2 BF16＋社区 ConvRot INT8 Qwen3-VL 8B MPS 编码＋Viggle v0.3 r128 六步 LoRA**，并保留参考 VAE 的 MPS 数值修复。后续真实产品验收的两笔 832×1024 单图编辑，从 Job 创建到完成分别为 **58.117 秒、48.337 秒**，ComfyUI 执行分别为 56.853 秒、47.607 秒。两笔均验证 HTTP 图片读回、terminal relay、交付与持久化，每笔只扣 8 Dreamcoins；相同 Idempotency-Key 重放没有增加 Job、Attempt 或扣费。

本次后续验收绑定运行 revision `idream-worktree-2068f6373b7e0cf026dcac2533da8d8225b9ab590ea1a37af0ba4c7b37561309`，Job 为 `cmupkxzzz0000yil77c773vgp` 与 `cmupl1f0g0008yil7u7z6yb6t`。新增 preflight 校验 REDV2 BF16、社区 INT8、VAE、Viggle 四个文件的 SHA256，并证明 image listener 从配置的模型根目录唯一加载这些文件；全部 13 个图像/视频模型 byte checks 通过。相关 Gen 测试 74 项、原生数值回归 7 项通过。最终八个产品进程绑定同一 revision，所有运行进程在线、四个 Generation 队列恢复、三个 ComfyUI 队列空闲。详细记录在 `.scratch/qwen21-native-acceptance-20261001/summary.json`；下文保留此前轮次证据。这次确认只更新说明，没有改动生成配方或再次执行模型请求。

这些数字来自 M4 Max 128 GiB；用户的 16 秒来自另一台 M5 Pro，分别评估。两笔样本不构成稳定延迟分布。双参考流程修复 VAE，保留 16 步 / CFG 2 / CPU 编码，未宣称完成其极速或身份替换质量验收。Rapid-AIO v19 已退役，当前四个 Qwen 工作流均不加载它。MFLUX/MLX 保留为研究原型，不接入正式工作流。

## 已落地的实现

- `packages/gen/comfyui_nodes/idream_qwen21/nodes.py`：`IDreamQwen21VAELoader` 只修改该 Qwen VAE 实例的五个 `AvgDown3D` 模块。时间维前置零帧使用 `torch.cat`；后续分组和平均严格保留 CPU 语义。没有全局修改 Wan 视频 VAE。
- `__init__.py` 只在 image runtime 注册这组节点。共享目录中的旧 video / video-h3 运行时跳过图像依赖导入，避免缺少 Qwen 2.1 类导致的启动 import error；回归确认连 Torch 都不会被这条注册路径加载。
- 同文件 `IDreamQwen21TextEncode`：单图配方 CFG=1 / BasicGuider 不使用无条件分支，因此只执行一次正向编码。保留原生 Qwen 2.1 的 RGBA、图像插槽、参考 latent 和几何契约；CFG>1 仍计算实际负向分支。
- `turbo.py`：Viggle v0.3 按 rank=128、alpha=128、strength=1 添加未合并残差，覆盖 Comfy fused SwiGLU 的 gate/up/down 路径；无论正常结束、注册失败或执行异常都移除 hooks，不改底模权重。六步 raw sigmas 为 `[1,.9375,.875,.75,.5,.25]`，按输出 latent 几何作动态 shift，不做 terminal stretch，追加零并使用 Euler。
- `qwen-image-edit-img2img@5` 使用 MPS INT8 编码器、正向单次编码、BasicGuider、上述 LoRA / SIGMAS。`redqw21@3`、双参考 `@6` 和多身份 `@5` 使用同一 VAE 修复，保留各自原有采样与参考契约。
- Main seed 与 `db/sql/2026-10-01-qwen21-mac-acceleration.sql` 对齐。开发库发布 N+1 并归档旧配置，保留历史任务/Attempt、价格、数量、rollout、权限与双参考采样参数。存在排队/执行中的 Qwen 任务时拒绝发布，兼顾逻辑 profileKey 与历史行 ID。
- 历史 INT8 cutover 重放不再把新 MPS 工作流降回 CPU；新脚本重复执行不再新增版本，未来更高工作流版本不降级。

## 固定权重与运行环境

image runner 为 ComfyUI `88ab4a06566454ad89db8f0bedb970d6c08cd1b7` / PyTorch 2.14.0 / Python 3.13，macOS 26.5.1。上一轮已修复 PM2 保存的旧 Python 覆盖；`bun run comfyui:restart` 从指定 image 安装加载正确环境。

| 组件 | 文件 / 来源 | SHA256 |
| --- | --- | --- |
| REDV2 diffusion | Civitai 452459@3370753，BF16 转换 `redqw21_unlocked_v2_bf16.safetensors` | `c2ff9ea7e983b61589363fe11d0437419f7ade088bb470ef2e501bd81513c45f` |
| 社区 INT8 encoder | Comfy-Org revision `cb504a4090723e43f17ad01cec0359490e2de613`，`qwen3vl_8b_int8_convrot.safetensors` | `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f` |
| Qwen 2.1 RGBA VAE | `qwen_image_2.1_vae_bf16.safetensors` | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` |
| 六步 LoRA | Viggle revision `009a44a895ef85f7e643c80fdca9543795248867`，v0.3 r128，679604800 bytes | `0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3` |

发布前核对 runner 实际 model-root 解析及 diffusion / encoder / LoRA 三个完整文件 SHA；VAE 另行完整 SHA 核对。LoRA 的固定 LICENSE / NOTICE 已随共享权重保存。INT8 是用户指定的社区 checkpoint 格式，M4 执行会恢复浮点计算，不能称为 M5 原生 W8A8 内核。

## VAE 根因与验证

[ComfyUI #16433](https://github.com/Comfy-Org/ComfyUI/issues/16433) 是定位线索；本机独立测试确认大尺寸 rank-five MPS `F.pad` 会破坏像素。对 `[1,96,1,512,512]` 与 `[1,96,1,416,608]`，FP32/BF16 原实现有数千万元素不同；修复后的冷/热输出与 CPU 逐元素完全相等。

下表是同一已安装 VAE 的完整 encode→decode。CPU FP32 是 oracle，MPS 使用 BF16；完整 VAE 存在浮点舍入差异，不要求逐位相等。

| 尺寸 | CPU round-trip PSNR | 未修复 MPS PSNR / latent 相对 RMSE | 修复 MPS PSNR / latent 相对 RMSE |
| --- | ---: | ---: | ---: |
| 832×1216 | 48.137 dB | 34.646 dB / 0.18610 | 47.839 dB / 0.01057 |
| 1024×1024 | 43.717 dB | 8.918 dB / 0.80523 | 43.577 dB / 0.01859 |

修复后两轮 MPS latent 统计与结果稳定；完整 VAE 对照通过相对 RMSE<0.03 的容差。保留 MPS encode 约 0.53–0.59 秒、round-trip 约 2.2–2.3 秒，避免退回 CPU round-trip 的约 13–15 秒。

## 同规格受控 provider 对照

同一 832×1216 源图、REDV2 与社区 INT8 权重、seed=42；前四项为加红围巾，第五项为改蓝衬衣。重启后代表模型进程冷启动，磁盘缓存未主动清空。cache 数是 Comfy 普通节点复用，不是 EasyCache 跳步。每项仅一次测量，不是统计分布。

| 变体 | provider 总秒数 | Comfy 执行秒数 | 命中节点 | Comfy request ID |
| --- | ---: | ---: | ---: | --- |
| 修复 VAE，CPU 编码两次，10 步 | 102.561 | 101.989 | 0 | `5d217618-f6e9-46e8-8fe6-1dbd3abbfc4d` |
| CPU 仅编码正向，10 步 | 84.506 | 83.439 | 0 | `b8144e6c-1829-499b-8bbf-1a8ed685119a` |
| MPS 仅编码正向，10 步 | 80.557 | 80.174 | 0 | `3f01debf-4f20-4282-bfdb-933b4f45976a` |
| MPS 正向编码＋Viggle 6 步，重启后 | 61.413 | 60.283 | 0 | `ab038337-4690-4bc8-ad63-45f8391b3fa4` |
| 同配方热请求，换蓝衬衣指令 | 54.412 | 53.439 | 6 | `0886a2f8-f45e-4dd2-9a8b-1cfea7551136` |

固定源图 SHA256 `f0755a99018699d0e934bd3b566498736ed994d9f23b0734ad43797a1c0a4798`。检查输出确认红围巾/蓝衬衣意图，以及同一正面人物、白杯、双手与海滩构图。没有把单一人物的两个编辑解释为广泛身份保真结论。完整 prompt、实际 runtime、descriptor SHA、source revision、history、PNG 与输出 SHA 都在 `.scratch/qwen21-acceleration-diagnosis/<variant>.*`。

修复后的 CPU 两次编码 102.561 秒→新六步冷运行 61.413 秒，是同规格约 40% 的总耗时下降。用户此前 157 秒来自旧环境与旧配方，不能作为单变量对照；原始 2.10 与未修复 VAE 的历史记录保留在先前调查报告。

## 未发布的候选

- MLX hybrid：保留 native 社区 INT8 encoder 与修复 VAE，只更换 diffusion sampler。Q8 总 61.431 秒、采样 51.368 秒；Q4 请求总 60.616 秒、采样 50.780 秒；fused QK Q8 总 73.485 秒、采样 55.682 秒。native 六步采样约 41 秒，因此没有观察到采样收益。Q4 初始日志未独立留存实际模块 bits，不把请求参数当作量化执行证明；fused Q8 的日志确认 228 个 QuantizedLinear 实际均为 8 bits、227 个 LoRALinear。Q8 输出做了局部编辑目视检查，Q4/fused 未做完整保真验收。
- MLX 固定源码 `83f4d1dee103674da5f2385251e7794cd7285ba5`、MLX 0.32.2、Python 3.12.9。CPU 验证覆盖两参考 token/RoPE、Comfy seed/noise、归一化、FP32 Euler、LoRA 与 child 中断/回收；这不能代替多参考真实生成。原型封存在 `.scratch/qwen21-mlx-prototype/`，未建立新 Gen runner，未 vendor 大量上游源码进正式实现。
- 保守 EasyCache `.2 / start=.15 / end=.7` 的六步试验跳过 0/6 步，不能证明额外缓存收益。此前激进 cache 的保真失败不作为默认配方。
- `PYTORCH_MPS_PREFER_METAL=1` 的请求试验记录了 72.602 秒，但没有证明该环境变量到达 Python，所以不能据此得出 Metal matmul 更慢的结论。已撤回该归因；最终 Python 进程环境确认没有该 override。
- `mx.compile` target-only 路径、PAI PDD 四步、M5 TensorOps、Draw Things 仍为候选，未在本轮发布或宣称实现 16 秒。

## 开发库与 UI 发布

目标仅为 `localhost:5433/idream_runtime_20260812`，不涉及生产库。发布时八个应用停止、三个原生队列空闲，使用既有 accelerator lease。四个 Comfy UI 工作流同步成功。

| profileKey | 开发库新 profile version | workflow pin | steps / CFG | encoder |
| --- | ---: | --- | --- | --- |
| `character-image-multi-identity` | 5 | `qwen-image-edit-multi-identity@5` | 16 / 2 | cpu |
| `character-image-variation` | 6 | `qwen-image-edit-multi-reference@6` | 16 / 2 | cpu |
| `chat-image-edit` | 5 | `qwen-image-edit-img2img@5` | 6 / 1 | mps |
| `profile_image_default_v1` | 6 | `redqw21@3` | 10 / 1 | cpu |

profile version 保留现有历史，所以开发库默认文生图版本可能与全新 seed 的版本不同。完整 before/after、目标数据库、运行解析和 SHA 验证见 `.scratch/qwen21-acceleration-diagnosis/mac-publication.json`。

## 两笔真实产品任务与最终运行版本复测

通过真实 HTTP quote → variation → Main 准入 → Gen worker → Comfy → terminal relay → Main 交付。使用新建 audit 用户、私有成年人物 fixture、本地 blob storage（配置名 `mock`，实际读写文件）与既定 mock moderation；图片生成 provider 是真实 `comfyui`。该范围不代表公开生产、Chat 对话、视频或语音链路验证。

- 首次发布 revision：`idream-worktree-caa01a7a312d3e37a585aa8e87b351eeef3296507eebd8a8137d2a9136a6c066`。Job `cmupaku5q000088l70h4sywyy`；Attempt `cmupaku6b000688l7c62e5n0i`；Comfy request `f6118c24-f307-41f5-adeb-d74c497b4be2`；seed `419129375`。证据已保存在 `initial-product-{probe,history,terminal}.*`。
- 图像节点注册隔离后的最终实测 revision：`idream-worktree-c42668837870563ffeb244632e5db01e1e916a5348f10ff06d67f5581ae5ea3a`。Job `cmupbr0zy00004sl727a6w9hq`；Attempt `cmupbr10n00064sl797us9sik`；Comfy request `2092a1fc-a41d-46ae-a035-ef8034b0cbcd`；seed `3286518782`。两笔 Main/Gen 与各自 terminal execution 的 revision 均一致。图像实现从 `__init__.py` 移至 `nodes.py` 的 SHA 相等，独立文件 SHA 留在 implementation manifest。
- 两笔均为 profile `chat-image-edit@5`、workflow `qwen-image-edit-img2img@5`。native history 确认修复 VAE、MPS 社区 INT8、CFG=1、Viggle LoRA、六步 SIGMAS，普通节点缓存均为 0；比较实际 API graph，仅 noise seed 不同。
- 产品默认 4:5 输出实际为 **832×1024**，不是上述 832×1216 provider 对照。首次创建→completed **49.468 秒**、Comfy **48.093 秒**；最终版创建→completed **85.337 秒**、Comfy **83.300 秒**。十秒 HTTP 轮询分别在 50.319 与 90.449 秒观察到完成，轮询时间不能代替真实完成 timestamps。
- 两笔 HTTP 图片读回与 PNG sanity 均通过，并分别目视检查蓝衬衣、人物、杯子、双手与背景。首次 asset `media_3cmp90stjj4mupalwbr`，SHA `1f804cf631a17c8043347178ee0c8e3173c19cfa399f3f0600a5066a6b47251a`；最终版 asset `media_8k0mhos3d6imupbsuuc`，SHA `4dbc85ae7f7151cb45db6393ed53ae81f2997624fc25d8588afb4893c0290740`。
- 耗时取 Comfy history 与数据库 timestamps；terminal usage 中旧的 `gpuSeconds=1.2` 估算不作为真实 GPU 或采样时间证据。
- 每笔使用独立 audit 用户，初始受控额度 100，实际扣 **8 Dreamcoins**，余额 **92**。各自同一 Idempotency-Key 重复提交仍是同一个 Job、一个 Attempt、一个 generation_spend，没有额外生成；本地模型没有外部按量费用。
- terminal receipt processed、Main outbox delivered、transport succeeded、artifact valid/active、delivery delivered、MediaAsset 与单笔 spend settlement 均由现有 persistence probe 检查通过。

最终版耗时差异在模型执行内：accelerator lease 等待 0.981 毫秒，其他 runner 释放 1.536 毫秒，provider prepare 100.033 毫秒。日志中的 conditioning 为首次 3.478 秒、最终版 7.674 秒；六步采样约 33.2 秒→51.8 秒，额外模型准备/解码等时间也增长。排队或 Main 交付不是此次主要瓶颈。事后观察到其他主机工作负载及已有约 11 GiB swap，但没有同步隔离对照，不能据此证明资源竞争是根因。

在同一最终版进程做了一次有界 provider 热复测，使用原始 seed `419129375`、相同尺寸、源图与产品 prompt。总耗时 **46.324 秒**、Comfy **45.709 秒**，普通缓存 5 个节点，conditioning 3.181 秒、六步采样约 32.8 秒，输出 SHA 与首次产品任务**完全相同**。请求为 `d736448d-da09-47ac-8075-a2599c2a3166`；这次只调用 provider，不创建产品 Job、不扣 Dreamcoins。该复测排除了图像实现移动造成输出变化，支持冷运行/主机状态差异的方向，但未区分 shader/kernel 初始化、模型加载与外部负载；不宣称冷启动波动已解决。前后 VM 计数留在 `runtime-warm-probe.json`。

观测脚本最初错误地把 public profileId（逻辑 key）与数据库行 ID 比较，两个失败的 quote-only setup 没有发起生成，已清理其 audit 账号和私有源 blob。首次完成 Job 的读回脚本最初给 PNG sanity 传了 Uint8Array；修正为其 Buffer 契约后重新读取同一完成任务验证，没有另发生成或扣费。观察修复记录保留在 `initial-product-probe.json`。

成功任务核验后撤销 session，隐藏 audit 账号和媒体，保留不可变 Job/Attempt/ledger/terminal 证据与本地 PNG。persistence 的 active-media 验证时间先于此清理，清理状态单独记录。

## 验证与恢复

- Python 数值/节点回归 **7/7**：36 个 CPU 时间/空间/strided 输入组合、大尺寸 MPS FP32/BF16、正向单次/CFG2 两次编码、固定六步 sigma、普通与 fused LoRA 数学/权重不变/异常 hooks 清理，以及两种 video profile 不导入图像依赖。
- Gen 四个相关测试文件 **59/59**：workflow、registry、backend-image-model、Comfy UI graph；最终运行记录为 `gen-final-tests.log`。
- Main 专用 `idream_test`（5433）与 Redis 15，四个 seed/cutover 测试文件 **17/17**：排队守卫、历史/价格/双参考参数保留、重复发布、旧脚本防降级；最终运行记录为 `main-final-tests.log`。未使用开发库运行这些测试。
- Gen/Main typecheck 与 Main 四个修改文件 ESLint 通过；`git diff --check` 通过。未运行全仓 CI、构建或全面多模态端到端套件。
- Gen preflight：10 个 descriptors、75 种节点、29 个模型引用、9 个已固定模型 byte checks，0 个问题；新增四种正式节点存在。
- 按 `bun run pm2:restart` 的 drain/readiness/ownership 流程恢复八个应用，四个 generation queues resumed；09:45 UTC 的最终状态读取确认八个应用 online、revision 与最终实测一致、四个队列均未暂停、三个原生队列 idle。MLX 临时节点 symlink 已删除，object_info 不含其 sampler，无残留 MLX child；三个运行时的 UNET 列表均不含退役 Rapid 模型。

本地证据目录：`.scratch/qwen21-acceleration-diagnosis/`。重点文件：`vae-full-{unpatched,patched}.json`、`qwen21-regression-final.log`、`mac-publication.json`、`initial-product-{probe,history,terminal}.*`、`product-{probe,history,terminal}.*`、`runtime-warm-probe.*`、`runtime-verification.json`、`implementation-manifest.json`、`mac-runtime-resume-final.log`。该目录未纳入 source revision；正式文件 SHA、原型 manifest 与模型完整 SHA 单独留证。最终实测后更新了文档，不把文档更新误称为重新验证全部运行代码。

## 一手来源

本次算法采用作者明确的六步 raw grid、无 CFG 与未合并 adapter 配方；节点数学与本地数值测试共同证明实际接线，不仅是参数被接受。

- [Viggle 固定 README](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/README.md)，[作者 Comfy 节点](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/comfyui/viggle_turbo.py)。
- [ComfyUI Qwen 2.1 VAE 缺陷报告](https://github.com/Comfy-Org/ComfyUI/issues/16433)。
- [社区 INT8 文件](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/cb504a4090723e43f17ad01cec0359490e2de613/text_encoders/qwen3vl_8b_int8_convrot.safetensors)。
- [MLX 官方 compilation 说明](https://ml-explore.github.io/mlx/build/html/usage/compile.html)：原型未来 compile 设计来源，未成为本轮加速证据。
