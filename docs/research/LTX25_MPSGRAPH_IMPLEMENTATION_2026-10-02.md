# RedGraft LTX 2.5：MPSGraph attention 实施与验收（2026-10-02）

## 结论与范围

本次优化直接针对视频采样。Gemma 已使用官方 INT8 派生的 MLX Q8，加载加编码只占此前完整流程约 0.64%；继续降低 Gemma 位数不是主要提速方向。保持 RedGraft 有效权重、Gemma、VAE、768×1152、121 帧、24 fps、音轨、CFG 1 和 8＋3 次 Euler，改用模型局部 MPSGraph BF16 attention。

同环境 A/B/A 中，候选完整视频为 **616.334 秒（10分16秒）**，两次 split 为 **799.665 / 753.077 秒**。相对复测 A2，两段采样由 661.911 秒降至 550.192 秒，减少 **16.88%**；完整耗时减少 18.16%。这些是本机少量样本，不是延迟分布或 SLA。A1 首步有额外冷开销；A2 解码窗口运行过 CPU 迁移测试，总耗时比较包含负载差异，采样对照更有参考价值。

BF16 accumulation 与原先的 FP32 QK upcast 不同，动作、口型和像素会变化。以新 workflow/profile 发布，不宣称无损或位级相等。Main 交付持久化和计费不是本轮性能验收范围。

## 第一性原理与选择

总时间约为：固定开销＋8 次低分辨率 DiT＋3 次高分辨率 DiT＋VAE。实测视频 token 为 3,456 / 13,824，高分辨率阶段 token 为 4 倍，dense attention 配对数为 16 倍。仅缩短 Gemma 不会消除反复发生的 DiT 工作。

本次减少长序列 attention 的中间矩阵与搬运。只替换两个 guider 所用 MODEL 的 attention override；短音频序列和不适配的调用继续原 Comfy split 路径。没有减少 denoiser 调用、分辨率或帧数，没有启用 TeaCache、跳层或整条 MLX DiT 替换。

选型来自 [Lightricks Apple attention 路径](https://github.com/Lightricks/LTX-2/blob/2d6e71c88be37b55a2dd698c2dff447edfbe5898/packages/ltx-core/src/ltx_core/model/transformer/attention.py) 与 [mps-sdpa 0.2.0 源码](https://github.com/crlandsc/mps-sdpa/tree/3e114e924e1228928569cb889e6c5c78f0cf404f)。社区能力、版本和不可套用的基准见 [本轮研究](LTX25_MAC_COMMUNITY_UPDATE_2026-10-02.md)。

## 运行环境与不可变配方

- 本机 M4 Max / 128 GiB；固定 Comfy source `c645560264062e6a5b0688d25eaf3ee9906a7709`（0.34.2）。
- Python 3.13.12；独立 Torch 2.11.0、torchaudio 2.11.0、torchvision 0.26.0；mps-sdpa 0.2.0。`uv pip check` 通过，完整 freeze 保存在证据目录。
- Comfy source：`/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI`。
- video Python：`/Users/kk/ComfyUI-Installs/idream-ltx25-mpsgraph/.venv/bin/python3`。
- 独立持久 JIT cache：`/Users/kk/ComfyUI-Installs/idream-ltx25-mpsgraph/torch_extensions`。没有复用其它 Torch 二进制，也没有删除其 build lock。
- `MPS_SDPA_SKIP_CALIBRATION=1`：0.2.0 的自动校准测复制式 PyObjC；null 阈值会连 zero-copy 一起禁用，因此明确使用已验证的默认阈值。
- canonical `redgraft-ltx25-i2v@4`；default profile v6 / options v7；执行图 SHA256 `7a51857f6c929855dd0e150391bd280ab62206ac3d46ba969d423d4f44b6bc87`。
- 节点 `900:4` 包装 `320:333`，两个 guider `320:314` / `320:282` 均引用它。`compute_precision=bf16` 写入图及 fingerprint。
- 第一段 sampler `320:283` 是 8 步，第二段 `320:308` 是 3 步；profile 的 `steps=13` 是既有 sigma 表项数，包含两个末尾 0，不能当作 13 次前向。
- 模型资产 SHA256 与 workflow v3 相同，由 shared recipe 和 `assets.json` 记录。没有下载或改换大模型；图片与 H3 Python 不升级。

A/B/A 使用相同成年人物源图、prompt、noise `320:277=2026082801`、refiner `320:276=2026082802`。每次新建隔离 8191 进程，持有 Gen 共享 accelerator lease，检查其它 Comfy 队列空闲。没有 Comfy 节点结果缓存命中。JIT 已通过 native 单测预编译；这里的“新进程”不等于空 OS/JIT cache。

## 完整 A/B/A

节点墙钟包括相应模型加载，不只 sampler 进度条：

| 路径 | stage 1 / 秒 | stage 2 / 秒 | VAE / 秒 | 总计 / 秒 |
| --- | ---: | ---: | ---: | ---: |
| A1 split | 336.630 | 402.564 | 42.172 | 799.665 |
| B1 MPSGraph BF16 | 214.213 | 335.979 | 48.576 | 616.334 |
| A2 split 复测 | 231.291 | 430.620 | 71.914 | 753.077 |

A1 首步 95.92 秒，A2 首步 28.17 秒，不能把两者差额都算作优化收益。B1 相对 A1 的 22.93% 只是这一对测量。A1/A2 解码后逐帧 SSIM=1；不同 MP4 hash 来自容器等差异，不据 hash 宣称画面变化。

B1 对 A1 的逐帧 SSIM 平均 0.895669、最小 0.787463，提示实质像素差异。六帧抽查保持人物、背景、动作意图，没有明显空白/崩坏；单人物和短片抽查不能代表广泛内容质量。

所有 A/B/A 视频完整解码 121 帧，H264 768×1152 / 24 fps / 5.041667 秒，AAC 48 kHz 双声道，音频有限且非零；没有连续完全重复帧。音轨格式和信号检测不等于人工听感或唇音同步验收。

## 数值与故障修复

原实验节点有两个根因：默认忽略 Comfy 的 FP32 upcast，以及把带非零 `storage_offset` 的 contiguous view 直接交给原生桥接。mps-sdpa 0.2.0 读取底层整个 MTLBuffer，未叠加该 offset，可能读到错误 Q/K/V 或 mask。

现在默认 `comfy` 保留 Comfy 精度；BF16 模式须显式选择。Q/K/V 和 additive mask 先 contiguous，仅在 offset 非零时 clone。非 MPS、GQA、混合 dtype/device、布尔或不兼容 mask、短 shape、非有限 scale 保留原函数及原始参数。已有 MODEL override 则拒绝叠加。

- 真机旧代码 offset 回归 2 项失败；修复后 Torch 2.11 的 10 项测试全部通过（3 个 CPU 契约、7 个 opt-in MPS 数值/路由场景）。
- 独立 CPU FP64 计算 QK/softmax/PV；抽取 4 个 head × 4 个 query row，保留所有 KV tokens。检查有限性、相对 RMSE 和最大绝对误差；误差门限以 BF16 舍入误差和固定底限定义。
- B1 self-attention 3,456 / 13,824 tokens 相对 RMSE 为 0.175% / 0.157%，均通过。A2 额外记录六种长 attention shape，均通过。
- B1 1,344 次 `mpsgraph_zc` dispatch、fallback stats 为空；短 shape 1,824 次走原 Comfy。库 counter 只代表尝试，恢复验收另记录原生 op **成功返回数**，不能拿设置开关或尝试次数代替实际执行。
- 没有测量过程峰值内存，不作峰值节省声明；报告末尾 allocator 数不等于峰值。

## 发布与验证记录

先用根 README 的 wrapper 排空并暂停 Generation，再更新 canonical authority、独立 video runtime 和 profile SQL。迁移只新建 profile，保留历史执行字段、价格、旧 job pins；原 active v5 options 变为 active v7，旧已归档 v4 保持原样。新 proof 不复制旧 `passed`。Options importer 同时支持历史 4→5 与当前 6→7；已 active options 重放不改变发布状态。

完成的 CPU 验证：shared recipe 19 项、Gen workflow/backend/preflight 47 项、Main profile authority 10 项、Prisma cutover/seed 27 项、PM2 174 项均通过；shared、Gen、Main typecheck 通过。迁移验证使用独立 `localhost:5433/idream_test` 与 Redis DB15 测试命名空间。独立 root/source 与 Python 的 preflight 回归先红后绿。新安装 seed 仅标记 configuration/not_run，并链接历史资格记录；不会将本机测量伪装为新安装已验收。其专门 seed 回归 11 项通过。

恢复验证已完成：在 stage 1 第一次 progress 后，以 prompt UUID 定向中断，0.497 秒内进入 interrupted/error history 且队列空闲。随后同一 PID、不同 seed `2026082803/2026082804` 成功生成完整视频，耗时 461.418 秒（7分41秒）；stage 1 / stage 2 / VAE 为 138.740 / 272.109 / 40.173 秒。这是中断后的热进程恢复，不纳入新进程 A/B 提速百分比。

恢复任务确认原生 op **1,344 次成功返回**，与 1,344 次 dispatch 一致，fallback stats 为空。六种真实长 shape 的相对 RMSE 为 0.150%–0.171%，全部通过独立 FP64 参照。121 帧和 AAC 音轨完整解码，RMS 0.0893、peak 0.8367、无完全重复连续帧；六帧人工抽查保持人物、背景与挥手意图。prompt id 为 `9bbfa265-8ad9-4720-b99e-c0e5f7c5db80`。

## 原始证据与后续边界

证据保存在仓库忽略目录 `.scratch/ltx25-mpsgraph-20261002/`，没有以临时 `/tmp` 视频作唯一凭证：

- `split-a1/`、`mpsgraph-b1/`、`split-a2/`：视频、history、prompt id、图、完整 server log、分节点计时、媒体和 QKV 校验。
- `recovery-c1/`：隔离进程定向 interrupt 与同进程恢复，恢复延迟不混入新进程 A/B。
- `live-options/`：真实 8188 canonical Gen backend 的最小选项规格。
- `candidate-freeze.txt`、`assets.json`、`tested-source.json`、`mpsgraph-tested-source.json`：环境、资产和相关可执行文件 SHA。工作区另有并行任务，记录这些文件 hash 防止把后来代码当作先前已测版本。

下一轮应先测 fused attention 后的完整 block / FFN / GEMM 占比，再决定融合线性/激活算子。缩减 refine 步数和保存 stage-1 latent 续算是另一种有质量、缓存和产品契约的方案，不应静默替换现有正式配方。当前完成的是约分钟级增量优化，尚未把标准视频变为秒级交互。
