# RedCraft Identity 与 MiniMax H3 的 Mac 运行时修复

日期：2026-08-29  
机器：Apple M4 Max 128 GB / macOS 26.5.1 / PyTorch 2.13.0 / ComfyUI 0.34.2

## 结论

本轮最终采用两项精确修复：

1. RedCraft Identity workflow v4 保留 scaled-FP8 base、Identity Edit v1.2
   full LoRA strength 1、`ref_boost=4`、832×1216、8 steps；删除 pixel path
   下不会进入采样的重复 source `VAEEncode`。同 seed A/B 的解码 RGB
   **逐像素相等**，E2E 从 266.577 秒降到 213.595 秒，单次观测下降
   19.87%。
2. 图片、RedGraft/LTX、MiniMax H3 分别固定在 8189、8188、8190。
   H3 v3 在独立进程使用精确 PyTorch SDPA；RedGraft 继续使用已验证的
   split attention，配置与模型缓存互不覆盖。Gen 的 host-local accelerator
   lease 仍串行化真实 GPU 区间，避免三个进程同时争用统一内存。

BF16 与 SolAttn 都完成了真实 A/B，但没有进入默认路径：

- 预展开 BF16 只改善冷启动，热态反而慢 6.3%；
- SolAttn 在生产 512×512 / 124 帧 H3 上只省约 8 秒（约 1.2%），却让
  124 帧总体像素 RMSE 达到 10.57/255。收益不足以接受近似。

## 第一性原理边界

性能方案必须同时满足：

- 不降低 Identity full LoRA、strength、`ref_boost`、grounding 分辨率、输出
  分辨率或采样步数；
- RedGraft 的已验证数学路径不因图片或 H3 的优化发生改变；
- “进程隔离”只隔离配置、缓存和故障，不能虚构三块 GPU；统一内存上的
  生成仍需 accelerator lease 串行；
- 近似 attention 必须用同 checkpoint、同输入、同 seed、同生产包络做
  质量与速度双验收；
- 数据库 profile 只生成带 guard 与终态断言的 SQL，由 operator 手工执行。

## RedCraft：为什么“一次性离线 BF16”没有上线

这里的“离线”只是模型版本发布前的一次性构建，不是让产品断网或离线
运行。转换器把 scaled FP8 权重按原 scale 展开为 BF16，原子写入新文件，
保留原 FP8 源和标准 `LoraLoaderModelOnly`。这样不会重写 Identity LoRA
数学，也不会降低身份参数。

构建结果：

- FP8 source SHA-256：
  `f6088960c0febd27cbd372fc758bb07d012f2d8ae3cd10c45c903d48b94409ea`
- BF16 candidate SHA-256：
  `89d9a602b38421ea1540d675b5b7cdf3586e302aadef62d4559adfde0e17fa61`
- 256 个 scaled FP8 tensors 展开；512 个 quant sidecars 删除；输出 430 个
  tensors，0 个 FP8 tensor。

固定 832×1216 / 8 steps / `ref_boost=4`：

| 运行 | FP8 | BF16 | 结论 |
| --- | ---: | ---: | --- |
| cold，seed A | 270.881s | 249.091s | BF16 快 8.04% |
| warm，seed B | 235.649s | 250.536s | BF16 慢 6.32% |

M4 没有当前软件栈可用的 native FP8 GEMM；现有修复是 GPU LUT decode 后做
BF16 GEMM。[AppleSilicon-FP8](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8)
解决兼容性，但 BF16 文件把权重常驻/读取量从约 12 GB 增到约 24 GB。热态
内存带宽收益没有成立，所以 workflow v4 继续使用 FP8，BF16 只保留为未来
硬件或冷启动对照候选。

## RedCraft v4：删除重复 source VAE encode

`comfyui-krea2edit` 的 pixel path 在 patch node 中会按目标网格重新 fit 原图、
调用 VAE，并在每次 forward 中用缓存后的 pixel-path latent 覆盖 required
`source_latent`。旧图仍先执行一次普通 `LoadImage -> VAEEncode`，其结果随后
被覆盖。

v4 删除普通 node 6，把 required `source_latent` 接到目标空 latent，作为类型
正确的占位；真正的身份 source 仍由同一原图、同一 VAE、同一 `fit` 几何在
采样前编码。固定同 prompt / reference / seed `486071801727175`：

| 图 | E2E | RGB 对照 |
| --- | ---: | --- |
| 旧图，重复 VAE | 266.577s | baseline |
| v4，单 pixel-path VAE | 213.595s | RMSE 0 / max diff 0 |

两张 PNG 的 metadata/hash 不同，但 1216×832×3 RGB 完全一致。该结果证明
身份、成人指令、构图与像素输出没有变化；19.87% 是这一对运行的观测值，
MPS 有明显热漂移，不把单样本外推成长期 SLA。

## H3：隔离进程保留，SolAttn 默认撤下

[ComfyUI-SolAttn-MPS](https://github.com/yshenaw/ComfyUI-SolAttn-MPS) 官方建议
`tau=1.3 / start=0.2 / end=0.9 / min_tokens=4096`，并要求 H3 在 Apple
Silicon 使用 PyTorch SDPA。候选按该参数、同 20 GB INT8 ConvRot checkpoint、
同输入、同 prompt、同 numeric seed `1573094933`、512×512、124 帧、8 steps
运行：

| 路径 | Comfy prompt | sampler | 输出 |
| --- | ---: | ---: | --- |
| SolAttn | 655s | 567.9s | 124 帧 H.264 + AAC |
| exact PyTorch SDPA | 663s | 572.3s | 124 帧 H.264 + AAC |

SolAttn 只快约 1.2%，而两条视频的总体 RGB RMSE 为 10.57/255，最大单帧
RMSE 为 17.10/255（frame 48）。两条视频目检都保持人物与场景，但在当前
生产 token 规模下不值得用近似换 8 秒。因此最终 workflow v3 删除
`SolAttnPatch`，保留 8190 独立 exact-SDPA runner。插件仍可作为更高分辨率、
更长序列的研究候选，但不进入当前产品图。

## 修复的证据权威 bug

首个 v2 产品 probe 实际由 BackendRegistry 路由到 8190，probe report 却把
`backendTarget` 与模型根 attestation 写成 8188。生成本身正确，证据绑定错误。
现在 `probe-video-pipeline` 与 BackendRegistry 共用同一 descriptor→runner 规则，
并有回归测试保证 H3 证明 8190、RedGraft 证明 8188。

## 运行与数据边界

- 图片：8189，PyTorch attention，workflow v4；
- RedGraft/LTX：8188，原 split-attention 配置，未重启、未改图；
- H3：8190，exact PyTorch SDPA，workflow v3；
- BF16 candidate 与 SolAttn 安装保留但不被生产 descriptor 引用；
- operator-run SQL：
  - `db/sql/2026-08-29-redcraft-krea2-identity-fast-profile.sql`
  - `db/sql/2026-08-29-minimax-h3-isolated-runner-profile.sql`

本轮没有连接数据库、没有执行 SQL。

结构化运行证据位于：

- `.tmp/redcraft-krea2-v4-ab-duplicate-vae.json`
- `.tmp/redcraft-krea2-v4-ab-single-vae.json`
- `.tmp/h3-solattn-v2/report.json`
- `.tmp/h3-solattn-v2/exact-report.json`
- `.tmp/h3-solattn-v2/review/solattn-contact.jpg`
- `.tmp/h3-solattn-v2/review/exact-contact.jpg`
