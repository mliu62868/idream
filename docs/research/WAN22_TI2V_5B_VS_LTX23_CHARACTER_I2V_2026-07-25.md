# Wan 2.2 5B 与 LTX-2.3：iDream 角色图生视频选型

日期：2026-07-25
范围：本地 ComfyUI、Apple M4 Max / 128GB 统一内存、角色单图 I2V、短竖屏视频。
问题：`Wan 2.2 5B` 和 `LTX-2.3` 哪个更适合 iDream；同时核验 civitai.red 上的模型、微调、LoRA、工作流和可下载文件。

## 一句话结论

**iDream 当前生产路由继续用 LTX-2.3；Wan 2.2 5B 作为低资源、无原生音频候选做隔离 A/B，不应直接替换。**

理由不是“22B 一定比 5B 好”，而是：

1. iDream 的 exact `LTX 2.3 GTAnimation INT4 ConvRot` 已在当前 M4 Max/MPS 上完成真实角色 I2V、AAC 音频、队列、落库和 Gallery 播放闭环；
2. `Wan2.2-TI2V-5B` 更小、Apache-2.0、更省磁盘，ComfyUI 有原生节点和官方模板，但当前主机只有节点、没有 Wan 权重，也没有一条真实 MPS 视频或身份一致性 A/B；
3. 两者没有可信的一手、同输入、同分辨率、同步数、同硬件角色 I2V 对比。现在把 Wan 宣称为“质量更好”或“Mac 更快”都没有证据。

如果是全新项目：

- 优先低资源、静音视频、简单商业许可：选 **Wan2.2-TI2V-5B**；
- 优先同步音频、竖屏、首尾帧/多关键帧和更完整的控制能力：选 **LTX-2.3**；
- 对当前 iDream：**LTX-2.3 是已验证的生产选择，Wan 5B 是值得测的候选，不是已证明的替代品。**

## 精确比较对象

“Wan 2.2 5B”应精确到：

```text
Wan-AI/Wan2.2-TI2V-5B
task: ti2v-5B
architecture: 5B dense
```

它不是 `Wan2.2-I2V-A14B`，也不是 `Wan2.2-Animate-14B`。Wan 官方仓库明确将 5B 定义为统一 T2V + I2V 的 TI2V 模型；MoE 是 A14B 系列的设计，不能把 5B 说成 14B active / 27B total MoE。[Wan2.2 官方仓库](https://github.com/Wan-Video/Wan2.2)

“LTX-2.3”有两层：

1. 上游官方模型：`Lightricks/LTX-2.3`，包含 22B dev、22B distilled 1.1、distilled LoRA 和空间/时间 upscaler；[官方模型文件](https://huggingface.co/Lightricks/LTX-2.3/tree/main)
2. iDream 当前 exact 路由：Civitai model `1295569` / modelVersion `3143864`，`AiMetatron` 发布的第三方 `LTXV 2.3` 衍生 transformer，文件为 `ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors`；它不是 Lightricks 官方量化版。[civitai.red 目标版本](https://civitai.red/models/1295569?modelVersionId=3143864)

以下结论以这两个精确对象为准。

## 事实对照

| 维度 | Wan2.2-TI2V-5B | LTX-2.3 / iDream exact 路由 |
|---|---|---|
| 参数/架构 | 5B dense；高压缩 Wan2.2 VAE | 官方 22B；iDream 用第三方 W4A4 ConvRot 衍生 transformer |
| T2V | 原生支持 | 原生支持，但 iDream 产品当前不开放 freeplay T2V |
| I2V | 原生支持；有图片即 I2V | 原生支持；iDream 当前严格绑定一张已发布角色主图 |
| 官方基础输出 | 720P、24fps | 官方 LTX-2.3 家族支持 I2V 与同步音视频；托管/API 产品覆盖 1080p/1440p/4K、24/25/48/50fps |
| 默认短片 | 官方代码 `121` 帧、24fps，约 5.04 秒 | iDream 固定 768×1152、25fps、4 秒；实际产物 3.88 秒 |
| 音频 | TI2V-5B 是视频生成模型；Wan 把语音驱动另列为 S2V-14B，因此同步音频需要另一条链路 | 联合生成视频与 AAC 音频；iDream exact 产物已验证可转写 |
| ComfyUI | Day-0 原生支持；官方模板 `Wan2.2 5B video generation` | LTX-2 已进入 ComfyUI core，官方附加节点仓库提供 LTX-2.3 单/双阶段 I2V 等工作流 |
| 官方显存口径 | Wan 原仓库：至少 24GB VRAM；ComfyUI 原生 offload 文档：5B 应可落到 8GB VRAM | Lightricks ComfyUI 仓库：CUDA 32GB+ VRAM、100GB+ 磁盘 |
| 权重下载口径 | Comfy 版 diffusion + VAE + UMT5 约 18.2GB | 官方单个 BF16 transformer 约 46.1GB；iDream exact 全套约 36.02GB / 33.54GiB |
| 许可 | Apache-2.0 | LTX-2 Community License；关联实体年收入达 US$10M 需付费商业许可，直接竞争/替代 Lightricks 商业服务另需许可 |
| 当前 M4 Max 状态 | 原生节点存在；权重不存在；未跑 | 权重存在；MPS 已跑；生产闭环已跑 |

### 规格边界说明

LTX 官网的 4K、50fps、最长 20 秒是 LTX-2.3 产品/模型家族能力，不等于 iDream 当前第三方量化工作流已经支持同一生产包络。iDream 当前应继续对外承诺自己验证过的 **768×1152、25fps、4 秒、单图 I2V**。[LTX-2.3 官方能力页](https://ltx.io/model/ltx-2-3)；[LTX API 支持矩阵](https://docs.ltx.io/models)

同样，Wan 官方称 5B 支持“720P”，其原生 CLI 对 TI2V 使用 `1280×704` 或 `704×1280`，不是严格的 1280×720。I2V 的最终长宽比跟随输入图。[Wan 官方运行说明](https://github.com/Wan-Video/Wan2.2#run-text-image-to-video-generation)

## 速度与资源

### Wan2.2-TI2V-5B 的一手数据

Wan 官方配置固定：

```text
sample_fps = 24
sample_steps = 50
frame_num = 121
```

来源：[官方 `wan_ti2v_5B.py`](https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_ti2v_5B.py)

官方性能表在 warm-up 后多样本平均、关闭 prompt extension、开启 offload / dtype conversion / T5 CPU 的条件下，RTX 4090 生成 720P、约 5 秒视频：

| 模式 | 总时间 | 峰值显存 |
|---|---:|---:|
| T2V | 534.7 秒 | 22.9GB |
| I2V | 524.8 秒 | 22.8GB |

来源：[Wan 官方 Computational Efficiency 表](https://github.com/Wan-Video/Wan2.2#computational-efficiency-on-different-gpus)及其[原始表格图片](https://raw.githubusercontent.com/Wan-Video/Wan2.2/main/assets/comp_effic.png)。

这与官方“单张消费级 GPU 生成 5 秒 720P 视频低于 9 分钟”的概括一致。[官方模型卡](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B)

两个显存口径都要保留：

- Wan 原生仓库命令写明至少 24GB VRAM；
- ComfyUI 官方文档称借助 native offloading，5B “should fit well on 8GB VRAM”。

后者是 ComfyUI 对 offload 路径的可运行性声明，不是 8GB 下的速度 SLA，也不能外推为 Apple MPS 已验证。[ComfyUI 官方 Wan2.2 指南](https://docs.comfy.org/tutorials/video/wan/wan2_2)

### iDream 当前 LTX-2.3 exact 数据

当前机器：

```text
Apple M4 Max
128GB unified memory
ComfyUI 0.28.0
PyTorch 2.10.0
device = mps
```

本地已验证：

| 路径 | 输出 | 耗时/峰值 |
|---|---|---|
| exact 全规格 | 768×1152、25fps、145 帧、5.8 秒、AAC | 854.106 秒；观察峰值 RSS 25.034GiB |
| iDream 真实产品任务 | 768×1152、25fps、3.88 秒、AAC | provider latency 623.715 秒 |

完整证据、哈希、媒体探测和浏览器闭环见 [`LTX23_GTANIMATION_INT4_CONVROT_SUITABILITY_REVIEW_2026-07-25.md`](./LTX23_GTANIMATION_INT4_CONVROT_SUITABILITY_REVIEW_2026-07-25.md) 与 [`CURRENT_FUNCTIONAL_COVERAGE.md`](../product/CURRENT_FUNCTIONAL_COVERAGE.md)。

这些数字不能直接判定 LTX 比 Wan 快或慢：

- Wan 数据来自 RTX 4090/CUDA、50 steps、1280×704、无同步音频；
- LTX 数据来自 M4 Max/MPS、8+3 两阶段、768×1152、联合音视频；
- 设备、像素数、步数、VAE、音频和计时边界都不同。

可以诚实下的结论只有：

- Wan 5B 的下载体积和架构明显更轻；
- Wan 在 RTX 4090 上有 524.8 秒的官方 I2V 基线；
- 当前 M4 Max 上谁更快，必须实跑，不能用 NVIDIA 数字猜。

## 角色 I2V：哪个更合适

### LTX-2.3 当前更适合 iDream 的原因

1. **已有真实身份保持证据。** 当前角色样片六点抽帧中脸型、发色、肤色、服装和背景稳定；这只证明已测角色/场景，不应夸大为全角色结论。
2. **原生音频符合当前产物契约。** exact 输出是 H.264 + AAC，语音可被 Whisper 准确转写。换 Wan 5B 会把音频变成新的 provider/合成/封装工作。
3. **产品几何已对齐。** 当前工作流就是 2:3 竖屏 768×1152；Wan 5B 虽能按输入图保持纵横比，但尚未验证同一角色主图在 704×1280 或产品规格下的脸部稳定性。
4. **工程闭环已经存在。** 单张 `source_image`、workflow/version pin、30 分钟 provider timeout、35 分钟 stale window、MP4 manifest 和 Gallery 播放都已验证。

### Wan2.2-TI2V-5B 值得测的原因

1. **更轻。** ComfyUI 基础权重下载约为 LTX exact 全套的一半；
2. **统一 T2V/I2V。** 同一 5B 模型即可覆盖两种入口；
3. **许可简单。** Apache-2.0 没有 LTX 的 US$10M 收入门槛和竞争服务条款；
4. **ComfyUI 原生。** 当前 8188/8189 的 `/object_info` 已存在 `Wan22ImageToVideoLatent`，不需要为了“看见节点”引入第三方 wrapper。

但 Wan 5B 不是 `Wan2.2-Animate-14B`。如果目标变成“让角色跟随指定动作视频”或“替换动作视频中的人物”，应该评估 Animate-14B，而不是把 TI2V-5B 的单图 I2V 能力误称为动作驱动角色动画。[Wan2.2 官方模型列表](https://github.com/Wan-Video/Wan2.2#model-download)

## civitai.red 调查

调查方式：直接查询 `https://civitai.red/api/v1/models` 和精确 model API；以下是 2026-07-25 快照。搜索排序和数量会变化，精确 ID、version ID、文件名、SHA-256 才是可复核事实。

### Wan 2.2 5B

#### 1. 可下载基础权重

[CivitaiOfficial 的 Wan Video 2.2 页面](https://civitai.red/models/1817671)是 `Checkpoint` 聚合页，但每个 version 的内容不同：

| version | 内容 | 文件 | 大小 | SHA-256 |
|---|---|---|---:|---|
| `2057016` `ti2v_5B_fp16` | ComfyUI diffusion model | `wanVideo22_ti2v5BFp16.safetensors` | 9,765,291.84KiB，约 9.31GiB | `456F901338BD9EADBDED3828B819109A9B68E8A525CA5CF8D0049A69FCFECA1E` |
| `2056931` `wan2.2_vae` | VAE | `wanVideo22_wan22Vae.safetensors` | 1,376,368.13KiB，约 1.31GiB | `E40321BD36B9709991DAE2530EB4AC303DD168276980D3E9BC4B6E2B75FED156` |
| `2114110` `5B Text-Image-to-Video` | Civitai 站内生成数据包 | `wanVideo22_5bTextImageToVideo_trainingData.zip` | 18,605.61KiB | `33FC2F5384D6010C4166558EC490C55C133EE60F20B2B459BEBBDD37F9AA5F89` |

精确 API：[model 1817671](https://civitai.red/api/v1/models/1817671)。

注意：`2114110` 的主文件只是约 18MB 的 `Training Data` zip，不是 5B 权重。真正的 ComfyUI diffusion 文件是 `2057016`。此外仍需官方模板指定的 `umt5_xxl_fp8_e4m3fn_scaled.safetensors`（6.74GB）文本编码器。[Comfy-Org UMT5 文件](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/blob/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors)

`CivitaiOfficial` 代表 Civitai 的重打包/站内资源，不代表 Alibaba/Wan 官方上游；上游权威仍是 `Wan-AI/Wan2.2-TI2V-5B` 和 `Wan-Video/Wan2.2`。

#### 2. 第三方 checkpoint / merge

[Wan Damme - Rapid WAN 2.2 5B](https://civitai.red/models/1995164)是第三方 `Checkpoint`：

- version `2258309`：FP8 Turbo，4-step 派生，约 12.25GiB；
- version `2258587`：FP8 Fast，约 12.25GiB；
- 页面说明引用第三方 Turbo/FastWan LoRA，不能当成官方 TI2V-5B 的质量、速度或许可证据。

#### 3. LoRA

代表条目：

- [Tifa Wan 2.2 5B LoRA](https://civitai.red/models/1850332)：约 76.95MiB 的角色 LoRA；
- [Aether Punch - Wan 2.2 5B I2V LoRA](https://civitai.red/models/1838885)：约 153.82MiB 的动作 LoRA。

它们需要基础模型，不是可独立运行的 5B checkpoint；各自 Civitai 商业权限也不同，不能继承基础模型页面的标签后统一判断。

#### 4. 工作流

代表条目：

- [WAN 2.2 5B I2V Workflow](https://civitai.red/models/1911157)：下载是 11.44KiB zip；
- [Low VRAM Wan 2.2 TI2V 5B GGUF Workflow](https://civitai.red/models/1886437)：下载是 5.59KiB zip；
- [WhiteRabbit InterpLoop](https://civitai.red/models/1931348)：下载是 26.47KiB zip。

这些文件是配置/工作流，不含基础权重。搜索结果里出现 “5B / low VRAM / I2V” 不等于下载后即可生成。

### LTX-2.3

#### 1. 上游权重的 Civitai 上传

[Lightricks LTXV 2.3](https://civitai.red/models/2445735)由 `ltxvideo` 账号发布：

- version `2749908` Dev：`lightricksLTXV23_dev.safetensors`，约 42.98GiB；
- version `2749948` Distilled：`lightricksLTXV23_distilled.safetensors`，约 42.98GiB。

两者 SHA-256 分别为：

```text
7AB7225325BC403448EA84B6DB2269811A880E5118CD2EE2B6282A93D585016F
14409A4D1337A8DED02FA87FB895B17A91AB2C6588F7CC3352E624FF18A689BF
```

精确 API：[model 2445735](https://civitai.red/api/v1/models/2445735)。下载前仍应以 [Lightricks 官方 Hugging Face](https://huggingface.co/Lightricks/LTX-2.3) 的许可和文件为上游权威。

#### 2. 量化、重打包与第三方衍生

- [LTX-2.3 聚合 checkpoint](https://civitai.red/models/2448150)含 BF16、FP8、FP8 Distilled、NVFP4 和 distilled LoRA；发布者不是 Lightricks；
- [LTX 2.3 DEV GGUF](https://civitai.red/models/2443441)含 BF16、Q8、Q6、Q5、Q4、Q3、Q2 多个 GGUF 文件；这些是第三方量化，格式支持取决于 loader；
- [iDream 当前 GTAnimation](https://civitai.red/models/1295569?modelVersionId=3143864)只有一个 16.47GiB SafeTensor，Civitai API 粗粒度标记为 `fp=int8`，本地 exact header 已验证为 `convrot_w4a4`。它仍需 Gemma、LTX text projection、video/audio VAE 和 spatial upscaler，全套约 36.02GB。

#### 3. LoRA 与工作流

- [LTX2.3 Dual-Character IC-LoRA](https://civitai.red/models/2500098)是约 312.13MiB LoRA，不是双角色基础模型；
- [AiMetatron 工作流集合](https://civitai.red/models/579280?modelVersionId=3137174)的 LTX2.3 文件是 126.52KiB JSON `Config`，不含 GTAnimation 权重或配套组件。

因此 civitai.red 上至少要区分：

```text
Checkpoint/Model file  -> 可能是完整 transformer，也可能只是一个拆分组件
Merge/Finetune         -> 第三方谱系和许可需单独核验
LoRA                   -> 必须叠加兼容基础模型
Workflow/Config        -> 只有图和参数，不含权重
Training Data          -> 站内生成元数据，不是 checkpoint
GGUF/FP8/NVFP4/ConvRot -> 还要验证当前 ComfyUI loader 与 MPS/CUDA backend
```

## 对 iDream 的决定与最小验证方案

### 现在

保持：

```text
production primary = ltx23-gtanimation-i2v
input              = exactly one published character source image
output             = 768x1152 / 25fps / ~4s / MP4 + AAC
```

不基于 civitai.red 热度、文件标签或 NVIDIA 速度表修改生产路由。

### Wan 候选通过条件

只做隔离候选，不接生产计费/发布：

1. 下载精确 ComfyUI 官方文件：`wan2.2_ti2v_5B_fp16.safetensors`、`wan2.2_vae.safetensors`、`umt5_xxl_fp8_e4m3fn_scaled.safetensors`；
2. 先跑 512×640 / 49 帧 smoke，确认 MPS 真执行，而不是只有节点可见；
3. 再用与 LTX 相同的角色主图、prompt、seed policy、时长和接近的 pixel-frame 预算跑 10×4 角色/动作矩阵；
4. 记录冷/热 wall time、峰值 RSS、帧哈希、黑帧、脸部漂移、手部、运动幅度和失败率；
5. 若产品仍要求音频，单独计算 TTS/音频封装时延和失败面，不能拿静音 Wan 对比联合音视频 LTX；
6. 只有在质量、总时延、失败率和产品契约同时胜出后，才建立新的 pinned workflow descriptor；在此之前不替换默认路由。

## 许可结论

Wan2.2 模型官方声明为 Apache-2.0，并声明不主张生成内容权利。[Wan 官方许可说明](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B#license-agreement)

LTX-2.3 不是 Apache/MIT：

- 关联实体年收入达到 US$10M，使用 LTX-2 或其衍生模型需要付费商业许可；
- SaaS 托管原则上允许，但需遵守分发、使用限制和 notices；
- 用于直接竞争或替代 Lightricks 商业产品/服务，需要单独商业许可；
- 许可适用于 LTX-2 衍生 checkpoint，因此第三方 GTAnimation 的 Civitai 权限不能覆盖上游条款。

来源：[LTX-2 Community License](https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE)。

## 一手来源

- [Wan2.2 官方仓库](https://github.com/Wan-Video/Wan2.2)
- [Wan2.2-TI2V-5B 官方模型卡](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B)
- [Wan TI2V-5B 官方配置](https://github.com/Wan-Video/Wan2.2/blob/main/wan/configs/wan_ti2v_5B.py)
- [ComfyUI 官方 Wan2.2 指南](https://docs.comfy.org/tutorials/video/wan/wan2_2)
- [ComfyUI 官方 Wan2.2 示例](https://comfyanonymous.github.io/ComfyUI_examples/wan22/)
- [Comfy-Org Wan2.2 重打包](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)
- [LTX-2.3 官方模型文件](https://huggingface.co/Lightricks/LTX-2.3/tree/main)
- [LTX-2 官方推理仓库](https://github.com/Lightricks/LTX-2)
- [LTX 官方 ComfyUI 仓库](https://github.com/Lightricks/ComfyUI-LTXVideo)
- [LTX 官方 ComfyUI 指南](https://docs.ltx.video/open-source-model/integration-tools/comfy-ui)
- [LTX-2.3 官方能力页](https://ltx.io/model/ltx-2-3)
- [LTX-2 Community License](https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE)
- [civitai.red Wan 2.2 model API](https://civitai.red/api/v1/models/1817671)
- [civitai.red LTXV 2.3 model API](https://civitai.red/api/v1/models/2445735)
- [civitai.red GTAnimation model API](https://civitai.red/api/v1/models/1295569)

## 证据状态

| 结论 | 状态 |
|---|---|
| Wan 5B 支持 T2V + I2V、720P@24fps | 官方确认 |
| Wan 5B 默认 121 帧 / 50 steps | 官方代码确认 |
| Wan 5B 在 RTX 4090 的 720P I2V 为 524.8 秒 / 22.8GB | 官方 benchmark |
| Wan 5B 在当前 M4 Max 可运行、耗时或质量 | **未验证** |
| LTX exact 在当前 M4 Max 完成角色 I2V + AAC | 本地实跑确认 |
| LTX exact 已完成 iDream 生产闭环 | 浏览器/队列/持久化/媒体确认 |
| Wan 与 LTX 哪个角色质量更好 | **无同条件证据，必须 A/B** |
| civitai.red 文件可下载 | API 元数据确认；未因此重复下载大文件 |
