# FineView / FixQW21T 与 REDQW21 + Viggle：M4 Max 六步实测

执行日期：2026-10-15 晚间，America/New_York；主要生成于23:14–23:42 EDT完成（UTC为10-16）。本报告只适用于下述文件、工作流、输入和本地运行证据。

## 当前结论

**建议保留现用 REDQW21 V2 + Viggle，暂不升级默认模型或VAE。** FineView 的 exact INT8 文件已下载、完整校验并在 M4 Max 上实际运行，沿用既有的常驻 BF16 加速后，与 RED 的六步热态中位数同为约49.2秒。六案例匿名评审解盲后五例偏好RED，一例存在人物相似性与场景服从取舍，综合平局；TextureFix VAE没有表现出明确速度或本组画质优势。

本次内容仅覆盖两位虚构成年女性的日常服、连体泳装、不透明内衣目录照；**没有裸露或性行为测试，不能据此宣布完整 NSFW 能力提升或下降。** 人物一致性也是有限案例的可见相似性判断，不是生物识别准确率或长期角色一致性认证。默认工作流未切换。

## 候选身份与真实资产

[FineView version3407540](https://civitai.red/api/v1/model-versions/3407540) 与 [RedCraft 3.0 / FixQW21T version3407259](https://civitai.red/api/v1/model-versions/3407259) 均为 AiMetatron 发布，主要 INT8、VAE及公开工作流的公布哈希相同，是同一套候选的两个入口。本次从无需凭据且可达的 RedCraft 端点取得 exact INT8；没有用近似模型替代 FineView 下载端点返回403的文件。

| 资产 | 实际文件与来源 | 大小 / SHA256 |
| --- | --- | --- |
| FineView / FixQW21T INT8 | `fineview_qw21_turbo_fixed_int8.safetensors`；[version3407259 / file3299030](https://civitai.red/api/download/models/3407259?fileId=3299030)，对应FineView file3299386 | 7,256,795,720 bytes；`712b44d2a79b30ed1aa11f19fc4e2cd0f1f46a43dc3bde5d6fe2a07e36b68f0f` |
| TextureFix BF16 VAE | `texture_fix_vae_for_qwen_image_2.1_bf16.safetensors`；[作者仓库固定revision](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/tree/702909b4d408912c7a28fadea06e8b7fdb38ef0c)，对应Civitai file3298969 / 3299190 | 675,509,688 bytes；`36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908` |

两份新资产均完成下载流及落盘重读的完整SHA256校验。基线 RED V2 BF16、原 Qwen2.1 BF16 VAE、INT8 ConvRot 文本编码器和 Viggle v0.3 r128 LoRA也在本轮完整校验。证据：[新模型收据](../../.scratch/fineview-comparison-20261015/download-model-verification.json)、[新VAE收据](../../.scratch/fineview-comparison-20261015/download-vae-verification.json)、[基线完整大小与哈希](../../.scratch/fineview-comparison-20261015/baseline-assets.json)、[独立来源核验](../../.scratch/fineview-comparison-20261015/ASSET_SOURCE_REVIEW.md)。来源核验中的“大权重尚未下载”描述是下载前阶段的状态，以后续收据为准。

## 同规格方法与 M4 加速

2×2因子对照，每组使用相同的六个案例：

| 实验组 | 有效模型配方 | VAE |
| --- | --- | --- |
| red-oldvae | 当前 REDQW21 V2 BF16 + Viggle v0.3 r128 | 原 Qwen2.1 BF16 |
| red-newvae | 同上 | TextureFix BF16 |
| fine-oldvae | FineView INT8 → exact反量化后常驻BF16；无额外Viggle | 原 Qwen2.1 BF16 |
| fine-newvae | 同上 | TextureFix BF16 |

四组统一832×1024、单参考图、相同参考字节/提示词/种子/身份包装、CFG1、Euler、现有Viggle六步sigma曲线、相同非近似prefix KV cache及MPS编码。没有放大、二次采样或追加LoRA给FineView。这里隔离的是可使用的**有效模型配方**和VAE，不能再把checkpoint训练、INT8量化及RED所需LoRA的影响分别归因。

M4 Max为128GiB统一内存，ComfyUI0.37.0 / Torch2.14.0 / Python3.13.12。使用此前已实现的 `IDreamQwen21ResidentWeights`：将受支持的INT8权重一次精确展开到BF16，保留原量化权重用于生命周期/卸载，避免采样期间反复展开；不会恢复量化已损失的精度。本轮日志记录224个常驻BF16权重，模型约13,571.1MiB，两次构建分别1.415及1.375秒。INT8磁盘文件较小不等于常驻执行只占7.26GB。[实际运行日志](../../.scratch/fineview-comparison-20261015/runtime-weight-log.txt)

额外同案例控制：FineView原INT8执行59.48秒，常驻BF16执行48.31秒；采样节点51.29→40.42秒。**两者最终latent及RGBA整图逐像素完全一致**。这是一个带加载/顺序影响的单案例，支持加速可用及数值未变，不作为稳定百分比估计。[原INT8请求](../../.scratch/fineview-comparison-20261015/fine-unaccelerated-control-report.json)、[latent与整图核对](../../.scratch/fineview-comparison-20261015/factor-control-verification.json)

所有主组经真实Gen provider、项目accelerator lease和原生idle检查提交。每图记录原生history、WebSocket执行/六步进度、输出字节和同一最终latent。采样计时为节点墙钟，包含节点中的准备开销，不是纯GPU kernel计时。保存latent只旁接同一采样结果，没有额外生成。

## 速度

每组首张单列，热态统计使用后五个相同案例。首张没有相同的OS/模型/缓存初始状态，不能称严格冷启动；FineView首次主组前已执行曲线控制。

| 配方 | 首张秒 | 后五张中位秒 | 后五张范围秒 | 采样节点中位秒 | VAE解码节点中位秒 |
| --- | ---: | ---: | ---: | ---: | ---: |
| RED + 原VAE | 47.32 | **49.19** | 47.16–56.21 | 41.55 | 1.80 |
| RED + TextureFix | 44.27 | 52.17 | 46.15–56.22 | 44.58 | 1.85 |
| FineView常驻 + 原VAE | 48.31 | **49.21** | 48.15–50.24 | 41.32 | 1.74 |
| FineView常驻 + TextureFix | 46.33 | 53.19 | 49.22–58.21 | 44.36 | 1.86 |

原VAE下模型中位差仅0.02秒；新VAE下FineView比RED约多1.02秒。均不支持明显速度升级。TextureFix两组端到端中位数较旧VAE高6.1%/8.1%，但采样节点本身也同时变慢约3秒，解码节点只差约0.05/0.12秒，**不能把整组差异因果归给VAE**。所有节点时间都是本次有限运行中的观察值。

| 案例 | RED+原VAE | RED+TextureFix | FineView+原VAE | FineView+TextureFix |
| --- | ---: | ---: | ---: | ---: |
| a-cafe | 47.32 | 44.27 | 48.31 | 46.33 |
| a-swimwear | 48.19 | 46.15 | 48.15 | 57.19 |
| a-lingerie | 47.16 | 46.25 | 50.24 | 58.21 |
| b-library | 49.19 | 52.17 | 48.19 | 53.19 |
| b-swimwear | 56.21 | 56.22 | 49.21 | 50.19 |
| b-lingerie | 53.19 | 55.23 | 50.21 | 49.22 |

执行顺序是RED原VAE→RED新VAE→固定latent重解码→FineView曲线控制→FineView新VAE→FineView原VAE→原INT8控制→RED重复。模型下载与部分RED阶段重叠；所有FineView阶段在下载完成后运行。最后RED的a-cafe / b-library为55.32 / 53.20秒，较最初47.32 / 49.19秒高，且前者包含模型切换；重复图均逐像素一致。这确认了会话顺序/负载漂移，不能把几个百分点当作稳定胜负。没有多轮随机交错的统计重复。[原始汇总](../../.scratch/fineview-comparison-20261015/summary.json)、[29次扩散请求逐项计时/ID/hash](../../.scratch/fineview-comparison-20261015/verified-runs.json)

## 画质、人物相似性与服饰效果

独立上下文的评审agent仅查看去元数据、逐案例随机排列的六张四候选面板、24张原尺寸候选及参考/提示词，没有模型、VAE、速度或映射信息；先保存评审与结构化分数，再解盲。它是一次AI视觉评审，没有人类多评审或客观生物识别分数。相同模型两种VAE在每个案例均未能可靠排序。

| 案例 | 解盲后的综合偏好 | 主要可见依据与不足 |
| --- | --- | --- |
| A咖啡馆 | RED，两种VAE并列 | 眼形、眉弓、较窄下半脸和波浪发束更接近参考；FineView脸较圆、皮肤较平滑。两者衣物、双手持杯和场景均基本落实 |
| A泳装 | 取舍平局 | RED参考相似性较强，但保留了木门边的参考环境；FineView更像要求的露天池边。两者均缺脚，FineView膝部交叉也不等于要求的踝部交叉 |
| A内衣 | RED，两种VAE并列 | RED眼鼻、下颌及肤色起伏较近参考；两模型都裁至大腿，未满足全身，高腰及full-coverage也未充分落实 |
| B书房 | RED，两种VAE并列 | 眼鼻、笑纹和成年面部细线较近参考，毛衣材质更连续；FineView更平滑。双手持书等指令均基本落实 |
| B泳装 | RED，两种VAE并列，脸部置信度较低 | RED整体笑容/脸轮廓与材质观感更近参考；两者主要正面，未充分落实三分之四角度。脸小，不能核验精确眼色、雀斑或年龄 |
| B内衣 | RED，两种VAE并列 | RED椭圆脸、鼻部和笑线较近参考；两者全身、衣物、摄影棚基本落实。小手脚细节不能逐指逐趾保证正确 |

本组FineView更常见光滑皮肤、圆润或轻微年轻化的面部观感，未见稳定的人物相似性提升。泳装/内衣能生成不透明服饰，不等于完整NSFW解锁或解剖能力已经验证；共同裁切问题仍是实际产品缺点。没有观察到明确严重的额外/断裂肢体，但遮挡、小脸和小手脚限制了判断，不能将“未发现”写成完美解剖。

原始证据：[匿名评审](../../.scratch/fineview-comparison-20261015/review/BLIND_REVIEW.md)、[匿名分数](../../.scratch/fineview-comparison-20261015/review/scores.json)、[解盲及评审文件哈希](../../.scratch/fineview-comparison-20261015/decoded-review.json)。同原VAE的标注图：[日常服](../../.scratch/fineview-comparison-20261015/comparison/models-clothed.png)、[泳装](../../.scratch/fineview-comparison-20261015/comparison/models-swimwear.png)、[内衣](../../.scratch/fineview-comparison-20261015/comparison/models-lingerie.png)。

## VAE独立影响

同一模型的旧/新VAE六案例最终latent，在RED和FineView两侧共12对均完全相等。新旧VAE文件有238个tensor，其中184个原始字节不同，不能因最终latent相同就说文件或编码器权重相同。**本组实际结果中的差异可定位到解码后的输出。**

另取RED的a-cafe、b-library、b-swimwear保存latent，分别只用旧/新VAE解码，不重跑扩散、不重新编码参考图。旧VAE重解码与原输出全部逐像素一致。新旧VAE的RGB平均绝对差分别0.86 / 1.22 / 1.02，按0–255通道值计；这只是差异大小，不是质量分数。

匿名评审查看三组全图及同位置2× nearest细节图，**四张全部平局**：未观察到明确的真实感、解剖或身份优势；细纹理/局部对比存在很弱变化。nearest放大不会补出原图不存在的细节。作者VAE卡中的纹理与FP16 NaN改善声明不能替代本组实测；本轮VAE均为BF16，没有测FP16收益或NaN压力集。[固定latent结果与核对](../../.scratch/fineview-comparison-20261015/decoder-only-verification.json)、[VAE盲评](../../.scratch/fineview-comparison-20261015/review-decoder/BLIND_REVIEW.md)、[作者模型卡](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/blob/702909b4d408912c7a28fadea06e8b7fdb38ef0c/README.md)

## 调度边界

作者公开附件实际是 `er_sde/simple`、shift1.31、CFG1，先8步，再放大1.5×重编码后8步、denoise0.7，不能与本次单次六步称同规格。附件的UNET预填名称也不是本次INT8文件。[公开附件及实算哈希核验](../../.scratch/fineview-comparison-20261015/ASSET_SOURCE_REVIEW.md)

另在a-cafe / b-library用FineView、原VAE、相同Euler，将曲线改为simple / shift1.31但保持单次六步，实际44.29 / 46.19秒；这是**借用作者曲线的六步改写**，不是完整作者配方或作者推荐六步。本报告不评价8+8步的最高画质，也不把当前sigma比较外推为候选所有参数下的能力上限。

两案例独立匿名评审均弱偏好simple / shift1.31：脸形稍窄、材质观感略贴参考，但指令/解剖没有明确优势，更密织纹不足以证明更真实。未达到计划中“实质改善后扩大六案例”的触发条件，因此没有继续消费生成；**这只能说明曲线值得保留为探索选项，不能宣布其六步最佳或已经超过RED。** [曲线盲评](../../.scratch/fineview-comparison-20261015/review-curve/BLIND_REVIEW.md)、[两次真实执行](../../.scratch/fineview-comparison-20261015/fine-authorcurve-curve-report.json)

## 验证、恢复与适用范围

共29次扩散请求（24主组+2曲线+1原INT8+2RED重复）及6次只解码请求，35个唯一原生request ID，均成功。29次扩散的原生图均只有一个sampler、实际进度1–6、832×1024输出，最终latent全部有限；原生输出/交付/落盘图哈希一致。6次只解码图也核对了原生图与保存图哈希、同一latent哈希及图中无sampler。基线六图还与此前RED六图逐像素一致。[全部验证汇总](../../.scratch/fineview-comparison-20261015/summary.json)、[latent形状/有限值/hash](../../.scratch/fineview-comparison-20261015/verified-latents.json)、[RED复现](../../.scratch/fineview-comparison-20261015/baseline-reproducibility.json)

本次执行绑定：

- iDream HEAD：`7e26cea97a26ca7a5703077f4dbdd607e808023f`。
- 实际含既有未提交加速代码的source revision：`idream-worktree-74918f2ec4235a3f64e1c83a328ca56149210bd46af792661d107bfb86370db1`；所有请求及生成结束后的核验一致。不能只用HEAD代表实际执行源码。
- ComfyUI：`88ab4a06566454ad89db8f0bedb970d6c08cd1b7`。
- 默认descriptor SHA256：`573fbb85c90ef71dd037496197ed77b0cc9d7ec92d97c57c7c92f87d9cde2eb5`，前后未变。六套实验descriptor哈希见[计划](../../.scratch/fineview-comparison-20261015/plan.json)，每次原生history保留实际执行图。
- 工具脚本见[benchmark.ts](../../.scratch/fineview-comparison-20261015/benchmark.ts)。RED两组在扩展原INT8控制及脚本哈希记录之前运行，[初版脚本哈希](../../.scratch/fineview-comparison-20261015/benchmark-initial-sha256.txt)单独保存；后续报告记录自身harnessSha256。扩展没有改变主组提交及计时语义。

本轮只增加实验数据、辅助脚本、下载模型及研究记录，没有改动运行时代码、默认配方或数据库。使用真实本地Gen provider，不创建Main Turn/Job、不扣梦币、外部推理API费用0；没有测用电成本，也没有验证BFF交付、产品持久化或生产就绪。

测试前仅comfyui-image注册且stopped，8188/8189/8190均未监听。通过canonical PM2配置与项目lease启动，排空后同一路径停止；结束时确认恢复stopped / PID0、三个端口均不可达。最终swap使用1114.62MiB，系统未记录thermal/performance warning；只有中途/结束快照，没有完整初始swap与峰值采样，不能宣称零swap增量或给出峰值内存。[恢复、源码及descriptor核验](../../.scratch/fineview-comparison-20261015/final-state-verification.json)

本组只覆盖两位成年女性、单参考编辑、六个固定种子/场景；没有男性、多人物、多参考、文生图、多轮编辑、长期角色记忆、露骨NSFW或其他硬件数据。下载后的两份新模型资产保留供复现，实验图及原生history保存在本地证据目录。
