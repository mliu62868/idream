# LTX 2.5 图生视频：VAE 解码加速

日期：2026-10-02。本轮实现并启用了模型局部的 MPS VAE 卷积加速。
实际服务的 Torch 2.10 环境中，同一 latent 的纯视频解码从199.88s
降到32.16s，约6.22倍，节省167.72s；原生 Comfy 节点重放为32.17s。
验证范围是同一最终 latent 的逐帧解码对比，以及真实 Comfy 服务的
视频/音频解码、CreateVideo、SaveVideo。没有重新采样、经过产品 BFF、
持久化或扣减额度，不能把这里的解码耗时称为完整图生视频耗时。

## 结论与实现

瓶颈是 MPS 上当前 VAE 的 Conv3D 执行。把每个三维卷积写成沿时间维的
Conv2D 求和，保留外层时间缓存和分块融合，显著减少 GPU 时间。
这是同一组 BF16 权重的运算重排，存在舍入差异，并非逐像素无损。

[实现](../../packages/gen/comfyui_nodes/idream_ltx25_mps_vae/acceleration.py)
只识别已测试的 LTX 2.5 卷积 VAE 配置，修改 decoder 的 42 个卷积模块。
替换点是 `_conv_forward`，因此保留 Comfy 的动态权重加载、casting 和
权重函数。其他 VAE、encoder、CPU/CUDA、autopad 等路径使用原计算。
每个时间窗口以 64M 个元素限制批量大小。

插件通过现有 `comfy-extra-models-idream.yaml` 的 canonical `custom_nodes`
目录自动加载。无需额外依赖、安装器或新模型；workflow v2 的节点、
分块大小、采样、输入输出绑定与模型 SHA-256 均未改动。
图 fingerprint 不变不表示执行源码相同：新的发布证据仍需绑定包含
本插件的 Gen source revision，不能重新标记历史 TerminalRecord。

## 固定输入和版本

- M4 Max，40 GPU cores，128GB；ComfyUI 0.34.2。
- 复用上一轮实际 RedGraft 采样保存的 video `[1,128,16,36,24]`、
  audio `[1,8,126,16]`，均为 CPU float32 的有限值。
- 输出 768×1152，121 帧，24fps；分块 480、overlap 96、
  temporal size 96、temporal overlap 24。
- 视频 VAE `ltx-2.5-video-vae-conv-bf16.safetensors`，SHA-256
  `685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d`。
- 音频 VAE SHA-256
  `c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5`。
- Comfy checkout `c645560264062e6a5b0688d25eaf3ee9906a7709`。
  实验开始的项目 HEAD `63d14aec2d20144dbaaeed93bc2a2f9bb62e25be`；
  工作树有其他任务修改，不将本轮称为项目整体 release 验收。
- 隔离 Python 使用 Torch 2.13.0、kitchen 0.2.31；实际 8188 服务
  使用 Torch 2.10.0、kitchen 0.2.36。两种 runtime 分开记录。
- GPU 工作经实际 `withGenerationAcceleratorLease` 串行；先核对
  8188/8189/8190 队列为空，再清理闲置模型缓存。

## 隔离同 runtime 对比（Torch 2.13）

| 方案 | 纯视频 decode | 原始 RGB 逐帧比较 | 状态 |
| --- | ---: | --- | --- |
| 原 Comfy 480/96 分块 | 220.75s | 参考 | 实测 |
| 仅扩大空间 tile 到1152 | 142.48s | 平均SSIM 0.99903 | 保留实验 |
| MLX 单块 decode | 9.23s | 平均SSIM 0.99791 | 保留实验 |
| MLX 复用原 Comfy 分块/融合 | 16.32s | 平均SSIM 0.99931 | 保留实验 |
| 正式 MPS 插件，原分块/融合 | 32.13s | 平均SSIM 0.99955 | 已启用 |

正式插件减少纯 decode 时间 85.4%，约6.87倍。MLX 是0.32.2、原始
BF16 VAE，使用上一轮固定 WeeTodd 与 ltx-core-mlx 源码；没有 DiT 再量化
或不同随机数干扰这个比较。正式 MPS 路线使用现有运行环境，保留当前
分块规则；MLX 相比这条路线多节省约16秒，尚未接入默认服务。

SSIM 是全部121帧的 RGB 每三像素采样后计算，尺寸256×384。
全分辨率逐帧 RMSE 最大0.001890，平均0.001472（像素范围0–1），
平均PSNR 56.68dB。事先设置的 gate 为最大帧RMSE≤0.01、平均SSIM≥0.99、
最小SSIM≥0.97，正式插件最小SSIM 0.999376，全部通过。
接触表已查看首帧、每秒、末帧与误差最大帧：身份和动作连续，
没有黑/绿/冻结片或明显分块交界。没有重新评价台词逐字准确率或口型。

## 实际服务同 runtime 对比（Torch 2.10）

使用当前8188服务的 Python/Torch 环境，保持同一 latent、VAE BF16权重和
480/96分块设置，在独立进程中分别重放原计算和正式插件。

| 方案 | 纯视频 decode | 与原计算的比较 |
| --- | ---: | --- |
| 原 Comfy 480/96 分块 | 199.88s | 参考 |
| 正式 MPS 插件，原分块/融合 | 32.16s | 平均SSIM 0.999546 |

减少纯 decode 时间83.9%，约6.22倍，节省167.72s（约2.8分钟）。
与上面的 Torch 2.13 结果分别计算，不跨 runtime 比较倍率。
全分辨率121帧RMSE平均0.001472、最大0.001914，平均PSNR 56.69dB；
每帧每三像素采样后的SSIM平均0.999546、最小0.999374，全部通过同一质量门槛。
对照接触表已查看首帧、每秒、末帧和最大误差帧，没有明显分块交界或损坏。
这是一组已采样输入的解码验证；未宣称覆盖所有内容、尺寸或长视频。

## 真实 Comfy 服务重放

通过项目 `bun run comfyui:restart` wrapper 重启，使用原生 LoadLatent
读取同一 video/audio，接回原 VAELoader、VAEDecodeTiled、
LTXVAudioVAEDecode、CreateVideo、SaveVideo 子图。缓存记录为空。

- prompt：`ebe2ebe7-4646-40d5-bbbe-5ad3e88355fd`。
- 视频 decode：32.17s；音频decode：1.00s；SaveVideo：1.22s。
- 整个保存 latent 的重放：35.64s。**此边界不包含文本编码和采样。**
- 日志确认当前 VAE 命中42个模型局部 MPS Conv2D depth kernels。
- 实际服务进程物理 peak 为20GB，含音视频组件和服务开销；
  不是完整采样链路的峰值。插件隔离重放结束时 MPS driver allocated
  约12.24GiB，也不是峰值，两种指标不能混用。
- MP4：H.264，768×1152，24fps，121帧，5.041667s；
  AAC，48kHz双声道，5.010s。
- MP4 全量解码无错误；音轨mean -21.5dB、peak -2.0dB，非静音。
- 重放使用的两份共享输入 latent fixture 已清理；原始输入及本地实验产物保留。

## 回归与失败样本

7项测试覆盖独立CPU float64卷积参考、小窗口、空间stride、有效权重参数、
原CPU结果、encoder与其他VAE保留、constructor重复安装，以及真实MPS
FP32/BF16非连续权重切片。Torch2.13与实际Torch2.10环境均通过，未跳过MPS。

首次 MPS 原型未把 `weight[:,:,depth]` 转为连续4-D kernel，画面损坏，
SSIM约0.0086，明确未采纳。保留独立小规模 repro：八种 input/weight/output
连续布局组合证明只有 weight slice 的连续性决定这次错误。
FP32 RMSE 从0.733降到约2.1e-7。修复放入回归测试，不放宽质量门槛。

动态权重入口也保留；但单独调整这个入口没有修复布局错误，不把它
记为本次损坏的根因。原型与失败记录都在明确标记的 `.scratch` 实验目录。

## 可复核产物

- [完整实验目录](../../.scratch/ltx25-vae-optimization-20261002/)
- [原始baseline](../../.scratch/ltx25-vae-optimization-20261002/stock480-report.json)
- [正式插件报告](../../.scratch/ltx25-vae-optimization-20261002/mps_plugin-report.json)
- [全121帧误差](../../.scratch/ltx25-vae-optimization-20261002/stock480-vs-mps_plugin.json)
- [对照接触表](../../.scratch/ltx25-vae-optimization-20261002/stock480-vs-mps_plugin.jpg)
- [Torch2.10原始baseline](../../.scratch/ltx25-vae-optimization-20261002/live_stock480-report.json)
- [Torch2.10正式插件](../../.scratch/ltx25-vae-optimization-20261002/live_plugin-report.json)
- [Torch2.10全121帧误差](../../.scratch/ltx25-vae-optimization-20261002/live_stock480-vs-live_plugin.json)
- [Torch2.10对照接触表](../../.scratch/ltx25-vae-optimization-20261002/live_stock480-vs-live_plugin.jpg)
- [实际服务报告](../../.scratch/ltx25-vae-optimization-20261002/backend-report.json)
- [实际服务history](../../.scratch/ltx25-vae-optimization-20261002/backend-history.json)
- [实际MP4](../../.scratch/ltx25-vae-optimization-20261002/backend-replay.mp4)
- [权重/实现checksum](../../.scratch/ltx25-vae-optimization-20261002/checksums.txt)
