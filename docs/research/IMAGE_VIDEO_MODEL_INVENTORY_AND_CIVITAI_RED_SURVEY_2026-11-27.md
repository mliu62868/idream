# 现用图片 / 视频生成模型盘点与 Civitai Red 候选调研

- **核验时间**：2026-11-27 20:51（美国太平洋时间，UTC `2026-11-28T04:51Z`）
- **来源**：仓库现行工作流描述符、生产配方与 seed 配置（只读静态核对）＋ `civitai.red` 公开匿名 API v1（`/api/v1/enums`、`/api/v1/models`、`/api/v1/models/:id`、`/api/v1/model-versions/:id`）
- **适用期限与证据边界**：本文为只读目录与元数据调研，**未下载新权重，未在本地 M4 Max / ComfyUI MPS 上执行推理、画质对比或交付验证，也不构成商业许可法务结论**。`civitai.red` 模型版本与榜单更新频繁，超过 2～4 周或正式下载验证前应重新复核最新版本号、文件哈希与商业授权条款。

## 结论摘要

1. **现用图片与视频权重本身在原条目下均无新版**。当前图片主力 `RedCraft 3.0 (FixQW21T)` / `FineView QW21 Turbo Fixed` 仍停留在 `2026-10-15`；默认视频 LoRA `[MMH3] Mystic XXX` 最新仍为 `v5.0`（`2026-10-19`）；多镜头视频 `RedGraft LTX 2.5` 仍为 `2026-08-21` 版本。
2. **视频侧（MiniMax H3）是当前最直接、回报最高的升级验证方向**。11 月 `civitai.red` 在 MiniMax H3 生态爆发，出现了多款自带 8 步 Turbo、原生提供 `int8_convrot` 的头部融合底模（如 **H3 Eros Max v1.0**、**TriPRISM-TurboFusion**、**DaSiWa GXS v5**、**FL2VA Refusion Turbo V3.0**）以及高下载量 NSFW / 质量 / 口型 LoRA（**HMNSFW V3**、**H3 NSFW Unlocked V3**、**H3 VBVR Pro V2**、**Natural Face & Speech**），均可直接复用现有 `8190` H3 runner 做配对 A/B。
3. **图片侧分短期与中长期两条线**：
   - **短期（复用现有 `8189` Qwen 2.1）**：可对照测试 **Aisha NSFW [Qwen 2.1 Turbo] v5.2**（允许商用）与 **Qwen-Image-2.1-Uncensored-Omni**（注意其 Civitai 商用位为空，仅先作基线参考），并测试为现用多参考路由叠加 **BFS - Best Face Swap (Qwen 2.1 Head Swap v1.1)** 以改善源图换脸漂移。
   - **中长期下一代底座**：重点关注 11 月刚开源的 **MiniMax H3 Image**（单模型支持文生图＋最多 16 张参考图编辑＋6~8 步 CFG 1，编码器与 H3 视频同系，且原作者 `AiMeASOP` 于 `11-27` 刚发布 **DarkBeast 7X REF2i**）；若未来计划增加轻量极速文生图档或二次元专线，可分别评估 **MOSS Image**（INT8 约 4.7~5.0 GB）和 **Anima 2.9B**。
   - **Flux.3 Klein**：与 3 天前的专项调研结论一致，目前公开目录仍以官方底模＋LoRA 为主，无成人向完整微调 Checkpoint，暂不替代主力（见 [FLUX3_KLEIN_CIVITAI_RED_NSFW_RESEARCH_2026-11-24.md](FLUX3_KLEIN_CIVITAI_RED_NSFW_RESEARCH_2026-11-24.md)）。

---

## 一、iDream 现用生成模型盘点

### 1. 图片生成模型

根据 [packages/gen/README.md](../../packages/gen/README.md)、[packages/gen/src/preflight.ts](../../packages/gen/src/preflight.ts) 与 [packages/main/prisma/seed.ts](../../packages/main/prisma/seed.ts)，全部 5 个激活的生图/编辑 Profile 与 4 条 ComfyUI 工作流均统一到同一套 **Qwen-Image 2.1** 物理权重，运行在 `8189` image runner（PyTorch attention）：

| 维度 | 当前配置 |
| --- | --- |
| **扩散权重** | `diffusion_models/fineview_qw21_turbo_fixed_int8.safetensors`（SHA-256 `712b44d2…`）；对应 Civitai [RedCraft 3.0 FixQW21T](https://civitai.red/models/958009?modelVersionId=3407259)（`958009` v`3407259`）与 [FineView QW21 Turbo Fixed](https://civitai.red/models/3003597?modelVersionId=3407540)（`3003597` v`3407540`），两者同哈希，发布于 `2026-10-15` |
| **文本编码器 / VAE** | `text_encoders/qwen3vl_8b_int8_convrot.safetensors`（MPS）＋ `vae/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors` |
| **推理与采样配方** | `IDreamQwen21ResidentWeights` 常驻 BF16（约 13.3 GiB）；固定 6 步 `er_sde/simple`、CFG 1、AuraFlow shift 1.31、无 LoRA |
| **工作流路由** | [redcraft-qw21t.json](../../packages/gen/workflows/redcraft-qw21t.json)（v3，默认 832×1024 T2I 与单参考）、[qwen-image-edit-img2img.json](../../packages/gen/workflows/qwen-image-edit-img2img.json)（v6，单图编辑与单参考重排）、[qwen-image-edit-multi-identity.json](../../packages/gen/workflows/qwen-image-edit-multi-identity.json)（v7，身份＋造型）、[qwen-image-edit-multi-reference.json](../../packages/gen/workflows/qwen-image-edit-multi-reference.json)（v8，源图＋身份变体；文档记录源图换脸仍易保留源脸，尚未通过换脸定型） |
| **辅助 / 备选路由** | [realesrgan-x2plus-enhance.json](../../packages/gen/workflows/realesrgan-x2plus-enhance.json)（RealESRGAN 2× 放大）、[local-recolor.json](../../packages/gen/workflows/local-recolor.json)（SAM3 局部重着色）、[pornmaster-zimage-drawthings-txt2img.json](../../packages/gen/workflows/pornmaster-zimage-drawthings-txt2img.json)（Draw Things 备选，`pornmasterzimage_turbov35bf16_f16.ckpt`，对应 [PornMaster Z-Image](https://civitai.red/models/2270401?modelVersionId=2903129)，仍停留在 `2026-05-14`） |

**原条目更新检查（`2026-11-27`）**：RedCraft（`958009`）与 FineView QWEN（`3003597`）在 Qwen 2.1 上无更新版本；原作者 `AiMeASOP` 近期新作已转向 **MOSS Image**（[FineView MOSS 5](https://civitai.red/models/3007993?modelVersionId=3469168)）与 **MiniMax H3 Image**（[DarkBeast 7X REF2i](https://civitai.red/models/2242173?modelVersionId=3490415)）。历史升级复核见 [IMAGE_MODEL_UPGRADE_REVIEW_2026-10-23.md](IMAGE_MODEL_UPGRADE_REVIEW_2026-10-23.md)。

### 2. 视频生成模型

根据 [packages/shared/src/admin/contracts/creative.ts](../../packages/shared/src/admin/contracts/creative.ts) 与 [packages/gen/src/backend/production-video-descriptor.ts](../../packages/gen/src/backend/production-video-descriptor.ts)，目前两条生产视频路线均要求单张首帧 `source_image` 并输出带音频 MP4：

| 路线 | 工作流与端口 | 权重与采样配方 | 输出规格与 M4 Max 基线 | 原条目更新检查 |
| --- | --- | --- | --- | --- |
| **默认视频 (`profile_video_h3_v1`, v6)** | [minimax-h3-mystic-i2v.json](../../packages/gen/workflows/minimax-h3-mystic-i2v.json)（v5，端口 `8190`，精确 PyTorch SDPA） | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` ＋ `MysticXXX_MMH3-V5.safetensors`（[Civitai `2856467` v`3416478`](https://civitai.red/models/2856467?modelVersionId=3416478)）＋ `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`（均强度 1.0）；`qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf`＋视频/音频 VAE；8 步 `euler/simple`、CFG 1、shift 12/3 | 512×512、124 帧 / 5.167s、24fps＋音频；历史直测约 667.4s（其中 8 步采样约 565s） | `[MMH3] Mystic XXX` 最新仍为 `v5.0`（`2026-10-19`），无 v6；但 H3 生态整体已有大量新底模与新 LoRA |
| **多镜头 / 显式选项 (`profile_video_redgraft_ltx25_v1`, v8/v9)** | [redgraft-ltx25-i2v.json](../../packages/gen/workflows/redgraft-ltx25-i2v.json)（v5，端口 `8188`，ComfyUI 0.34.2 / MPSGraph BF16） | `redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors`（[Civitai `1295569` v`3250230`](https://civitai.red/models/1295569?modelVersionId=3250230)，`2026-08-21`）；`gemma4-12b-ltx-v1-mlx-q8`＋`ltx-2.5` 音视频 VAE＋`ltx-2.3-spatial-upscaler-x2-1.1`；8＋3 步 `euler/manual_sigmas`、CFG 1 | 默认 448×768（7:12 480p preview；标准档 896×1536）、121 帧 / 5.042s、24fps＋音频；480p 原生样本约 210.6s | `RedGraft LTX 2.5` 无更新版本，LTX 2.5 社区新 Checkpoint 稀少 |

---

## 二、Civitai Red 候选模型调研（2026-11-27 快照）

### 1. 图片模型候选

#### A. 新一代多参考全能底座：`MiniMax H3 Image`（2026-11 开源）

官方模型卡描述其单模型统一文生图与图像编辑、最多支持 **16 张参考图**、原生输出最高约 16MP（4096×4096），推荐 6~8 步 CFG 1，文本编码器同属 **Qwen3-VL-32B MiniMax H3** 体系。主要工程权衡是 DiT 体量明显大于 Qwen 2.1（INT8 约 19.5~21 GB，INT6 约 15.6 GB，W4A8 约 11.7~12.8 GB），在 M4 Max 上需实测内存占用与单图耗时。

| 模型 | 作者 / 版本 / 日期 | 下载量 | 权重格式与体量 | Civitai 商用位 | 关注点 |
| --- | --- | ---: | --- | --- | --- |
| [**DarkBeast 7X \| 黑兽 (`REF2i`)**](https://civitai.red/models/2242173?modelVersionId=3490415) | `AiMeASOP` / v`3490415` / `11-27` | 179,616（系列累计） | `int8-pruned` 20.97 GB、`fp8` 19.52 GB、`bf16` 37.46 GB | `Image, RentCivit, Rent, Sell, SellMerge` | 与现用 RedCraft 同作者；主打单参考图原生 In-Context 锁脸＋8 步 Euler CFG 1 直出（标有 💰 需 Buzz 解锁） |
| [**MiniMax H3 Image 官方底模**](https://civitai.red/models/3045541?modelVersionId=3463368) | `CivitaiOfficial` / v`3463368` / `11-13` | 2,417 | `bf16` 37.47 GB、`w4a8` 11.69 GB、VAE 1.09 GB、`qwen3vl_32b_int8_convrot` 25.28 GB | `Image, RentCivit, Rent, Sell, SellMerge` | 官方基线与原配组件参考 |
| [**Minimax H3 Image INT8/INT6/INT4**](https://civitai.red/models/3045867?modelVersionId=3462708) | `tsolful` / v`3462708` / `11-10` | 2,132 | `INT8` 19.54 GB、`W6A8` 15.61 GB、`W4A8` 12.77 GB | `Image, RentCivit, Rent, Sell, SellMerge` | 作者给 6 步 CFG 1 PDD / LCM 配方，适合测 M4 内存与速度曲线 |
| [**Minimax Image FinalCut**](https://civitai.red/models/3065831?modelVersionId=3490699) | `Felldude` / v`3490699` / `11-27` | 246 | `int8_convrot` 19.51 GB | `Image, RentCivit` | 电影摄影质感全量微调，已直接提供 INT8 ConvRot |

- **11 月配套 H3 Image 热门 LoRA**：[`BFS - Best Face Swap`](https://civitai.red/models/2027766?modelVersionId=3479493)（v`3479493`，`11-19`）、[`MiniMax H3 Image - Real Pussy`](https://civitai.red/models/3054468?modelVersionId=3481871)（5.4k 下载，`11-21`）、[`Breast Size Slider`](https://civitai.red/models/3052536?modelVersionId=3481750)（3.5k 下载）、[`Natural Breasts`](https://civitai.red/models/3052751?modelVersionId=3479415)（3.4k 下载）、[`Female Anatomy`](https://civitai.red/models/3062815?modelVersionId=3490230)（2k 下载，`11-26`）、[`Amateur nudes`](https://civitai.red/models/764517?modelVersionId=3487436)（`11-24`）。

#### B. 同底座零架构改动候选：`Qwen 2.1`（直接复用 `8189`）

| 类型 | 模型 | 作者 / 版本 / 日期 | 下载量 | 权重格式 / 商用位 | 关注点 |
| --- | --- | --- | ---: | --- | --- |
| Checkpoint | [**Aisha 💜 NSFW [Qwen 2.1 Turbo]**](https://civitai.red/models/3009275?modelVersionId=3485319) | `AishaAI` / `v5.2 [Release]` / `11-23` | 2,503 | BF16 13.25 GB（作者 HF 另提供 INT8 ConvRot）；商用位全开 | 近期最活跃的 Qwen 2.1 Turbo NSFW 微调，同时训练了 T2I 与 I2I |
| Checkpoint | [**Qwen-Image-2.1-Uncensored-Omni-Quantized**](https://civitai.red/models/3034876?modelVersionId=3448331) | `chatrlabs` / `v1.0 Step 90K` / `11-05` | 5,895 | 同版本打包 9 种精度含 `INT8 ConvRot` / `FP8` / `GGUF`；⚠️ **`commercial=[]`** | 11 月 Qwen 2.1 下载最高的新无审查生图＋编辑权重；商用权限为空，仅建议先作画质/NSFW 基线对照 |
| LoRA | [**BFS - Best Face Swap (Qwen 2.1 Head Swap v1.1)**](https://civitai.red/models/2027766?modelVersionId=3356102) | `NRDX` / v`3356102` / `09-25` | 9,609（版本） | — | 针对性测试改善现用 `qwen-image-edit-multi-reference` 源图换脸保留度不足的问题 |
| LoRA | [**NSFW LORA \| Qwen Image 2.1 v2.0**](https://civitai.red/models/2958918?modelVersionId=3357315) | `TheseAlpacas` / v`3357315` / `09-25` | 55,799 | — | Qwen 2.1 下载量第一的 NSFW LoRA |
| LoRA | [**Qwen Image 2.1 Consistency LoRA**](https://civitai.red/models/2969143?modelVersionId=3364470) | `AusBoss` / v`3364470` / `09-27` | 10,144 | — | 角色一致性增强 LoRA 候选 |

#### C. 11 月高热度专项架构（轻量极速 T2I 与二次元专线）

- **`MOSS Image`（写实极速 T2I 新秀）**：11 月 `civitai.red` 写实 NSFW 增长最快，**`int8_convrot` 仅 4.7~5.0 GB**，在 M4 Max 上会非常轻快；但偏纯 T2I，是否具备满足 iDream 的多参考锁脸能力尚待核验。头部条目：
  - [Dirty-Moss V2](https://civitai.red/models/3015644?modelVersionId=3473330)（30.2k 下载，`11-15`）
  - [Realism By Stable Yogi Moss v2.0 INT8](https://civitai.red/models/3014108?modelVersionId=3463024)（26.6k 下载，`11-18`）
  - [PornMaster 色情大師 Moss MIX_V3](https://civitai.red/models/3008033?modelVersionId=3486789)（26.5k 下载，`11-24`，`int8_convrot` 5.04 GB，`commercial=['Image','RentCivit']`）
  - [Moody Moss Mix V6.0](https://civitai.red/models/3007871?modelVersionId=3486581)（24.5k 下载，`11-24`，`int8_convrot` 4.74 GB，`commercial=['RentCivit']`）
  - [FineView 欢视 \| MOSS 5](https://civitai.red/models/3007993?modelVersionId=3469168)（6.5k 下载，`11-14`，`AiMeASOP`）
- **`Anima (2.9B)`（二次元 / 动漫角色候选）**：11 月在动漫榜与 `Illustrious` 分庭抗礼，体量小且更新密集。头部条目：[Nova Anime AM v7.0 (2.9B)](https://civitai.red/models/2604424?modelVersionId=3462792)（69.9k 下载）、[One obsession_Anima v5.0](https://civitai.red/models/2695493?modelVersionId=3443487)（52.9k 下载）、[Mistoon_Anime (Anima)](https://civitai.red/models/24149?modelVersionId=3441147)（233.7k 下载）、[AnimaIka v5.2](https://civitai.red/models/2426265?modelVersionId=3491574)（34.0k 下载，`11-27`）。
- **`Krea 2 / Turbo` 与 `Flux.3 Klein`**：Krea 2 在纯 T2I 仍极活跃（[FinePorn v7](https://civitai.red/models/2762538?modelVersionId=3491567)、[Moody Krea 2 Mix](https://civitai.red/models/2731187?modelVersionId=3467842)、[SNOFS Merged](https://civitai.red/models/2416142?modelVersionId=3474402)），但项目已为统一编辑链路主动退役 Krea；Flux.3 Klein 现状见 [FLUX3_KLEIN_CIVITAI_RED_NSFW_RESEARCH_2026-11-24.md](FLUX3_KLEIN_CIVITAI_RED_NSFW_RESEARCH_2026-11-24.md)。

---

### 2. 视频模型候选

#### A. `MiniMax H3`（直接复用现有 `8190` runner，11 月最大增量）

**一体融合底模（大多内置 8 步 Turbo 并原生提供 `int8_convrot`）**：

| 模型 | 作者 / 最新版本 / 日期 | 下载量 | 关键量化文件与体量 | Civitai 商用位 | 特点与适配判断 |
| --- | --- | ---: | --- | --- | --- |
| [**H3 Eros Max**](https://civitai.red/models/2851079?modelVersionId=3481735) | `tenstrip` / `v1.0` / `11-21` | 89,631 | `hybrid-int8_HQ` 21.32 GB、`ref2va_orthfix_int8` 18.81 GB、`ref2va_w3_Micro` 9.31 GB | `Image, RentCivit` | H3 头部 NSFW 融合底模，内置 8 步 Turbo，主打 I2V 输入忠实度与音画质量（作者建议 LCM 采样） |
| [**⛩️💀 DaSiWa MiniMax H3 💀⛩️**](https://civitai.red/models/2877206?modelVersionId=3457966) | `Darksidewalker` / `GXS v5` & `Turbo` / `11-08` | 87,576 | `int8_row-wise_convrot` 19.53 GB、`w6a8` 15.60 GB、`w4a8` 11.68 GB | `Image, RentCivit, Rent` | 口碑极高的通用写实/动态融合底模（Turbo 支持 6~8 步）；作者未专门做越狱 NSFW，适合搭配 NSFW LoRA |
| [**Singularity-V2-x-10Eros-Max**](https://civitai.red/models/3019421?modelVersionId=3488344) | `0l1v1aR0551` / `TriPRISM-TurboFusion` / `11-25` | 23,155 | `int8_convrot` 19.61 GB、**`h3tiny17b_int8_convrot` 16.00 GB**、`w6a8` 14.97 GB | `Image, RentCivit` | PRISM 谱融合 Sulphur3 ＋ 10Eros-Max ＋ SingularityV2 ＋ LightX2V TurboFusion，针对性修复油腻肤质；`h3tiny17b` 值得测试 M4 提速 |
| [**MiniMax H3 – FL2VA Refusion**](https://civitai.red/models/2900456?modelVersionId=3489800) | `Aki7777777` / `Turbo V3.0_RefGate_P-INT8` / `11-26` | 12,609 | `INT8` 19.77 GB、`BF16` 37.71 GB | `Image, RentCivit, Rent` | 保持 FL2VA LoRA 兼容性同时融合 Ref 能力，主打减轻画面模糊与长序列稳定 |
| [**Ultima NSFW Hybrid Turbo int8-convrot**](https://civitai.red/models/3047487?modelVersionId=3474446) | `OmegaWPN` / `Level 120` / `11-16` | 2,666 | `int8-convrot` 19.53 GB | `Image, RentCivit` | 纯 NSFW 导向的一体化 INT8 ConvRot Turbo 底模（Level 99 免费，Level 120 需满足点赞解锁） |

**可与现用官方 FL2VA 底模配对测试的 H3 热门 LoRA**：

| 模型 | 作者 / 版本 / 日期 | 下载量 | 体量 / 商用位 | 作用与测试目标 |
| --- | --- | ---: | --- | --- |
| [**HMNSFW - AIO Sex LoRA**](https://civitai.red/models/2834417?modelVersionId=3446189) | `HearmemanAI` / `V3 - Extreme Realism` / `11-02` | 96,321 | 0.58 GB fp32；`Image, RentCivit, Rent` | H3 下载第一的 NSFW LoRA（兼容 Turbo LoRA），直接对标现用 `Mystic V5` |
| [**MiniMax H3 NSFW Unlocked**](https://civitai.red/models/2925727?modelVersionId=3478361) | `The_Midnight_Lab` / `V3` (`11-07`) & `V3.1_B` (`11-18`) | 87,673 | 0.14~0.56 GB fp32；`Image, RentCivit` | 主打解除护栏与高分辨率动作细节 |
| [**H3 - LTX 2.3 - Video Reasoning LoRA VBVR**](https://civitai.red/models/2497207?modelVersionId=3449495) | `MisticRain69` / `H3 VBVR Pro V2` / `11-03` | 86,630 | 1.16 GB bf16；**商用位全开**（作者明确允许商用/服务运行/融合） | 提升复杂提示词遵循与物理推理连贯性 |
| [**Better Human Motion H3/LTX 2.5**](https://civitai.red/models/2734359?modelVersionId=3256084) | `AdaptiveVision` / `v1.0-MH3` / `08-22` | 20,689 | 0.29 GB bf16；`Image, RentCivit, Rent` | 改善人体自然动作与时序连贯性（推荐权重 0.4~0.8） |
| [**Natural Face & Speech H3/LTX 2.5**](https://civitai.red/models/2925394?modelVersionId=3339123) | `AdaptiveVision` / `v2.0-MH3` / `09-19` | 6,303 | 0.29 GB bf16；`Image, RentCivit, Rent` | 改善面部微表情与英语口型同步，高度契合 AI 伴侣对话视频 |

#### B. `LTX 2.5` 与其他视频底座

- **LTX 2.5（`8188` 路线）**：[RedGraft LTX 2.5](https://civitai.red/models/1295569?modelVersionId=3250230) 仍是 LTX 2.5 上下载量最高的 NSFW Checkpoint（12.4k 版本下载）；备选 NSFW 混模有 [LTX2.5_Stubelius Remix [NSFW]](https://civitai.red/models/2915609?modelVersionId=3395164)（`10-09`，3.1k 下载，带 INT8）。11 月新增的可用 LoRA 为 [Better Human Motion v1.0-LTX2.5](https://civitai.red/models/2734359?modelVersionId=3448611)（`11-03`）与 [Natural Face & Speech v1.0-LTX2.5](https://civitai.red/models/2925394?modelVersionId=3451242)（`11-04`）；`11-27` 另有实验性量化 [LTX-2.5 QuantFunc A4W4 INT4](https://civitai.red/models/3066766?modelVersionId=3491893)，MPS 兼容性与画质未知。
- **其他视频架构**：`Wan Video 2.5 / 2.7 / 3.0` 与 `Flux 3 Video` 在 `civitai.red` 上几乎只有 API / 云端工作流条目，缺乏本地开源自托管 NSFW 权重生态；`Wan 2.2 I2V-A14B` 与 `Hunyuan Video` 的社区活跃度与音画一体化能力已明显落后于 MiniMax H3，当前不建议为其另起本地管线。

---

## 三、建议的受控验证顺序

执行配对对比时，保持固定角色首帧/参考图、最终编码提示词、输出分辨率、帧率与随机种子，同时记录权重 SHA-256、M4 Max 冷启动与稳态耗时、峰值物理内存及音频同步/面部身份保持情况：

1. **第一优先级（视频 `8190` MiniMax H3，零新底座风险）**：
   - 保留现有 `minimax_h3_fl2va_pruned_int8_convrot`＋`Turbo 8-step`，将 `Mystic V5` 与 `HMNSFW V3 Extreme Realism`（`3446189`）和 `H3 NSFW Unlocked V3`（`3446226`）做配对，并测试叠加 `H3 VBVR Pro V2` / `Natural Face & Speech v2.0`。
   - 对比一体融合底模 `H3 Eros Max v1.0`（`3481735`）与 `TriPRISM-TurboFusion`（`3488344`，重点测 `h3tiny17b_int8_convrot` 相对当前 667s 基线的提速幅度）。
2. **第二优先级（图片 `8189` Qwen 2.1，低成本微调）**：
   - 将 `Aisha NSFW [Qwen 2.1 Turbo] v5.2`（`3485319`）与现用 RedCraft 6 步做配对（含成年 NSFW 与人物一致性）。
   - 在 `qwen-image-edit-multi-reference` 上测试叠加 `BFS - Best Face Swap (Qwen 2.1 Head Swap v1.1)`，验证是否能解决源图换脸保留源脸的问题。
3. **第三优先级（图片下一代底座 PoC）**：
   - 评估 **MiniMax H3 Image**（官方 INT8/INT6 量化及 `DarkBeast 7X REF2i`）在 M4 Max 上的显存驻留、单图延迟及多参考锁脸能力。
   - 若产品规划拆分「纯文生图极速档」或「二次元角色专线」，再分别单独立项测试 **MOSS Image** 与 **Anima 2.9B**。
