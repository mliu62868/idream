# LTX-2.3 GTAnimation INT4 ConvRot 使用评估

日期：2026-07-25
目标：Civitai model `1295569` / modelVersion `3143864`
范围：精确文件、图生视频能力、ComfyUI 依赖、M4 Max/MPS 实跑、内存/耗时、许可和 iDream 当前接入边界。先在隔离候选目录完成 exact 权重验证，随后按用户决定将同一模型提升为 iDream 的受控生产 I2V 路由，并完成浏览器到 Gallery 播放的真实闭环。

## 结论

1. **支持图生视频，而且作者样片就是 I2V。** 目标版本的 MP4 内嵌工作流名为 `Image to Video (LTX-2.3)`，用 `LoadImage` 把单图注入 `LTXVImgToVideoInplace`；LTX-2.3 和 ComfyUI 官方也明确提供 I2V、首尾帧插值、图像+音频等原生工作流。
2. **这个下载不是“一文件即用”的完整 checkpoint。** Civitai 把资源类型标成 `Checkpoint`，但作者样片实际用 `UNETLoader` 加载它；Gemma 文本编码器、LTX text projection、视频/音频 VAE 和 x2 latent upscaler 都是独立依赖。按样片的 exact 组件，磁盘权重合计约 **33.54 GiB**。
3. **INT4 / API `fp=int8` 疑点已经由 exact 文件解决。** 完整文件 SHA-256 与作者值一致；safetensors `_quantization_metadata` 明确写有 `format=convrot_w4a4`，5,872 个 tensor 的布局为 F32/BF16/I8 混合。Civitai API 的 `fp=int8` 不能代表实际计算格式；该文件已验证为 W4A4 ConvRot。
4. **“12G 可跑”只是作者的 weight swapping 声明，不是 LTX 官方门槛。** 作者称 22GB 可完整加载、12GB 可换权运行；Lightricks 的开源文档仍给出 NVIDIA 32GB+ VRAM 的最低配置。12GB 方案需要用 exact workflow 在 exact GPU 上实测峰值和 OOM，不能由文件大小推导。
5. **“25 frames in 5s”不是完整 6 秒成片耗时证明。** 作者没有给 GPU、分辨率、冷/热状态和计时范围。样片是 768×1152、6 秒配置、25fps、8+3 两阶段，最终文件 145 帧/5.8 秒；若把标题理解为 5 帧/秒的采样吞吐并线性外推，145 帧约 29 秒，但这只是算术估计，不是可复现 benchmark。
6. **已进入 iDream 生产视频路由。** Apple M4 Max / 128GB / MPS 已连续完成两次 512×640、2 秒 smoke、作者规格 768×1152、6 秒全流程，以及产品规格 768×1152、4 秒真实用户任务。生产任务从浏览器提交，经 BullMQ `ai.video.generate`、专属 `gen-video`、ComfyUI exact workflow、completion manifest、主站 finalizer 落库，最终在 Gallery → Videos 中成功加载播放；本次 provider latency 为 623.715 秒，输出 H.264 + AAC、25fps、3.88 秒。
7. **许可不是 Apache/MIT。** LTX-2.3 受 LTX-2 Community License 约束；关联实体年收入达到 US$10M 要另签付费商业许可，直接竞争/替代 Lightricks 商业服务也需单独许可。Civitai 页面要求署名作者，并允许商业图片输出、出租/托管和衍生；作者页面权限不能覆盖 LTX 上游条款。样片使用的 Heretic Gemma 另受 Gemma Terms 约束。

## 精确版本事实

| 项目 | 核验结果 |
|---|---|
| 作者 | `AiMetatron` |
| 模型 / 版本 | `LTX 2.3 高速版 GTAnimation` / `LTXV 2.3高速版 INT4 ConvRot` |
| Base model | `LTXV 2.3` / `Standard` |
| Civitai 资源类型 | `Checkpoint` |
| 实际装载节点 | `UNETLoader`，因此运行时职责是独立 diffusion transformer / UNet 权重 |
| 下载文件 | `ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors` |
| 文件大小 | 17,265,774.3515625 KiB，约 16.47 GiB |
| SHA-256 | `FA457F3FB702A24CFEFA1167DB5CE11D8C8994023120B560E34D778CFA071D1D` |
| Civitai scan | SafeTensor；pickle / virus scan 均为 `Success` |
| 量化格式 | exact header `_quantization_metadata.format=convrot_w4a4`；Civitai API `metadata.fp=int8` 是粗粒度/误导性标记 |
| 推荐参数证据 | 作者样片：Euler、CFG 1；工作流第一阶段 8 步、第二阶段 3 步 |

“GTAnimation”究竟是微调、合并、蒸馏后的 bake，还是仅对 LTX-2.3 做量化，作者没有给训练配方、base hash、数据说明或可验证的权重谱系。正确表述是：**第三方 LTX-2.3 衍生 diffusion 权重，作者宣称为高速 INT4 ConvRot**；不能把它称为 Lightricks 官方量化版。

## 图生视频：支持方式与实际样片

### 作者 exact 工作流

目标版本的非成人样片 MP4 内嵌了完整 ComfyUI `workflow` 和 API `prompt`。核心链路为：

```text
LoadImage
  -> Resize / LTXVPreprocess
  -> EmptyLTXVLatentVideo
  -> LTXVImgToVideoInplace (低分辨率 strength 0.7)
  -> 8-step Euler / CFG 1
  -> LTXVLatentUpsampler x2
  -> LTXVImgToVideoInplace (高分辨率 strength 1.0)
  -> 3-step Euler / CFG 1
  -> VAEDecodeTiled
  -> CreateVideo / SaveVideo
```

因此：

- 单张图片作为首帧和画面条件，属于标准 I2V；
- 两阶段都重新注入同一图片，有助于高分辨率阶段保留画面细节；
- 工作流创建联合音视频 latent；重新以同时枚举 video/audio stream 的 `ffprobe` 核验后，非成人样片 `137158653.mp4` 确认带有 5.8 秒 AAC 音轨。此前“样片无音轨”的探测口径遗漏了 audio stream，不能沿用；现有证据证明工作流能输出音频，但还不足以判断语音、口型同步和音质。
- 它不是多参考角色一致性工作流；没有看到多图 identity/reference binding。

### 样片媒体事实

作者样片的 workflow 配置为：

| 参数 | 值 |
|---|---:|
| Width × Height | 768 × 1152 |
| Duration | 6 秒 |
| Frame rate | 25 fps |
| 理论 latent frame 数 | `6 × 25 + 1 = 151` |
| 第一阶段 | 8 steps，Euler，CFG 1 |
| 第二阶段 | 3 steps，Euler，CFG 1 |

对已下载的非成人 I2V 样片 `137158653.mp4` 重新执行完整 stream 探测：

```text
video: H.264 | 768x1152 | 25 fps | 145 frames | 5.8 seconds
audio: AAC | 273 audio frames | 5.8 seconds
```

这证明标题里的 “25 frames in 5 seconds” 不是输出规格。作者样片本身是 145 帧；标题更可能是在表达约 5 帧/秒的生成吞吐，但没有完整 benchmark 条件。

LTX 官方 I2V 模板默认是 1280×720、5 秒、25fps，帧数公式为 `duration × fps + 1`；宽高须为 32 的倍数。官方模板也是低分辨率 8 步、latent x2、全分辨率 3 步的两阶段流程。

## ComfyUI 集成依赖

### 作者样片的 exact 组件

| 角色 | 文件 | 放置目录 | 已知大小 |
|---|---|---|---:|
| Diffusion model | 下载后的 `ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors` | `models/diffusion_models/` | 16.47 GiB |
| Gemma text encoder | `gemma-3-12b-it-heretic-v2_int8.safetensors` | `models/text_encoders/` | 13.21 GB |
| LTX text projection | `ltx-2.3_text_projection_bf16.safetensors` | `models/text_encoders/` | 2.31 GB |
| Video VAE | `LTX23_video_vae_bf16.safetensors` | `models/vae/` | 1.45 GB |
| Audio VAE | `LTX23_audio_vae_bf16.safetensors` | `models/vae/` | 0.36 GB |
| Spatial upscaler | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | `models/latent_upscale_models/` | 1.00 GB |

合计约 36.02 GB / 33.54 GiB，不含 ComfyUI、缓存、输入和输出。

注意两个文件名差异：

- Civitai 实际下载名是 `ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors`；
- 作者本机工作流引用的是 `REDGTA1.0_LTX23_ComfyUI-int4_convrot.safetensors`。

下载后应在 `UNETLoader` 重新选择实际文件，或做明确的受控重命名；不能直接导入工作流后假设文件名会自动匹配。

作者样片使用 `DualCLIPLoader` 将 Heretic Gemma 与 `ltx-2.3_text_projection_bf16` 配对。这个组合不同于当前 ComfyUI 官方模板的 `gemma_3_12B_it_fp4_mixed` + checkpoint 内组件，也没有使用官方模板的 distilled LoRA。**不能把官方五文件模板原样换掉 checkpoint 就宣称 exact GTAnimation 已接入。**

### 节点与版本

作者称需要 ComfyUI 0.27 原生节点。当前 ComfyUI 官方文档称 LTX-2.3 已有六套 native workflows，不需要 custom nodes，但要求更新到最新版本；Desktop stable 可能晚于 nightly。

本机 8188 / 8189 当前均报告：

```text
ComfyUI 0.28.0
comfy-kitchen 0.2.22
PyTorch 2.10.0
device=mps
```

8188 的 `/object_info` 已确认以下 exact workflow 节点存在：

```text
UNETLoader
DualCLIPLoader
VAELoader
LatentUpscaleModelLoader
LTXVImgToVideoInplace
EmptyLTXVLatentVideo
LTXVConditioning
LTXVAudioVAEDecode
```

8188 已进一步用生产节点相同的 `comfy.sd.load_diffusion_model(path)` 路径成功识别 exact 权重，运行时报告：

```text
Found quantization metadata version 1
Detected mixed precision quantization
Native ops: convrot_w4a4, int8_tensorwise
Requested to load LTXAV
loaded completely; 16849.76 MB loaded, full load: True
```

因此这里已经不是“节点存在”证明，而是 exact 权重完整加载并进入真实采样的运行证据。

## 显存与生成耗时

### 显存

三种不同层级的声明不能混为一谈：

| 来源 | 声明 | 能证明什么 |
|---|---|---|
| Civitai 作者 | 22GB VRAM 可完整加载；12GB+ 可 weight swapping | 该作者对其工作流的主张；未给 GPU、峰值日志或 OOM 证据 |
| Lightricks 开源系统要求 | 最低 NVIDIA 32GB+；推荐 A100 80GB / H100 | 官方完整开源路径的支持门槛，不针对此第三方量化 |
| 当前本机 | M4 Max，128GB 统一内存；仅 MPS eager ConvRot | 容量大概率足以做候选实验，但没有 CUDA/Triton 快速内核 |

当前 `comfy-kitchen` 在本机：

```text
cuda: unavailable
triton: unavailable
eager: available
```

exact 22B 衍生权重已经在 MPS 完整加载并完成两次全图采样。当前进程采样到的最高 RSS 为 `27,904,736 KiB`，约 **26.61 GiB**；这包含 CPU 文本编码器、MPS/CPU offload、映射权重和运行时开销，不能与作者的“12GB NVIDIA VRAM”直接比较。它证明 128GB 统一内存本机容量充足，但不会获得页面宣传所依赖的 NVIDIA Tensor Core/CUDA 加速。

### 耗时

外部资料中的数字包括：

1. **作者标题：** 25 帧约 5 秒，即约 5 帧/秒；缺失 GPU、分辨率、steps、冷/热、模型是否常驻及是否含 VAE 编解码。
2. **作者样片：** 145 帧、5.8 秒成片；这不是生成 wall time。若机械使用 5 帧/秒，纯采样约 29 秒，但 12GB swapping、文本编码、两阶段上采样和 VAE 解码都会增加时间。
3. **LTX 论文：** H100、121 帧、720p、单步 Euler、CFG 1 时为 1.22 秒/扩散步。这是 LTX-2 论文的单步模型基准，不是 exact LTX-2.3 GTAnimation 的 8+3 完整 I2V 流程。
4. **LTX 官方文档：** 明确只说耗时取决于 GPU、VRAM、分辨率和时长，没有发布 12GB 消费卡完整计时。

本机现已有两次 like-for-like 实测：

| 运行 | 变化 | ComfyUI 缓存 | 服务端 wall time |
|---|---|---|---:|
| 首次隔离运行 | seed `2026072501/02`；提交前执行 `/free` | 无节点缓存 | **134.106 秒** |
| 常驻复跑 | seed 改为 `2026072503/04` | 静态输入/模型节点缓存；生成分支重跑 | **135.552 秒** |

固定参数为：

```text
512x640 / 2s / 24fps / 49 frames
I2V / 8+3 steps / Euler / CFG 1
Gemma INT8 on CPU / LTXAV ConvRot W4A4 on MPS
```

两次结果相差 1.45 秒，说明当前机器的可操作预算是**约 2 分 15 秒生成 2 秒 512×640 视频**，不是一次偶然的节点缓存结果。

由实测做容量规划时：

- **当前 M4 Max/MPS，512×640、5 秒：** 若 temporal cost 近似线性，约 **5–7 分钟**；这是基于 49→121 帧的外推，尚非实测；
- **当前 M4 Max/MPS，768×1152、6 秒：** exact 实测 **14 分 14.106 秒**；不是先前按 pixel-frame 线性外推的 15–25 分钟；
- **当前 M4 Max/MPS，768×1152、5 秒：** 基于全规格结果先按 **12–14 分钟**做排队预算，尚未单独实测；
- **作者 768×1152、6 秒、145 帧：** 本机 exact wall time 证明作者标题的“5 秒”不能当成 Mac 生成时间；
- **22GB+ NVIDIA、模型常驻：** 作者目标是几十秒级短片，但仍需在 exact GPU 上记录冷/热和完整编码/解码；
- **12GB NVIDIA + swapping：** 可用性仍只是作者声明，先按分钟级候选安排，不按 5 秒承诺。

已完成的全规格 benchmark 固定为：

```text
768x1152 / 6s / 25fps / 8+3 steps / Euler / CFG 1
同一首帧、prompt、seed
提交前 `/free`，新 seed，无缓存节点；
记录服务端 wall time、观察峰值 RSS、输出帧数、音轨与视觉结果
```

## 许可与商业使用边界

### Civitai 作者权限

Civitai model API 当前返回：

```text
allowNoCredit=false
allowCommercialUse={Image,RentCivit,Rent}
allowDerivatives=true
allowDifferentLicense=true
```

按平台字段可得：

- 使用时需要给 `AiMetatron` 署名；
- 允许商业使用生成的图片/媒体，以及在 Civitai 或其他方式出租/托管模型；
- 允许做衍生并允许不同附加许可；
- 字段没有 `Sell`，不要把它解释成允许转售原始权重。

这些是作者在 Civitai 上授予的附加权限，不能放宽 LTX 和 Gemma 上游条款。

### LTX-2 Community License

与 iDream 直接相关的条款：

- 原则上允许使用、修改、SaaS 托管和再分发 LTX-2 / 衍生模型；
- 关联实体合计年收入 **低于 US$10M** 时可按社区许可商业使用；达到或超过门槛须联系 Lightricks 获得付费商业许可；
- Lightricks 原则上不主张生成输出的权利；
- 再分发模型/衍生权重须附完整许可、传递使用限制、标注修改并保留 notices；
- 输出需要清楚披露为机器生成；
- 将 LTX-2 用于直接竞争或替代 Lightricks 商业产品/服务，需要单独商业许可。

因此，“我们能否上线商业产品”不是只看年收入即可：应同时确认产品是否会被视为直接竞争 LTX 的视频生成服务，并把 Civitai 作者署名、LTX AI 披露和条款传递落实到产品/分发路径。

### Gemma text encoder

作者 workflow 的 `gemma-3-12b-it-heretic-v2_int8` 是 Google Gemma 3 12B 的衍生版本，模型卡明确标记 `License: gemma`。Gemma Terms 允许使用和提供 hosted service，Google 不主张输出权；如分发 Gemma / 衍生权重，需要传递条款和使用限制，非 hosted distribution 还要附 `Notice` 文件。

## 2026-07-25 本机 I2V 实验结果

### 权重完整性

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors` | 17,680,152,936 | `fa457f3fb702a24cfefa1167db5ce11d8c8994023120b560e34d778cfa071d1d` |
| `gemma-3-12b-it-heretic-v2_int8.safetensors` | 13,210,171,412 | `5ec38ee58d20b884eca5f2569b8750dcc36c6e3013be55e58ebc38b9d4948174` |
| `ltx-2.3_text_projection_bf16.safetensors` | 2,312,149,072 | `911d59bb4cb7708179c9a0045ea0fe41212ecfb77aed3a02702b7c0a8274911f` |
| `LTX23_video_vae_bf16.safetensors` | 1,452,258,578 | `01ea62d09bc139f95c5dee7b5c062ad6a3e6cd8be910a1983ac02e7eb5b8ee3b` |
| `LTX23_audio_vae_bf16.safetensors` | 364,855,188 | `5bc10fa4adecf99dda132d916e23048cbd56797702c5fa50eb5d2079048a38c3` |
| `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | 995,743,560 | `5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed` |

### 实际输入与输出

#### 512×640 / 2 秒 smoke

- 输入：`packages/main/public/images/ourdream/card-alexa-reeves.webp`，800×999；
- prompt：成年女性在游艇上看向镜头、微笑、眨眼并轻轻挥手，同时说 “Hello, welcome aboard!”；
- 较好 seed 的视频：`/Users/kk/ComfyUI-Shared/output/ltx23-gtanimation-candidate-20260725/warm-alexa-mps_00001_.mp4`；
- 视频 SHA-256：`47ab0fffbab7f7c62c0ee2b9f180e08de2d27ae6e576fc900271eac9461ac110`；
- 媒体：H.264、512×640、24fps、49 帧、2.041667 秒；AAC、48kHz、双声道、2.041 秒；
- 49/49 视频帧哈希不同；音轨平均音量 -31.5 dB、峰值 -15.3 dB，不是静止图或静音占位；
- 首/中/末帧中脸型、发色、服装和背景稳定，末帧完成挥手；手掌存在可接受的运动模糊，未见明显多指或黑帧。

#### 768×1152 / 6 秒作者规格

| 项目 | 实测 |
|---|---|
| ComfyUI prompt id | `9c421a3c-4705-4098-9e62-9dd1d4590f5f` |
| 缓存 | `execution_cached.nodes=[]`，生成分支无缓存 |
| 服务端 wall time | **854.106 秒 / 14 分 14.106 秒** |
| 第一阶段 | 8 steps / 3 分 52 秒 |
| 第二阶段 | 3 steps / 6 分 59 秒 |
| 观察峰值 RSS | 26,250,064 KiB / **25.034 GiB** |
| 视频 | H.264、768×1152、25fps、145 帧、5.8 秒 |
| 音频 | AAC、48kHz、双声道、273 audio frames、5.8 秒 |
| 文件大小 | 1,810,982 字节 |
| SHA-256 | `9e84b31423c25a49776080d88728b27aadebe77396b6280cbcb65ce89a5c3c9a` |

视频位于：

```text
/Users/kk/ComfyUI-Shared/output/ltx23-gtanimation-candidate-20260725/full-768x1152-6s-alexa-mps_00001_.mp4
```

验收结果：

- 理论 `6×25+1=151` 帧经 LTX 内部对齐后输出 145 帧，与作者样片一致；
- 145/145 视频帧哈希不同，`blackdetect` 未发现黑帧区间；
- 音轨平均音量 -28.0 dB、峰值 -11.0 dB；
- 本地 Whisper `base.en` 将整段准确转写为 `Hello, welcome aboard.`，与 prompt 完全一致；
- 六点抽帧中脸型、发色、肤色、服装和游艇背景保持一致，没有换人或严重肢体崩坏；
- 中段手臂/挥手存在明显运动模糊，后半段面部略收窄；口部随语音连续变化，但尚未做专业 lip-sync 分数。

这次验证证明的是 exact 模型、exact companion 权重和当前 MPS 栈的作者规格真实 I2V 可执行性。尚未验证跨场景、多角色首帧矩阵和专业口型同步评分。

## 对 iDream 的决定

### 现在

**exact 候选已提升为受控生产 character I2V 路由。**

已经补齐：

1. 文件：exact 下载、全部 SHA-256、safetensors header 和 `convrot_w4a4` 格式；
2. 运行：当前 MPS 两次 smoke 和一次作者全规格 I2V；
3. 工程：独立 `ltx23-gtanimation-i2v` workflow descriptor、模型注册、source-image hydration、ComfyUI slot binding、MP4 下载与 completion manifest；
4. 产品：`video_gen` 100% rollout、Deluxe entitlement、100 coins 计价、character-only 入口、失败退款与 exact retry；
5. 运维：30 分钟 provider timeout、35 分钟视频 stale window、专属单实例 `gen-video` 且 PM2 watch 关闭；
6. 用户闭环：浏览器 retry 作业 `cms0ftgh70023mml77zf2nj0o` 在 623.715 秒后完成，资产 `media_s4pm7k77ohjms0g6v01` 落库，Gallery → Videos 实际读取成功。

生产实测媒体：

```text
/Users/kk/code/idream/data/blob/gen/cms0ftgh70023mml77zf2nj0o/video.mp4
H.264 | 768x1152 | 25 fps | 3.88s
AAC   | 48 kHz | stereo | 3.88s
SHA-256 d1847699bfa44b23ed37a25f0126ffd1107fa4d6c3f0eb2ad9f13e505ac26a3e
```

第一次产品作业在推理完成前被旧 10 分钟 stale reconciler 标记为失败并退款，
同时开发态 PM2 watch 曾截断长任务。这两项不是被隐藏的测试噪音：上线实现已把
视频 stale window 分离为 35 分钟、让 terminal job 的迟到 manifest 归档且不误
交付，并让 `gen-video` 在所有 PM2 模式关闭 watch。第二次从前台点击 Retry 的
作业跨过 10 分钟边界后正常交付，验证修复真实生效。

### 当前生产边界

- 只支持已发布角色主图驱动的单图 I2V；不暴露 freeplay text-to-video；
- 固定 768×1152、2:3、25fps、4 秒、单输出，用户不能绕过 profile/recipe/quote authority；
- 3–5 个角色的统一质量矩阵、跨场景身份一致性与专业 lip-sync 评分仍是后续质量优化，不再是当前路由能否执行和交付的阻塞项；
- 12GB NVIDIA 的速度与峰值仍未在 exact GPU 上验证，不能把作者标题当成 SLA。

## 一手来源与本地证据

- [Civitai 目标版本 API](https://civitai.com/api/v1/model-versions/3143864)
- [Civitai 模型 API（作者说明、权限、全部版本）](https://civitai.com/api/v1/models/1295569)
- [目标模型页面](https://civitai.red/models/1295569/ltx-23-gtanimation-or-25-frames-in-5s-12g-vram?modelVersionId=3143864)
- [作者非成人 I2V 样片（内嵌 exact workflow）](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/9746c7cf-5ec7-4aa9-8db2-7c4009eb5a88/original=true/137158653.mp4)
- [ComfyUI 官方 LTX-2.3 native workflows](https://docs.comfy.org/tutorials/video/ltx/ltx-2-3)
- [ComfyUI 官方 I2V workflow JSON](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_ltx2_3_i2v.json)
- [LTX 官方 I2V 使用指南](https://docs.ltx.io/open-source-model/usage-guides/image-to-video)
- [LTX 官方系统要求](https://docs.ltx.io/open-source-model/getting-started/system-requirements)
- [LTX-2.3 官方模型卡](https://huggingface.co/Lightricks/LTX-2.3)
- [LTX-2 Community License](https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE)
- [LTX-2 论文推理性能表](https://arxiv.org/html/2601.03233#S6.SS3)
- [DreamFast Heretic Gemma v2 模型卡](https://huggingface.co/DreamFast/gemma-3-12b-it-heretic-v2)
- [Google Gemma Terms](https://ai.google.dev/gemma/terms)
- [Kijai LTX-2.3 split components](https://huggingface.co/Kijai/LTX2.3_comfy/tree/main)
- [`packages/gen/src/providers.ts`](../../packages/gen/src/providers.ts)
- [`packages/gen/src/video.ts`](../../packages/gen/src/video.ts)
- [`packages/main/src/server/providers/index.ts`](../../packages/main/src/server/providers/index.ts)
- [`CURRENT_FUNCTIONAL_COVERAGE.md`](../product/CURRENT_FUNCTIONAL_COVERAGE.md)

作者样片的媒体与工作流核验命令：

```sh
ffprobe -v error \
  -show_entries stream=width,height,avg_frame_rate,nb_frames,duration \
  -show_entries format=duration:format_tags=workflow,prompt \
  -of json '<sample.mp4>'
```

本机运行事实来自 2026-07-25 对 8188/8189 的 `/system_stats`、8188 `/object_info`，以及当前 ComfyUI venv 的 `comfy_kitchen.list_backends()`；这些是时间敏感证据，升级 ComfyUI/PyTorch 后需要重新验证。
