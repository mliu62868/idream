# Civitai Red 成人向 FLUX 3 Image Klein 模型调研

核验时间为 2026-11-24 约 04:10（美国太平洋时间）。下列条目和统计适用于当时的 Civitai Red 匿名公开目录。版本日期使用太平洋时间。

**Red 上仍以成人向 LoRA 为主。** 两个 Klein 分类合计查到 3 个公开 Checkpoint 条目，分别为官方底模镜像和两个量化发布。公开目录里未查到成人向完整微调或合并权重。明确面向成人内容的公开 LoRA 中，最新版本是 11 月 1 日的 **Flux 3 Klein Penis LoRA v1.0**，用途限于男性解剖。若目标是测试虚构成年女性的文生图，优先看 **Party Time v2.1_flux3**，其版本页关联了作者及社区样例，作者同时报告了复杂解剖和多人物场景的局限。 [Red Checkpoint 目录](https://civitai.red/api/v1/models?baseModels=Flux.3%20Klein&baseModels=Flux.3%20Klein-base&types=Checkpoint&limit=100&nsfw=true&sort=Newest) · [最新专项 LoRA](https://civitai.red/models/3031830?modelVersionId=3444392) · [Party Time 作者页](https://civitai.red/models/2458332?modelVersionId=3421681)

## Civitai Red 公开目录

按 Red 的枚举分别查 `Flux.3 Klein` 和 `Flux.3 Klein-base`，允许成人条目，每次取 100 条并检查分页游标。两个列表均在第一页结束。发布顺序取对应版本的 `publishedAt`，因为同一型号条目可以同时包含多代底模的版本。更多结果会受平台可见性及浏览等级影响。 [Red 枚举](https://civitai.red/api/v1/enums) · [Civitai API 定义](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/models.md)

| Red 基础模型 | Checkpoint 条目／版本 | LoRA 条目／版本 | 模型层 `nsfw=true` 的 LoRA 条目 | 目录 |
| --- | ---: | ---: | ---: | --- |
| `Flux.3 Klein` | 3／5 | 39／42 | 8 | [Red API](https://civitai.red/api/v1/models?baseModels=Flux.3%20Klein&limit=100&nsfw=true&sort=Newest) |
| `Flux.3 Klein-base` | 2／2 | 16／17 | 7 | [Red API](https://civitai.red/api/v1/models?baseModels=Flux.3%20Klein-base&limit=100&nsfw=true&sort=Newest) |

两类 LoRA 无重复，合计 55 个条目、59 个版本。两个 Checkpoint 条目跨类重复，去重后为 3 个条目、7 个版本。成熟分级描述的是条目和图库内容，成人生成能力取决于对应版本的训练目标。比如 Base 分类里标记 NSFW 的条目也有 Porsche 911 车辆 LoRA。 [车辆 LoRA 版本元数据](https://civitai.red/api/v1/model-versions/3413391) · [Civitai 图片分级与可见性](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/images.md)

| Checkpoint | 对应版本 | 发布内容 |
| --- | --- | --- |
| CivitaiOfficial 的 **Flux.3 Klein** | Distilled `3407486`，Base `3407485` | 官方底模镜像，单独提供 transformer、编码器与 VAE。 [作者元数据](https://civitai.red/api/v1/models/3003556) |
| tsolful 的 **Flux 3 Klein INT8/INT6/INT4** | Base INT8 `3407393`，另外 3 个版本归在 Klein | 作者声明为 BFL 权重的 ConvRot 量化。公开 API 列出的主权重为 INT8 或 W6A8。 [作者元数据](https://civitai.red/api/v1/models/3003490) |
| molbal 的 **Flux3 Klein GGUF** | `3409741` | Distilled 的 GGUF 转换，包含 Q4、Q6、Q8 等文件。 [作者元数据](https://civitai.red/api/v1/models/3005306) |

另外核对了邻近的 `Flux.3` 分类、`Checkpoint` 的 `Trained`／`Merge` 筛选，以及 “Klein NSFW”“Klein Uncensored”“SNOFS”“UNCHAINED” 标题搜索。`Flux.3` 分类唯一的 Checkpoint 是 CivitaiOfficial 的托管版 FLUX 3 Image／Video 页面。SNOFS 的公开 Klein 权重仍归在 FLUX.2 Klein 9B 系列，UNCHAINED 的 Klein LoRA 归在 FLUX.2 Klein 9B Base。 [托管版元数据](https://civitai.red/api/v1/models/2839203) · [SNOFS 合并版](https://civitai.red/api/v1/models/2416142) · [SNOFS LoRA](https://civitai.red/api/v1/models/1972981) · [UNCHAINED Klein 元数据](https://civitai.red/api/v1/models/2348977)

## 成人向候选

下载数为精确版本快照。样例数以对应版本的公开图片 API 为准，正好覆盖该接口当时可见的样例。图像内容、真实可下载状态和本地推理均未验证。

| Red 版本 | 发布日 | 分类与权重 | 下载 | 用途和证据 |
| --- | --- | --- | ---: | --- |
| **Flux 3 Klein Penis LoRA v1.0** `3444392` | 11-01 | Base，306.4 MiB，BF16 | 378 | 最新明确针对成人内容的专项 LoRA。作者称用 642 张图训练 15,000 步；公开集只有作者 1 张，记录 16 步、CFG 1。模型的商业选项仅列两个租用项。 [作者](https://civitai.red/api/v1/models/3031830) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3444392&withMeta=true&nsfw=true) |
| **Oral from Image v1.0** `3432795` | 10-27 | Klein，76.7 MiB，BF16 | 538 | 针对单一动作的参考图编辑。作者的 3 张样例记录 Distilled INT8 ConvRot、16 步、CFG 1，公开元数据里的提示词和输入参考图不全。 [作者](https://civitai.red/api/v1/models/3023017) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3432795&withMeta=true&nsfw=true) |
| **Party Time v2.1_flux3** `3421681` | 10-21 | Klein，612.8 MiB，BF16 | 3,318 | 虚构成年女性裸露文生图优先试。作者指定 Distilled、16 步、强度 1.0，并记录细节、解剖和旁人意外裸露的问题。公开 26 张，作者发了 13 张，两位社区账号合计发了 13 张。共 25 张有提示词、种子、步数和 CFG。 [作者](https://civitai.red/api/v1/models/2458332) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3421681&withMeta=true&nsfw=true&limit=100) |
| **DRDNSFW01 Females cutre v1.0** `3416554` | 10-19 | Base，270.8 MiB，BF16 | 325 | 女性身体概念增强，可作为第二组候选。作者只报告了 NVFP4 路线，并指出偶发手脚变形。公开 1 张作者样例，缺采样参数。 [作者](https://civitai.red/api/v1/models/3010564) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3416554&withMeta=true&nsfw=true) |
| **ADD Sexy Pose! KLEIN 3** `3411937` | 10-17 | Klein，153.3 MiB，BF16 | 499 | 姿势、脸部及身形风格增强。版本附 Distilled 文生图工作流，公开样例来自 2 个账号。 [版本及附带配置](https://civitai.red/api/v1/model-versions/3411937) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3411937&withMeta=true&nsfw=true) |
| **Radiance Chrome Voluptuous Flux.3-Klein** `3410965` | 10-17 | Base，153.3 MiB，BF16 | 713 | 反转片风格、高对比和固定身形偏好。作者支持 Base 和 Distilled。公开 35 张中 34 张来自作者；版本说明引用 BFL 许可，模型级商业选项只列站内租用。 [作者](https://civitai.red/api/v1/models/2323765) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3410965&withMeta=true&nsfw=true) |
| **Penis Flux.3-Image Klein v1** `3408177` | 10-16 | Base，153.3 MiB，BF16 | 669 | 与 11 月 1 日版本可作同任务对照。14 张作者样例，11 张带种子、步数和 CFG，附 ComfyUI 配置。作者说明仅限非商业使用。 [作者](https://civitai.red/api/v1/models/3004100) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3408177&withMeta=true&nsfw=true) |
| **Flux 3 klein - missionary POV v0.2** `3409463` | 10-16 | Base，270.8 MiB，FP32 | 964 | 单一视角和姿势的测试版。公开 2 张均由作者上传，缺少采样元数据。 [作者](https://civitai.red/api/v1/models/3004318) · [样例元数据](https://civitai.red/api/v1/images?modelVersionId=3409463&withMeta=true&nsfw=true) |

**Party Time 的复现起点最清楚。** 一个社区账号的 12 张样例同时登记 CivitaiOfficial 的 Distilled `3407486` 和这款 LoRA `3421681`，都记录 Euler、16 步和 CFG 1。10 张的 LoRA 强度为 1.0，另两张为 0.75 和 0.8。作者样例也有 8 步和 16 步两种配方。作者报告在自己的样本里，Klein 的面部表情和皮肤细节弱于 Krea 2，成人解剖覆盖也有限。统一输入下的成功率仍待测量。 [Party Time 作者](https://civitai.red/api/v1/models/2458332) · [公开样例元数据](https://civitai.red/api/v1/images?modelVersionId=3421681&withMeta=true&nsfw=true&limit=100)

复现时可用版本 ID 和文件 SHA-256 锁定权重。Party Time 为 `5D29C6357E6C45C6275C4833A96EF0BB7E58304AF8243307B44B9F2DF3874E84`；11 月 1 日专项版为 `23332C884381E75024BB2A9098E012FB49FC20CDDEFFE6CB630FFDEB21102144`。两个版本的文件元数据均公开，Civitai 官方 CLI 文档指出大部分文件下载需要账号令牌。 [Party Time 文件](https://civitai.red/api/v1/model-versions/3421681) · [专项版文件](https://civitai.red/api/v1/model-versions/3444392) · [Civitai CLI](https://github.com/civitai/cli)

## 11 月的角色编辑资源

| 版本 | Red 发布日 | 可测试的能力 |
| --- | --- | --- |
| **Body01 v1.0** `3452786` | 11-05 | 身形编辑和文生图风格加强。作者给的 25 步、CFG 3.5 配方更接近 Base 设置，虽然 Red 版本归在 Klein。公开样例是作者上传，所用底模需复测核对。 [作者](https://civitai.red/api/v1/models/3038304) |
| **Natural Facial Skin Texture** `3461312`／`3461290` | 11-09 | 作者 yang520333 在 Base 上训练的面部纹理编辑 LoRA，Red 为 fascinathan 转载。原作者推荐 5,000 或 5,600 步的两个训练存档。测试重点是毛孔、肤质和参考脸保持。 [Red 版本](https://civitai.red/api/v1/models/3044776) · [原作者模型卡与对照](https://huggingface.co/yang520333/Flux3-image-klein-natural-facial-skin-texture-lora) |
| **Sint Angle Klein 1.0** `3475115` | 11-23 | 单参考图改变相机视角。作者用 Distilled、16 步、Euler、CFG 1、约 1 MP 做测试，并报告方图及竖图比宽图有效。可用于同角色不同镜位的独立试验。 [作者](https://civitai.red/api/v1/models/3055122) |

Red 里的近期发布包含外观风格、补皮肤纹理、改变镜位等侧重编辑的 LoRA。AtomicChat 另外发布的 `Uncensored` 项目集中在文本编码器和提示词扩写器。其作者固定图像底模做的小样本测试，在艺术裸露和暗示性场景分别命中 8/10 和 7/10，替换文本组件后各类别最多波动一张，且原始提示词和图像没有公开。这个结果支持优先验证图像 LoRA 与任务匹配，实际出图成功率仍需独立测量。 [AtomicChat 发布者测试](https://huggingface.co/AtomicChat/FLUX-3-Image-Klein-GGUF#content-filtering)

## 官方底模

Black Forest Labs 于 2026-10-15 发布 **FLUX 3 Image Klein**。两款权重的图像 transformer 都是 5.6B，另配 Qwen3-VL-4B-Instruct 文本编码器和 FLUX.2 VAE。两款均支持文生图、图像编辑、最多 10 张参考图、最高 4K，以及提示词内的边界框控制。多参考是条件输入，人物身份、构图和未编辑区域的保留程度依赖具体权重与工作流。 [BFL 发布记录](https://docs.bfl.ai/release-notes#flux-3-image-klein) · [官方 ComfyUI 模型卡](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy)

| 底模 | 官方采样起点 | 公共 Hub API 的 `main` revision | 用途 |
| --- | --- | --- | --- |
| FLUX 3 Image Klein Base | 50 步，CFG 3.5 | `617a460237d514f6affc64684ca4e7fb2edecd5c` | 微调、LoRA 训练、以全步数建立画质基线。[模型卡](https://huggingface.co/black-forest-labs/flux-3-image-klein-base) · [Hub API](https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein-base) |
| FLUX 3 Image Klein Distilled | 16 步，CFG 1 | `3b767ff9b5261d71645e2ec49d87d298d955238d` | 低延迟文生图和编辑，BFL 官方 API 采用这一款。[模型卡](https://huggingface.co/black-forest-labs/flux-3-image-klein) · [Hub API](https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein) |

Hub API 显示 Base、Distilled 与 ComfyUI 分装仓库最近均于 11 月 19 日修改。权重仓库的提交明细需要授权，因此仓库修改日期只证明模型仓库有变动，权重是否更新未核实。ComfyUI 分装的 `main` revision 为 `09192d1abae1e57e1a2fcbc5b701cd1d9e2abd51`。 [BFL ComfyUI 分装 API](https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein-comfy)

BFL 验证了同代 Base 和 Distilled 的 LoRA 直接兼容，建议用 Base 训练，再用 Distilled 自己的 16 步、CFG 1 推理；其示例以 0.75 为强度起点。这个兼容结论限于 FLUX 3 Klein 同架构的适配器。社区模型仍需按其精确版本核对训练底模、目标任务和作者用法，尤其是文生图 LoRA 与以参考图、目标图和编辑指令训练的编辑 LoRA。 [BFL 模型文档](https://docs.bfl.ai/flux_3/flux3_image_klein#run-a-lora-on-klein-distilled) · [Diffusers 训练文档](https://github.com/huggingface/diffusers/blob/main/examples/dreambooth/README_flux3_klein.md)

上表的 Base CFG 3.5 来自 BFL 模型文档和 Civitai 站内默认值。BFL 的 GitHub 参考实现 README 给出 CFG 4，复现实验应写明采用的运行时和实际 CFG。 [BFL 模型文档](https://docs.bfl.ai/flux_3/flux3_image_klein) · [Civitai 发布公告](https://civitai.red/articles/36831/flux3-klein-edit-with-10-references-run-it-at-home) · [BFL 参考实现](https://github.com/black-forest-labs/flux-3-image-klein#model-overview)

## 本地复现

| 运行时 | 已核实的支持 |
| --- | --- |
| ComfyUI | BFL 分装为独立 diffusion model、Qwen3-VL-4B encoder、FLUX.2 VAE 和 prompt upsampler。Base 与 Distilled 的 transformer 均提供 BF16（11.1 GB）、INT8 ConvRot（5.8 GB）、NVFP4（5.3 GB）；4.9 GB INT8 编码器、0.3 GB VAE、9.8 GB INT8 或 6.7 GB W4A8 upsampler 另计。NVFP4 路线在 BFL 模型卡上指定 Blackwell。[官方权重与工作流](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy#files) · [Comfy 发布页](https://comfy.org/flux-3-image-klein) |
| Diffusers | 官方支持 ModularPipeline 以及 BF16、FP8 rowwise、NVFP4 单文件 transformer。官方 Demo 的 prompt upsampler 默认运行，编辑时会使用同一批参考图。[Diffusers 集成说明](https://huggingface.co/blog/flux-3) |
| Apple Silicon | MFlux 从 v0.23.0 支持 Base / Distilled 文生图、最多 10 张参考图的编辑、4/6/8 bit，以及 ComfyUI/AI Toolkit、Diffusers/PEFT、Kohya 格式 LoRA。Draw Things 桌面版 26.1020.0 与 CLI v26.1023.0 均宣布支持 FLUX.3 Klein。具体 Red checkpoint 是否能导入、性能和输出一致性仍待实测。[MFlux v0.23.0](https://github.com/mflux-community/mflux/releases/tag/v.0.23.0) · [Draw Things 下载页](https://drawthings.ai/downloads/) · [Draw Things CLI v26.1023.0](https://github.com/drawthingsai/draw-things-community/releases/tag/v26.1023.0) |
| stable-diffusion.cpp | 上游文档提供 FLUX.3 Klein / Base 的文生图、编辑加载示例，采用 FLUX.3 transformer、FLUX.2 VAE 和 Qwen3-VL-4B。 [上游文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/models/flux3.md) |

BFL 的独立 Qwen3.5-9B prompt upsampler 能把短指令和参考图改写为完整场景描述。官方建议使用它或同等的描述扩写。比较社区权重时应记录最终送入模型的描述、参考图、采样参数和随机种子，同时按作者说明单独复现其展示配方。短提示是否经过扩写会影响输出，尤其容易混淆编辑质量差异。 [BFL 提示词扩写说明](https://docs.bfl.ai/flux_3/flux3_image_klein#prompt-upsampling) · [官方 upsampler 模型卡](https://huggingface.co/black-forest-labs/flux-3-image-klein-pup)

## 权重许可

权重及其衍生版本受 `FLUX Kommunity License v1.0` 约束。§1.e 与 §2.a 允许符合条件的用户在生产环境生成商业输出，门槛是本人或主体与关联方的年化总收入合计低于 500 万美元。§2.e 要求合适的内容过滤或分发、展示、传输前审查，以及法定的 AI 内容披露。§2、§3 另行约束商业训练及权重分发。商用评估需同时阅读上游许可和各版本作者条款。 [FLUX Kommunity License 正文](https://huggingface.co/black-forest-labs/flux-3-image-klein/resolve/main/LICENSE.md)

§4.a 限制违法内容、非自愿私密影像及侵害第三方权利，§4.d 限制移除或规避 BFL 保护及使用限制。BFL 的 Usage Policy 要求，写实生成真人私密或性相关描绘须有经核实、留档且知情的同意。 [FLUX Kommunity License §4](https://huggingface.co/black-forest-labs/flux-3-image-klein/resolve/main/LICENSE.md) · [BFL Usage Policy](https://bfl.ai/legal/usage-policy)

## iDream 选型判断

先把 Klein 当成角色参考图编辑候选。文生图可用官方 Distilled 作基线，再加 Party Time 检查它对虚构成年女性的适用范围。保留身份、指定人物、相机角度及改变区域更适合单独测 Klein 的编辑优势，Sint Angle 和 Natural Facial Skin Texture 可各测试一项。当前证据不足以支持替换现用图片模型。 [BFL 的编辑能力说明](https://docs.bfl.ai/flux_3/flux3_image_klein) · [iDream 历史图片模型对照](IMAGE_MODEL_UPGRADE_REVIEW_2026-10-23.md)

做配对比较时固定角色、参考图、扩写后的提示词、分辨率和种子，记录底模 revision、权重哈希、LoRA 强度、实际步数和 CFG。保留每次输出和失败，评估身份、手部及身体结构、非目标区域变化、多人指令串扰，记录冷启动和稳态延迟。人物保持和成功率应由同一批独立样本及人工评价确认。
