# RedCraft QW21 Fixed 本地接入

> 后续配置已更新为 profile/workflow **v2：作者首轮 8 步、er_sde/simple、shift 1.31、CFG1**。下文原接入及六步性能记录属于 v1 历史证据；当前配置及三次实际验证见文末。

2026-10-16，America/New_York。已在当前工作区及本地开发库接入 **RedCraft 3.0 / FixQW21T INT8**，显示名 `RedCraft 3.0 · QW21 Fixed`，作为显式选择的图片模型。原有40条模型配置（含默认项及历史版本）在发布前后完整内容哈希一致。没有部署公开生产服务。

## 接入契约

- Main profile：`image-redcraft-qw21t@1`，active/enabled，显式选择，不参与自动回退；可供文生图、Character单参考及图片编辑选择。
- Gen model / workflow：`redcraft-qw21t@1`，同一图支持零或一张参考。移除可选参考时同步移除加载节点及编码器引用，不留悬空缩放链。
- 配方：832×1024、4:5、每次一张、单路并发、Euler六步、CFG1、既有六步sigma网格、无额外Viggle LoRA及第二次采样。
- 扩散权重：exact INT8一次展开为BF16常驻；文本编码器使用既有INT8 ConvRot、MPS；VAE为配套TextureFix BF16，保留既有Qwen2.1 MPS temporal-padding修正。
- 价格倍率1.5，沿用现有单源图片编辑档位；原有定价、默认路由、历史Job/Attempt及数据库schema不变。本次开发库仅新增这一配置行。

链接是包含H3、Krea和Qwen版本的合集，本次只接入[version3407259 / QW21 Fixed](https://civitai.red/api/v1/model-versions/3407259)的INT8文件3299030。没有将页面标题中的W6A8当作M4原生INT8加速声明，也没有接入其他架构或另一个量化文件。

扩散文件本地名为 `fineview_qw21_turbo_fixed_int8.safetensors`，是前轮已下载的同哈希RedCraft资产，可直接复用。当前[作者API](https://civitai.red/api/v1/models/958009)再核验记录见[来源版本](../../.scratch/redcraft-integration-20261016/source-versions.json)。

## 实际运行

通过仓库 `smoke:backend` CLI → 真实Gen provider → 原生ComfyUI执行，使用canonical PM2定义、项目accelerator lease及原生idle检查。没有给CLI传 `--steps`，验证其遵循新描述符的六步默认；原先文生图smoke硬编码十步会破坏这类工作流，本次已修正。

| 路径 | 内容 | 耗时 | 原生prompt ID | 输出 |
| --- | --- | ---: | --- | --- |
| 文生图 | 虚构38岁成年男性，穿毛衣和长裤在书房看书 | 33.59秒 | `5c162e05-7bb9-4c92-9341-6cabf661ea7b` | [832×1024 PNG](../../.scratch/redcraft-integration-20261016/text-to-image.png) |
| 单参考编辑 | 既有虚构36岁成年女性参考，牛仔外套、白衫、双手持杯 | 50.52秒 | `4c6fd98d-ec4d-4ff5-a6ed-636d61fce744` | [832×1024 PNG](../../.scratch/redcraft-integration-20261016/single-reference.png) |

时间为包含CLI启动、provider执行、验证与落盘的单次墙钟值，不能当作稳定性能分布或与前轮热态中位数直接比较。两次原生history确认exact模型/VAE、MPS常驻、六步sigma节点、单采样器和有/无参考分支；原生输出、交付和保存PNG哈希一致。记录：[完整调用、hash及source revision](../../.scratch/redcraft-integration-20261016/live-smoke-report.json)、[文生图history](../../.scratch/redcraft-integration-20261016/text-to-image-history.json)、[参考编辑history](../../.scratch/redcraft-integration-20261016/single-reference-history.json)。

另有一次文生图生成成功，但初版核验脚本用未锚定正则将 `KSamplerSelect` 误计为采样器，核验失败。已改为精确采样节点类型集合，保留首轮输出/日志/[失败记录](../../.scratch/redcraft-integration-20261016/first-attempt-live-smoke-report.json)，随后重跑上述两路径。实际共3次本地生成，没有将核验失败隐去或算成模型执行失败。

逐图查看确认图片可读且为普通服装人物。参考编辑仍保留了明显的木门环境，没有充分实现咖啡馆场景替换；接入成功不等于该指令或人物一致性已经达标。没有执行露骨NSFW测试，也不改变[前轮对比的范围与结论](FINEVIEW_QW21T_COMPARISON_2026-10-15.md)。

## 权重、源码与发布证据

本轮重新完整读取扩散、编码器及VAE校验SHA256，并证明image runner从指定模型根目录唯一解析这些资产、16种所需节点均注册、loader下拉框能见到对应文件。[运行前资产与节点核验](../../.scratch/redcraft-integration-20261016/runtime-attestation.json)

| 资产 | SHA256 |
| --- | --- |
| RedCraft INT8 | `712b44d2a79b30ed1aa11f19fc4e2cd0f1f46a43dc3bde5d6fe2a07e36b68f0f` |
| INT8 ConvRot文本编码器 | `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f` |
| TextureFix BF16 VAE | `36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908` |

实际执行source revision：`idream-worktree-d2bec8dd58d7cf64e0bb26fd407f01cfeaa6660a3a87a42b37e710920e979a5f`，包含当前工作区既有的未提交resident加速代码。本报告及README是在生成结束后补写。新descriptor SHA256：`bb2e52b756b03e3d80e4388e6bfcba0c72446b20576a1ddd71dfd8ed3ae34c59`。

数据SQL在专用 `idream_test` 库实际验证了首次发布、重复执行不改行、配置冲突拒绝及所有旧配置不变；seed发布同样的配置。开发库目标经核对为localhost:5433 / `idream_runtime_20260812`，仅运行任务内幂等SQL，没有全量重seed。发布后再次执行SQL验证幂等，原有40条配置完整哈希保持 `87e7526c610ad48865682e2281a94064328c8cd53321894a1ac072be69e3f75f`。[开发库发布与恢复收据](../../.scratch/redcraft-integration-20261016/published-profile.json)

验证命令：

```bash
bun run --filter @idream/gen test
bun run --filter @idream/gen typecheck
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/idream_test REDIS_URL=redis://127.0.0.1:6379/15 bun run --filter @idream/main test prisma/redcraft-qw21t-profile.test.ts src/server/modules/ourdream/generation-profile-selection.test.ts src/server/modules/admin-v2/creative/create-options.integration.test.ts
bun run --filter @idream/main typecheck
bun run --filter @idream/main lint prisma/seed.ts prisma/redcraft-qw21t-profile.test.ts
git diff --check
```

Gen359项测试、Main相关14项测试、两侧类型检查及定向lint通过。完整preflight涉及另外两个视频runner，本次没有启动它们或冒称整套服务preflight通过；完成的是上述image专用实际资产/节点核验。没有跑BFF/产品Job交付与扣费全链路；本次provider级验证不创建产品Job、不扣梦币，外部推理API费0，未计用电。

测试前仅image runner注册且stopped。完成后原生队列为空，经相同PM2配置停止，确认stopped/PID0；其他产品与视频服务未启动。新profile已在本地开发库可选，启动应用与Gen服务后使用这一配置。

## 后续提速筛选：2026-10-16 晚间

目前没有新增可采用的同规格加速收益。前轮同checkpoint六步编辑的后五张中位数拆分为：采样41.32–44.36秒，encoder loader约1.24–1.28秒，conditioning约3.57–3.64秒，释放barrier约0.59–0.68秒，VAE解码约1.74–1.86秒。各项中位数不能直接相加；旧对照与新接入图的参考编码尺寸不同，不把它冒称当前新图的逐节点实测。[节点事件计算结果](../../.scratch/redcraft-speed-20261016/phase-breakdown.json)

重点筛选了现有视频MPSGraph注意力方案。使用**图片原有Torch2.14.0**，只为实验进程追加已安装mps-sdpa0.2.0的模块路径，另建Torch2.14专用扩展缓存；没有安装/升级图片venv、使用视频Torch2.11或复用其二进制。首轮桥接编译因Xcode编译器与CLT macOS27 SDK不匹配而链接失败；只对实验子进程设置配套Xcode macOS26.5 `SDKROOT` 后编译并运行成功，没有修改系统工具链。[首轮失败记录](../../.scratch/redcraft-speed-20261016/attention-screen-sdk-link-failure.json)

在项目accelerator lease及原生idle检查下，使用32头、head-dim128、BF16的合成Qwen尺寸Q/K/V，计时含包装器所需的布局处理，MPS同步前后计时，每路径五次、交替顺序。数值对比固定选取的head/row与CPU float64参考，均在基于BF16舍入的预设容差内；每组计时后的11次原生MPSGraph调用与空fallback计数确认未退回stock。**合成输入不是实际模型激活，容差通过也不代表整图逐像素相同或画质已经验证。**

| Q tokens / KV tokens | 当前PyTorch中位ms | MPSGraph comfy中位ms | MPSGraph显式BF16中位ms |
| --- | ---: | ---: | ---: |
| 3328 / 3584 | 16.00 | 16.30 | 16.20 |
| 3328 / 7680 | 34.41 | 35.42 | 35.86 |
| 4096 / 4352 | 23.42 | 24.28 | 24.29 |

当前环境下Comfy的upcast设置为None，comfy与显式BF16两种包装均使用BF16输入。三个尺寸均未看到MPSGraph优于当前PyTorch，因而未接入，也没有继续消耗完整出图做候选A/B。不能把这个短环结论外推成所有形状/运行时/硬件上MPSGraph都更慢。[最终短环数据](../../.scratch/redcraft-speed-20261016/attention-screen.json)、[简要汇总](../../.scratch/redcraft-speed-20261016/screen-summary.json)

本轮没有生成新图片、改动模型/步数/分辨率/权重、修改数据库或启动服务。QKV/MLP融合、编码缓存、四步及较低分辨率均未在本轮测试，不承诺其速度或人物一致性收益；后两项会改变原六步同规格口径。

后续已完成完整的六步瓶颈与优化对照，并落地无损的跨请求前缀复用：相同输入重复出图可提速，换输入仍重算，画质与人物输出逐像素一致。新的实测、失效条件和 MPS 回收证据见[RedCraft M4 优化报告](REDCRAFT_M4_OPTIMIZATION_2026-10-16.md)。

## 作者首轮采样配置（v2）

按用户要求，将 canonical `redcraft-qw21t.json` 原地更新为版本 2。采用[已核验的作者附件](../../.scratch/fineview-comparison-20261015/ASSET_SOURCE_REVIEW.md)首轮：`KSampler(er_sde/simple, steps=8, CFG=1, denoise=1)`，上游 `ModelSamplingAuraFlow(shift=1.31, sampling=flow)`。删除该图原有 Euler/Viggle sigma 分支。保留 832×1024、同一 INT8 diffusion、ConvRot 编码器、TextureFix VAE、BF16 常驻与前缀 KV 复用，不加 Viggle LoRA。

这是作者**首轮采样参数**的接入，不是完整作者图；作者另有 1.5× 放大重编码后再跑 8 步、denoise 0.7 的细化阶段，本次没有加入。附件预填的 UNET 文件名与本地 exact INT8 不同，因此不能声称已复刻作者完整出图效果。

使用真实 Gen provider → ComfyUI，省略请求中的 steps，由描述符默认值决定。三次均观察到实际进度 1–8、单个 KSampler、正确采样器/调度/shift/权重/VAE，原生输出、交付与保存 PNG 哈希一致：

| 路径 | 原生全程 | 采样阶段 | 原生 request ID |
|---|---:|---:|---|
| 文生图 | 48.944 秒 | 37.233 秒 | `034b9b77-74b6-45c6-9886-5f90d9de3624` |
| 单参考编辑 | 58.724 秒 | 51.178 秒 | `af42a2aa-2664-42f5-99d4-7d8dbae57048` |
| 同参考/提示词，换种子 | 56.669 秒 | 48.865 秒 | `87ebd806-fd3b-4b8f-b044-7d9268d85aa6` |

每条只有一次，耗时含加载波动，不能用作稳定分布或六步对八步的质量/速度对照。三次前缀事件为 miss → miss → hit，证明新采样配置仍能命中缓存；本轮没有追加关闭缓存的八步像素对照。输出为普通着装的成年虚构人物；未重新评价 NSFW 或人物一致性是否升级，也未走 Main 计费链。外部推理费用与扣减均为 0。

[真实执行记录与逐步事件](../../.scratch/redcraft-eight-step-20261016/canonical-eight-step.json)、[服务恢复与缓存日志](../../.scratch/redcraft-eight-step-20261016/verification.json)、[文生图](../../.scratch/redcraft-eight-step-20261016/outputs/canonical-eight-step-t2i.png)、[参考编辑](../../.scratch/redcraft-eight-step-20261016/outputs/canonical-eight-step-a.png)。生成绑定 source revision `idream-worktree-ad6aa0f90f712d6feb79bdc81ddaa0e0039301cdf0ef303d26b84faab591d6d0`，描述符 SHA256 `dadc3afb964c47ec801eb40122ed66d5114b2fe2ff2367f9da2c8c726bdc06a9`。后续仅补强 SQL 拒绝条件、测试及文档，执行图与 Python 运行时代码未再改。

新 seed 发布 v2；同一数据 SQL 支持新建或从已发布的精确 v1 迁移，归档旧行、保留旧参数和历史 Job。存在待处理 RedCraft Job、配置冲突或人为改动定价时拒绝切换；重复执行不改行。专用 `idream_test` / Redis15 的发布回归通过，另有 Gen 工作流/CLI/preflight 29 项、Main 选择与发布 15 项通过，Main/Gen typecheck 与目标 Main lint 通过。

开发库已核对为 localhost:5433 / `idream_runtime_20260812`，仅执行该 SQL，并核验旧 v1 参数、其余 40 行完整内容、历史 Job 均保留。发布后重复执行验证幂等。PM2 与原生队列检查通过，图像服务恢复到任务前 stopped 状态；没有部署生产。[开发库发布收据](../../.scratch/redcraft-eight-step-20261016/publication.json)。

## 作者八步与 RED＋Viggle 六步重新对照

**本轮已测的速度与参考脸保持，不支持用 RedCraft 替换默认 RED＋Viggle。NSFW 效果未验证，不能据此判断成人内容能力是否升级。** 本轮只生成普通着装的成年虚构人物，没有用泳装或内衣代替 NSFW 测试。

### 输入与隔离

M4 Max / 128 GiB、Torch 2.14.0、ComfyUI 0.37.0 / `88ab4a06566454ad89db8f0bedb970d6c08cd1b7`，832×1024、CFG1、每次一张图片、每人一张身份参考。两位固定参考人物，每人一个场景、两个固定种子：A 为 2026101602 / 2026101603，B 为 2026101104 / 2026101107；每个配对使用相同参考文件、最终编码文本、空负面文本、种子与输出尺寸。

三组各四张：①现用 REDQW21 V2 BF16＋Viggle v0.3 LoRA、Euler 六步、旧 VAE；②RedCraft exact INT8＋BF16 常驻、作者首轮 er_sde/simple 八步、shift1.31、旧 VAE；③在②基础上只替换 TextureFix VAE。②③均保留已接入的无损前缀复用，无额外 Viggle LoRA，无放大后第二轮八步。①②比较的是模型与采样配方整体，不是仅替换 checkpoint 的试验。

核验发现正式工作流还有两个输入差异，本轮用 scratch 描述符及输入显式校准，**未改正式图或 provider**：

- 原参考 A 为800×1003、B为832×1216；一次性按比例缩放、居中白色补边到832×1024，同一 PNG 上传三组，保留原始文件与 SHA。参考编码统一 resolution0，避免 RedCraft 默认1024的面积缩放；RED 的 ImageScale 对相同尺寸输入不再缩放。
- RED provider 自动添加身份/背景替换指令，RedCraft 没有。本轮向 RedCraft 显式提供同一前缀，逐张断言最终 encoder prompt 完全一致，不只比较用户输入的原始字符串。

因此这是**统一预处理和身份提示后的受控配方对照**，不是当前两套正式默认输入处理的完整产品链路基准；也不是作者完整8＋8工作流的画质上限。每个人物/方案都新启原生进程，先首张，再相同提示词/参考换种子；A按①②③、B按③②①运行，减轻顺序偏差。每张确认单采样器、实际1–6或1–8进度、exact模型/VAE/LoRA、参考上传字节一致、832×1024输出及原生/交付/落盘PNG一致。另保存每张最终latent并核对shape `[1,64,64,52]`、全部有限。

### 速度

原生 Comfy execution_start → execution_success，单位秒；不含服务启动和提交前资源等待，包含本次模型加载、编码、采样、解码与保存latent。各格为两个不同人物的中位数，不是同一人物的多次稳定分布；完整 provider wall、resourceWait 及节点耗时均保留。

| 方案 | 新进程首张 | 同提示词/参考，换种子 | 首张采样阶段 | 换种子采样阶段 |
|---|---:|---:|---:|---:|
| RED＋Viggle六步＋旧VAE | 49.452 | 51.664 | 41.085 | 44.032 |
| RedCraft作者八步＋旧VAE | 64.774 | 59.203 | 55.027 | 51.110 |
| RedCraft作者八步＋TextureFix VAE | 63.318 | 55.310 | 54.626 | 47.758 |

带TextureFix的八步方案相对六步：首张中位数用时增加 **28.0%**，重复出图增加 **7.1%**。原始四配对全程（RED / RedCraft旧VAE / RedCraft新VAE）：A1 `47.304 / 69.074 / 65.644`；A2 `52.093 / 63.775 / 55.992`；B1 `51.600 / 60.474 / 60.991`；B2 `51.234 / 54.631 / 54.627`。

八步两种VAE、两个人物均记录 miss → hit；命中后仍实际跑完八步。没有本轮关闭缓存控制，不能将全部首张/重抽差异归于缓存。RED第二张比首张略慢，也说明加载以外仍有运行波动。尤其A的旧/新VAE重抽差约7.8秒，在B没有重现（54.631 / 54.627）；不能把它宣称为VAE加速。各组解码阶段约1.72–2.07秒，额外耗时主要在八步采样。小样本不支持普适的百分比承诺。

### 人物与画质

每个配对随机匿名排序，剥除图片模型/生成元数据；先保存P1–P3观察及分数文件，再解盲。评阅者为**同一助手的一次匿名目视检查，不是独立盲评、人类多评审或客观人脸识别分数**。检查四张完整匿名面板，并额外查看A2/B2两类配方的原尺寸图；细指遮挡处不作完全正确声明。

四个配对均偏好RED的参考脸保持：A两例差异较清楚，RED的眼眉比例、较窄下半脸与波浪发更贴参考；RedCraft的脸更圆、更平滑。B两例差异较弱，三者都可辨识地接近参考，RED的椭圆脸、眼鼻比例及发型轮廓稍近。**这不证明RedCraft无法保持人物**：两套方案在各自两个种子之间都维持了相似的人物外观；没有证据说明八步改善了相对六步的身份保持。每个人物只测一个场景，未评跨场景长期一致性。

三组均落实对应的衣物、杯子/书、咖啡馆/图书馆和目视镜头，未看到明确严重的可见肢体结构问题。参考A嘴部被手遮挡，不能严格核验唇形；不能从这些像素确认确切年龄、眼色或逐点雀斑。B的RedCraft毛衣纹理更密，并不足以判为更真实。

RedCraft新/旧VAE的**四对最终latent原始tensor字节完全一致**；RGBA输出有差异，RGB MAE约 `0.96–1.28 / 255`，局部最大差异33–40。MAE只量化差异，不是质量分数。匿名目视四对VAE均平局，未发现清晰的人物或整体画质优势；本组差异可定位到解码输出。这里不能推广为新旧VAE编码器权重相同，也未测FP16稳定性。

### 结论与证据

在本次统一输入、约0.85 MP单参考设置下，作者首轮八步没有带来速度优势，人物保持也未显示升级收益；**保留RED＋Viggle作为默认，RedCraft维持显式可选项**。由于最优先的NSFW效果没有实测，本轮不能给出NSFW升级结论，也不应把普通着装表现当作替代证据。本轮没有更改模型默认路由、正式描述符、数据库、系统设置或依赖。

共13次原生生成成功：12次有效对照，加1次首轮核验失败。首张因核验器误将最终encoder文本等同于原始用户文本而拒绝计入，暴露了上述自动身份前缀差异；保留其PNG、latent和失败记录。统一文本后重新运行，原首张与正式RED A1重跑逐像素一致；没有模型执行失败或无限重试。所有请求为本地Gen provider，不创建Main Job、不扣额度，外部推理费用0；每组均使用项目accelerator lease、原生idle检查及canonical PM2配置。结束后恢复唯一图像服务stopped/PID0，8188/8189/8190关闭。

实测source revision为 `idream-worktree-afc9a6fe4f54557fb23b6c10d5370f4dd138c528dcba3c4f1012d96cdc94f381`；后续只追加文档，正式执行图/运行时代码保持不变。三份实验图及参考文件的hash保存在manifest，每次执行记录各自描述符hash。六项模型资产重新实算hash，与既有固定资产一致。

- [两个人物的标注总览（每人首个预定种子）](../../.scratch/redcraft-eight-vs-viggle-20261016/comparison-first-seeds.png)
- [实验输入、三份图及hash](../../.scratch/redcraft-eight-vs-viggle-20261016/manifest.json)、[完整运行顺序](../../.scratch/redcraft-eight-vs-viggle-20261016/matrix.json)、[逐张核验、native ID、节点耗时及VAE latent比较](../../.scratch/redcraft-eight-vs-viggle-20261016/analysis.json)、[资产hash](../../.scratch/redcraft-eight-vs-viggle-20261016/assets.json)
- [A1匿名图](../../.scratch/redcraft-eight-vs-viggle-20261016/review/a-s1-anonymous.png)、[A2匿名图](../../.scratch/redcraft-eight-vs-viggle-20261016/review/a-s2-anonymous.png)、[B1匿名图](../../.scratch/redcraft-eight-vs-viggle-20261016/review/b-s1-anonymous.png)、[B2匿名图](../../.scratch/redcraft-eight-vs-viggle-20261016/review/b-s2-anonymous.png)、[解盲与评阅文件hash](../../.scratch/redcraft-eight-vs-viggle-20261016/decoded-review.json)
- [被排除的首轮核验与原生输出](../../.scratch/redcraft-eight-vs-viggle-20261016/first-validation-failure/receipt.json)、[运行环境](../../.scratch/redcraft-eight-vs-viggle-20261016/runtime-environment.json)
