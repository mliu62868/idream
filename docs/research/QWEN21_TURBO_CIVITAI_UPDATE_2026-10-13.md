# Qwen-Image-2.1-Turbo：Civitai.red 更新核验

最新核验时间：2026-10-15 21:52 EDT（America/New_York）。本轮按作者公开Checkpoint目录反查，不限制底模标签；下方保留20:14的全目录增量和05:43的完整复核。本轮未查看图片像素、下载权重、执行生成或更改服务。

**有新微调发布。RedCraft作者AiMetatron于今天发布的FineView / RedCraft FixQW21T，版本说明明确标为RED QW21 Turbo Texture Fixed微调；_Envy_也于今天发布了Qwenvy及Turbo分支，并明确说明对Qwen2.1做了微调。** CoffeeMix是另一个Turbo发布条目，但作者尚未披露微调/合并方式。不能因尚未完成本机实测而把“已经发布新微调”说成“没有新模型”。

后续本地实测：2026-10-15 23:42 EDT完成[FineView / FixQW21T 与 RED + Viggle 的 M4 Max 六步对照](FINEVIEW_QW21T_COMPARISON_2026-10-15.md)，分别替换模型和VAE，并加入固定latent重解码、原INT8及顺序控制。原VAE下两模型热态中位数均约49.2秒，目前没有足够收益支持切换默认；内容仅覆盖成年虚构人物的日常服、泳装、不透明内衣，不构成露骨NSFW效果验证。下方“未实测”均保留其公开目录核验时点的历史含义。

## 2026-10-15 21:52 按作者反查

本轮以`username=作者&types=Checkpoint&limit=100&nsfw=true`查询作者公开目录，**不加baseModels过滤**，逐个检查Qwen2.1版本，避免漏掉多底模页面、混合标签或模型标题改变。覆盖10位作者、共177个不同Checkpoint页面：AiMetatron8、_Envy_48、Barista7为4、Ray3780为13、8stepmafia6、noctaluna4、Felldude47、FASCIUM18、Stable_Yogi26、fwaunstp733为3；每位均不足100且无下一页。此处是有明确边界的作者集合，不把“知名作者”当作可穷尽的客观名单，也未覆盖私有/未公开模型。[主组作者原始汇总](../../.scratch/qwen21-civitai-20261015-authors/main-authors-summary.json)、[另一组一手核验](../../.scratch/qwen21-civitai-20261015-authors/OTHER_AUTHORS.md)

| 作者 | Qwen2.1 / Turbo发布 | 对“新微调”的判断 |
| --- | --- | --- |
| **AiMetatron（RedCraft / REDQW21）** | [FineView3407540](https://civitai.red/api/v1/model-versions/3407540)、[RedCraft3407259](https://civitai.red/api/v1/model-versions/3407259)，10-15发布 | **作者明确声明微调及重度修改。** 两页主要文件hash相同，是同一套新候选；不是把两个名字算成两次训练。当前RED的同作者后续版本，应优先比较 |
| **_Envy_** | [Qwenvy2.1 / 3002606](https://civitai.red/api/v1/models/3002606)，10-15发布v1.0及v1.0-turbo | **作者明确说通过微调修正噪声、改善细节。** Turbo分支已发布，但该分支说明为空，具体训练/蒸馏谱系未披露，不把20步样例外推成六步结果 |
| **Barista7（CoffeeMix）** | [Borgia Turbo / 2998444](https://civitai.red/api/v1/models/2998444)，10-12发布 | 明确是2.1 Turbo checkpoint；训练/merge细节未披露。应列Turbo候选，不能直接升级为已核验的NSFW专用微调 |
| **Ray3780** | [Ray turbo v1.3 / 3395380](https://civitai.red/api/v1/model-versions/3395380)，10-09发布 | 作者明确官方Turbo重制及解锁；已是现有候选，今晚未新增版本 |
| **noctaluna** | [Noct Q / 2958896](https://civitai.red/api/v1/models/2958896)，V3 Turbo六步与V4 Base | 有自己的Qwen2.1少步成人模型，但旧V3 Turbo早于10-09官方Turbo，不能算今天新出的官方Turbo微调；本轮无更新 |
| **Felldude** | [Qwen2.1 FinalCut / 2990276](https://civitai.red/api/v1/models/2990276)，10-07发布，25步 | 作者有训练说明，但不是新官方Turbo发布；同作者的Anima/Minimax Turbo不能混入Qwen |
| **FASCIUM** | [Early Test Merge / 2999797](https://civitai.red/api/v1/models/2999797)，v2于10-14发布 | 仅test说明；按实验merge候选记录，不能确认官方Turbo微调来源或NSFW效果 |
| **Stable_Yogi** | [Qwen2.1 NVFP4/Q4 / 2957912](https://civitai.red/api/v1/models/2957912)，09-23发布 | 量化条目；作者其他Krea2 Turbo模型不等于Qwen2.1 Turbo微调 |
| **fwaunstp733** | [Fwaun Tune / 2846802](https://civitai.red/api/v1/models/2846802)，Qwen分支09-30发布 | 确有平涂风格微调，Qwen分支未明确官方Turbo；其他Anima/Krea Turbo分支不能代替此项证据 |
| **8stepmafia** | [Small Screen Realism / 2827007](https://civitai.red/api/v1/models/2827007)，Demo Qwen2.1于10-09纽约日期发布 | 确有Qwen2.1 demo，但专属说明不足；Krea2正文的成人/训练声明不能直接转移到Qwen分支 |

此处“微调”首先依据作者明确的公开声明，并结合文件/版本身份核验，不是独立审计其训练过程。**“有作者发布新微调”已经成立；“本机六步下是否更快、更好、更像同一人物”仍待对照。** 现阶段优先级是AiMetatron的新RED系Turbo纹理修正版，其次Qwenvy；不把通用量化、重复文件或其它架构的Turbo当成新增Qwen2.1微调。

---

## 2026-10-15 20:14 晚间复查

### 相对早间的目录增量

完整翻到末页并补齐API游标漏项：Qwen2.1目录 **298→306项**，其中Checkpoint **24→26**、LoRA188→192、Workflows74→76；其余类型数量不变。三个底模标签的Checkpoint合计100→102项（Qwen2.1=26、Qwen2=4、Qwen=72）。新增入本次目录的8项中，两项LoRA的发布时间早于今天，只记“新发现”，不误算今日发布。另检查名称qwen21/qw21查询及qwen turbo五页495个去重条目，后者仍有下一页，未声称穷尽错标模型。[实时底模目录](https://civitai.red/api/v1/models?baseModels=Qwen%202.1&limit=100&nsfw=true&sort=Newest)、[分页及增量汇总](../../.scratch/qwen21-civitai-20261015-evening/research-summary.json)、[全部类型差异](../../.scratch/qwen21-civitai-20261015-evening/all-type-delta.json)、[Checkpoint差异](../../.scratch/qwen21-civitai-20261015-evening/checkpoint-delta.json)

### 新RED系Turbo纹理修正版：同一模型的两处发布

| 发布条目 | 版本与纽约发布时间 | 核验内容 |
| --- | --- | --- |
| FineView 欢视1.0 / 3003597 | QW21 Turbo Fixed / 3407540，10-15 16:29 | 新模型页；作者称RED QW21 Turbo Texture Fixed微调、重度修改，支持文生图和最多10图参考/编辑 |
| RedCraft 红潮 / 958009 | RedCraft3.0(FixQW21T) / 3407259，10-15 13:25 | 既有多底模页面新增Qwen2.1版本；与FineView共享主要权重及附件，不是两个独立模型 |

两页作者均为 **AiMetatron**，与现有REDQW21 / 452459相同。以下是站点公布的文件身份比较，没有下载权重验证训练谱系：[FineView完整API](https://civitai.red/api/v1/models/3003597)、[RedCraft完整API](https://civitai.red/api/v1/models/958009)、[现有RED条目](https://civitai.red/api/v1/models/452459)。

| 资产 | FineView / RedCraft fileId | SHA256前缀（完整值见证据文件） |
| --- | --- | --- |
| INT8，约7.26GB | 3299386 / 3299030 | `712B44D2A79B30ED`，两页相同 |
| FP8，约7.12GB | 3299367 / 3299057 | `7BA6C0774C233540`，两页相同 |
| 较大INT4，约5.73GB | 3299176 / 3298891 | `0DEE6BB5E4709D3F`，两页相同 |
| Texture-Fix BF16 VAE，约0.68GB | 3299190 / 3298969 | `36F56608B02077A50`，两页相同 |
| JSON工作流，7269bytes | 3299153 / 3298987 | `46E6A30FBD864408`，两页相同 |

FineView另有约4.20GB的INT4文件3299409。RedCraft标题写W6A8，但相应文件API精度字段标int4；没有解析权重内部量化格式或验证MPS内核，因此不据标题推定M4速度。新文件公布SHA没有命中早间三个底模标签下的100项Checkpoint文件；这只证明发布身份不同，不独立证明训练变化。[文件及图结构证据](../../.scratch/qwen21-civitai-20261015-evening/fixed-turbo-evidence.json)

### NSFW样例：新版关联与旧RED必须区分

FineView当前画廊返回34项，最高16（XXX）；RedCraft当前画廊返回81项，但混有旧REDQW21示例，不能把所有成人样例都归给今天的新权重。以下均只读元数据，分级不等于观看或评定实际画面质量。

- **新版关联的XXX社区样例：** image145782367，作者Birlalo_AI，10-15 18:23 EDT发布；`modelVersionIds=[3407259]`，模型名redcraft_qw21turbo_int8，记录8步、CFG1、er_sde_simple。但没有文件hash，资源列表为空，不能证明无额外LoRA或后处理。
- **新版hash匹配的作者样例：** image145785739，AiMetatron，19:34 EDT发布，R级（4）；hash `0DEE6BB5E4`匹配两页共享的较大INT4文件，资源只列该model；没有完整采样参数。支持当前文件的样例归因，不能据此推导具体露骨场景可靠性。
- **旧样例排除：** 多张X/XXX作者图记录 `30532B445E`，明确匹配旧REDQW21 V2 INT8 / 3370753 / file3258922，而且发布时间在10-12/13，不能算新版能力证据。

来源：[FineView画廊元数据](https://civitai.red/api/v1/images?modelVersionId=3407540&limit=100&browsingLevel=31&withMeta=true)、[RedCraft画廊元数据](https://civitai.red/api/v1/images?modelVersionId=3407259&limit=100&browsingLevel=31&withMeta=true)、[去提示词FineView样例证据](../../.scratch/qwen21-civitai-20261015-evening/new-gallery-3407540-evidence.json)、[RedCraft样例证据](../../.scratch/qwen21-civitai-20261015-evening/new-gallery-3407259-evidence.json)。画廊返回跨条目关联，不能把gallery URL参数当作hash级归因，也不能把多处出现的同一图重复计数。

### 实际解析到的配方，以及VAE来源

RedCraft的Config附件3298987本轮成功取得7269bytes JSON，SHA与站点公布相同；FineView的对应下载端点返回403，不能声称也下载成功，但两页公布的Config hash一致。该JSON是Comfy API图，沿最终SaveImage依赖链实际执行：

1. `UNETLoader → QwenImage21Cache → ModelSamplingAuraFlow(shift=1.31)`；loader仍填一个REDQW21-UNLOCKED-v3-BF16文件名，使用公开量化文件需选择实际下载的权重。
2. 第一个KSampler：**8步、CFG1、er_sde/simple、denoise1**。
3. VAE解码，bicubic放大1.5倍，再VAE编码。
4. 第二个KSampler：**8步、CFG1、er_sde/simple、denoise0.7**，再解码并缩放保存。

这是**两段各8步、跨分辨率的重采样链**，不是单次8步输出；总调用/耗时须实际profile，不能按某条图片元数据的steps8推断整张图只采8步。图中未见ManualSigmas节点，不能把作者模型正文的sigma建议写成此附件已经实现的功能。复杂Nvidia后处理宣传也不直接代表这份小型附件的节点组成。[实际JSON](../../.scratch/qwen21-civitai-20261015-evening/redcraft-workflow.json)、[节点与hash摘录](../../.scratch/qwen21-civitai-20261015-evening/fixed-turbo-evidence.json)

配套VAE是madebyollin已经发布的 **Texture-Fix-VAE-for-Qwen-Image-2.1**，不是今天新发明的VAE。作者卡说明它微调解码器以减少棋盘纹理、修复FP16 NaN；版本历史最新列10-05，仓库revision `702909b4d408912c7a28fadea06e8b7fdb38ef0c`。这是作者说明与作者测试，不是本次M4测量。此前Ray/RED对照记录的VAE SHA为`bb21f747...`，与本次附件`36F56608...`不同，不能仅凭文件名接近就当作同一个VAE；将来应把VAE变化与DiT权重变化分开对照。[VAE原作者卡](https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/blob/702909b4d408912c7a28fadea06e8b7fdb38ef0c/README.md)、[此前本机资产记录](RAY_QWEN21_TURBO_COMPARISON_2026-10-11.md)

### 其他更新及未变化项

- **Multi-Image Edit / 3000002：版本号仍v1.1，文件实际已替换。** 旧file3297616、SHA`96203C124F70...`变为3298683、SHA`23C17DA1B9D7...`。新增说明强调Turbo权重、8步/CFG1，Outfit swap+Auto prompt只做换装，其他编辑应关闭；AusBoss要求更新至2.11+，2.13改善画布文字。不能只比版本号而漏掉此更新。[作者当前说明](https://civitai.red/api/v1/models/3000002)
- **新NSFW工作流 / 3003321：** 今日11:55发布，作者给50步、CFG2.5、er_sde/beta、内容LoRA叠加；是Base完整步数路线，不是新的六步Turbo模型。[作者API](https://civitai.red/api/v1/models/3003321)
- **Moody Edit / 3003715：** 今日17:37发布，作者给Turbo8步、多至8图参考；是编辑工作流，人物一致性尚无本机测量。[作者API](https://civitai.red/api/v1/models/3003715)
- **Goth / 3000484、Kchisara / 3003504：** 今日发布的LoRA，作者给20步/CFG3，并报告Turbo LoRA造成输出退化；不列为已证实六步组合。Expressions Sheet3000993、Character Sheet2995608是新发现的旧条目，分别明确Base而非Turbo、25步设置，不误列今日新少步路线。[Goth](https://civitai.red/api/v1/models/3000484)、[Kchisara](https://civitai.red/api/v1/models/3003504)、[Expressions](https://civitai.red/api/v1/models/3000993)、[Character Sheet](https://civitai.red/api/v1/models/2995608)
- Qwenvy仍v1.0/v1.0-turbo；Ray仍turbo v1.3；Noct仍V4 Base/V3 Turbo；CoffeeMix仍Turbo v1；Vince仍v1.0。关键checkpoint及五项已知NSFW LoRA没有发现新增相关版本、说明或公布权重hash变化。索引与完整API的友好文件名、空字段差异单独处理，未冒报为权重更新。[独立关键模型复核](../../.scratch/qwen21-civitai-20261015-evening/KNOWN_MODEL_DELTA.md)

**本轮建议：下一轮优先比较这套新RED系Turbo纹理修正版与现有REDQW21+Viggle六步；Noct V3 Turbo、Qwenvy仍保留候选。** 对新RED先区分DiT、VAE及二段放大的贡献，避免把额外采样换来的细节误算成同规格提升。本轮未运行任何新候选，没有M4速度、NSFW质量或身份一致性胜出的结论，默认方案未变。HTML/评论区及私有模型不保证覆盖，广义名称搜索仍非全站穷举。

---

以下保留早间及此前复查，数字和结论按对应时间解读。

## 2026-10-15 05:43 完整目录及来源复核

### 范围与分页校验

Qwen 2.1 全类型目录按 `nsfw=true&sort=Newest&limit=100` 翻到末页，共三页、296 个不同条目；独立 LoRA 查询翻到末页，结合直接读取游标条目后，合并得到 **298 个不同条目：24 Checkpoint、188 LoRA、1 LoCon、74 Workflows、3 VAE、2 TextEncoder、4 Other、2 Poses**。不是仅检查名称带 Turbo 的第一页。[完整底模查询](https://civitai.red/api/v1/models?baseModels=Qwen%202.1&limit=100&nsfw=true&sort=Newest)、[LoRA 交叉查询](https://civitai.red/api/v1/models?baseModels=Qwen%202.1&types=LORA&limit=100&nsfw=true&sort=Newest)、[去重清单](../../.scratch/qwen21-civitai-20261015-audit/base21-inventory.json)

本次发现公开分页的一个实质漏项：全类型查询的下一页游标指向 1751076、2757161，但这两个条目不在相邻返回页中；LoRA 查询也漏了自身游标条目 2979518。已用分类查询和逐模型 API 补齐，三者均确认有 Qwen2.1 版本。这是本次返回的观察，不推断站点所有接口均有此行为。[边界复核记录](../../.scratch/qwen21-civitai-20261015-audit/pagination-boundary-audit.json)

另完整检查 Qwen / Qwen 2 两个旧底模标签下的 Checkpoint，分别72 / 4项，均无下一页；和 Qwen2.1 合计100个不同checkpoint。名称 `qwen21`、`qw21` 和 `qwen turbo` 用于交叉发现错标条目；最后一组检查了五页、495个去重结果，仍有下一页，**没有声称穷尽全站错标模型**。名称搜索返回许多不相关架构，不能把相关性排序当作按时间的完整清单。[分页汇总](../../.scratch/qwen21-civitai-20261015-audit/pagination-summary.json)

### 重点候选：证据与适用位置

| 候选 / 精确版本 | 已核实的一手证据 | 对当前六步方案的意义 |
| --- | --- | --- |
| **Noct Q V3.0 Turbo / 3355719** | 完整模型和版本说明明确 Qwen2.1、成人内容、六步、euler、无CFG；提供INT8/INT4/FP8/BF16/FP16。作者HF卡和NOTICE另证实Qwen2.1权重来源 | **应补进六步checkpoint对照**。09-25发布，早于10-09官方Turbo，不能称今日新增官方Turbo衍生，但这不妨碍它成为已有少步候选。未实测本机速度/画质/身份保真 |
| **Qwenvy 2.1 v1.0-turbo / 3406326** | 今日02:33 EDT发布；作者称对2.1微调以改善噪点和细节；作者当前版本画廊有X/XXX分级元数据 | **今日最值得跟进的新候选**，但这些样例记录20步/CFG3.5，无文件hash或完整资源归因；不能当作六步裸checkpoint表现 |
| **Ray turbo v1.3 / 3395380** | 作者明确官方Turbo来源及解锁；当前仍此版本，已有本机六步受控对照 | 继续作为已测参照。此前约47–49秒的BF16驻留结果只对所测Ray文件成立，不能外推到新模型 |
| **CoffeeMix Borgia Turbo v1 / 3401001** | 作者明确2.1 Turbo；当前作者画廊含R/Mature分级条目，但生成元数据缺失 | 保留待测。没有充分信息证明额外LoRA、原生成人能力或六步效果；license段落不能当内容解锁声明 |
| **Vince Fidelity v1.0 / 3399234** | 官方Turbo的INT8/4-bit混合量化；作者明确不是重新微调。有作者R级样例，短hash匹配当前文件、只列该checkpoint，8步Euler/CFG1 | 属于量化方案候选，有成人主题样例证据；不能称新的NSFW专用训练，也没有M4加速实测 |
| **Noct Q V4 Base / 3372040** | 作者明确成人内容；HF工作流实际解析为25步/CFG3/euler/simple | 可做完整步数质量参照，不能把V4 Base写成V4 Turbo；六步叠加加速器的效果未知 |
| **Noct Q Anime / 3362444** | 作者明确Qwen2.1成人动漫方向，25步/CFG3；独立checkpoint而非仅标签 | 是另一种内容风格候选，不与当前写实人物六步结果混算 |

来源：[Noct Q完整版本](https://civitai.red/api/v1/models/2958896)、[Noct作者HF模型卡](https://huggingface.co/Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1/blob/a81b9af51120a78e285e57906f2250a2a02080e9/README.md)、[Qwenvy](https://civitai.red/api/v1/models/3002606)、[Ray](https://civitai.red/api/v1/models/2972899)、[CoffeeMix](https://civitai.red/api/v1/models/2998444)、[Vince](https://civitai.red/api/v1/models/2997056)、[Noct Anime](https://civitai.red/api/v1/models/2967534)。

Noct另有V2 Turbo / 3353646（作者给5步）及v1 / 3351925（4步），没有按发布日期排除。V3 Turbo的六步配方来自作者完整说明；它的Config下载接口本轮返回HTML，**没有宣称已解析该Turbo JSON**。实际解析到的是作者HF的V3/V4 Base JSON，两者均25步。[全部版本与来源复核](../../.scratch/qwen21-civitai-20261015-audit/NOCT_RAPID_LORA_AUDIT.md)

### 成人内容证据不能只看模型标签

Qwenvy、CoffeeMix、Vince的模型记录均为 `nsfw=false`，这没有排除其公开画廊的成人评级。数字分级依据Civitai自己的文档：1=PG、2=PG13、4=R、8=X、16=XXX；分级是站点元数据，不是本次观看图片后的内容/质量判断。[一手分级定义](https://github.com/civitai/civitai/blob/main/docs/features/nsfw-filtering.md)

- **Qwenvy Turbo：** 作者 `_Envy_` 的当前版本画廊返回16项，其中一项X、一项XXX。145718096为16，145718128为8；两者记录20步、CFG3.5、`dpmpp_2m_sharp_beta57`。`hashes`、`resources`及`modelVersionIds`为空，证据是作者帖子/版本画廊关联，不能严格排除未记录的附加LoRA或后处理。[Turbo分级/生成参数API](https://civitai.red/api/v1/images?modelVersionId=3406326&limit=100&browsingLevel=31&withMeta=true)
- **Qwenvy Base：** 作者样例145714632明确记录额外的 `qwen_image_2.1_turbo_lora_avg_rank_178_bf16`、强度1，10步/CFG1。应归为Base+Turbo LoRA组合；不能拿它证明Turbo分支的独立表现。[Base画廊API](https://civitai.red/api/v1/images?modelVersionId=3406222&limit=100&browsingLevel=31&withMeta=true)
- **Vince：** 作者R级样例145376420记录8步Euler/CFG1，hash `290e8a8a3c`匹配当前SHA256前缀，资源只列3399234。另一社区样例同时关联Krea2 Turbo，已排除其单模型归因。R级不证明露骨场景能力。[Vince画廊API](https://civitai.red/api/v1/images?modelVersionId=3399234&limit=100&browsingLevel=31&withMeta=true)
- **CoffeeMix：** 作者四项样例最高R级；即使`withMeta=true`仍无生成参数，不能识别额外资源。作者引导的CoffeeMix Universe动态外站未取得Borgia专属说明，因此没有补造解锁结论。[CoffeeMix画廊API](https://civitai.red/api/v1/images?modelVersionId=3401001&limit=100&browsingLevel=31&withMeta=true)

读取生成参数需要显式 `withMeta=true`；初始默认返回`meta=null`不能解释为作者隐藏信息。只读取元数据，没有请求图片CDN或复述提示词。[images API一手源码](https://github.com/civitai/civitai/blob/main/src/pages/api/v1/images/index.ts)、[三模型深入核验](../../.scratch/qwen21-civitai-20261015-audit/COFFEE_QWENVY_VINCE_AUDIT.md)

### 已有LoRA组合与人物一致性路线

本轮不只找新的整模。2988215的作者明确推荐 **Viggle Qwen2.1 v0.3 六步r128 Turbo LoRA**，并给出采样建议；2986844明确写Viggle Turbo兼容及八步设置；2994404、2992770明确称发布样本使用Viggle Turbo八步。它们是专项成人内容LoRA与少步加速器的组合证据，不能写成任意底模或所有NSFW LoRA均已兼容。[六步组合作者说明](https://civitai.red/api/v1/models/2988215)、[明确兼容声明](https://civitai.red/api/v1/models/2986844)、[八步作者使用记录一](https://civitai.red/api/v1/models/2994404)、[记录二](https://civitai.red/api/v1/models/2992770)、[Viggle作者模型卡](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/main/README.md)

2063193也确有专门的Qwen2.1_V1 / 3392016（约49MB BF16）解锁LoRA版本；没有找到它针对Turbo的明确适配声明，**应标为未知，而非不兼容**。2958918也是真实Qwen2.1成人LoRA，但作者给25+步设置，不能直接当六步已验证组合。[2063193的Qwen版本](https://civitai.red/api/v1/model-versions/3392016)、[2958918](https://civitai.red/api/v1/models/2958918)

人物一致性方面，2994247的官方Turbo Generate+Edit工作流明确使用Consistency/Restore LoRA，3000002的Multi-Image Edit于今日00:27更新v1.1，最多六张输入；它们是**编辑工作流候选**，提供一致性LoRA的使用出处，但还没有本机身份一致性评分。作者要求ComfyUI0.38+/AusBoss2.10+，本机此前所测Comfy为0.37.0；尚未安装导入，不能写成现有环境即用。[Generate+Edit](https://civitai.red/api/v1/models/2994247)、[Multi-Image Edit](https://civitai.red/api/v1/models/3000002)

### 其余checkpoint逐项归类

以下与上表合计覆盖Qwen2.1目录返回的24个checkpoint。分类依据公开说明、版本和文件字段，不根据名称推定实测性能。

| 模型ID | 条目 | 核验归类 |
| --- | --- | --- |
| 2999797 | VERY EARLY TEST MERGE QWEN2.1 | v2.0于10-14更新，作者仍只写test；NSFW/Turbo来源未知 |
| 2998457 | CoffeeMix ConPanna Basic | 明确Basic，非Borgia Turbo；相同license措辞不能证明内容解锁 |
| 2954443 | Qwen Image2.1 | 新增2.1 Turbo发布版本；没有独立NSFW微调声明 |
| 2982566 | QwenImage21 SimpleAIO | All-in-One打包条目，不因打包方式认定内容能力升级 |
| 2995304 | Noct Q V4 Base NVFP4 | V4 Base BF16转NVFP4；作者的原生执行说明针对RTX50，不是新的Turbo或M4实测加速方案 |
| 2995231 | Qwen2.1 Turbo GGUF | Turbo GGUF转换；非新增成人训练证据 |
| 2827007 | Small Screen Realism | 确有Demo Qwen2.1 / 3395667及BF16/INT8文件；通用模型正文的NSFW介绍明确在Krea2语境，不能自动转移到该Qwen版本。其专属描述信息不足 |
| 2951557 | Qwen2.1/Turbo INT4/INT6/INT8 | 原版/官方Turbo的多精度发布，量化身份与NSFW训练分开判断 |
| 2993507 | Qwen2.1 Turbo Official | 官方Turbo发布条目；不是独立NSFW微调的证据 |
| 2967502 | Qwen2.1 Turbo8and5Step | 作者说明为Base与Viggle LoRA合并；属于独立少步组合，不能仅凭Turbo名称认定10-09官方谱系 |
| 452459 | RED多底模条目 | Qwen2.1版本是REDQW21 UNLOCKED v2 / 3370753及v1；当前默认基准 |
| 2990276 | Qwen2.1 FinalCut | 作者标25步的小体积发布；不是六步NSFW效果已证实 |
| 2990068 | Qwen2.1 Viggle Turbo | 已有v0.3少步checkpoint路线，也是当前加速器来源；不算今天新发布 |
| 2977435 | QuantFunc A4W4 INT4 | 量化路线；没有独立成人训练/本机性能证据 |
| 2846802 | Fwaun Tune | Qwen版本为平涂插画方向，非写实人物优先候选 |
| 2973649 | Qwen2.1 MXFP8 | 多精度量化发布；非新NSFW微调证据 |
| 2957912 | Qwen2.1 NVFP4 Q4 | 量化发布；不能按文件更小推断MPS更快 |
| 2952547 | Qwen2.1 GGUF | 常规GGUF发布；非成人解锁/六步结果证据 |

表中Noct NVFP4是同源Base转换，为避免当成独立内容模型而单列；上方重点候选表的Noct V4 Base与V3 Turbo属于同一modelId2958896。所有24个不同modelId及版本在[完整清单](../../.scratch/qwen21-civitai-20261015-audit/base21-inventory.json)。[Small Screen完整多底模API](https://civitai.red/api/v1/models/2827007)、[Fwaun Tune](https://civitai.red/api/v1/models/2846802)、[CoffeeMix Basic](https://civitai.red/api/v1/models/2998457)

另外，Rapid NSFW v23 / 2987437由作者和源HF卡明确指向**Qwen-Image-Edit2511**，是旧架构少步路线，排出2.1清单的依据是来源而不是名称。原版Qwen3-VL8B Text Encoder条目2960962称原始编码器即可处理成人提示且无需abliteration；Heretic条目2955374则是DreamFast模型的量化转换、底模标签Qwen2。二者都是编码器，不是新的DiT checkpoint；是否更换带来增益本轮未测。[Rapid](https://civitai.red/api/v1/models/2987437)、[原版编码器](https://civitai.red/api/v1/models/2960962)、[Heretic编码器](https://civitai.red/api/v1/models/2955374)

### 结论及剩余验证

**下一轮同规格六步对照应优先补入Noct Q V3 Turbo，其次Qwenvy v1.0-turbo；作者明确点名的Viggle+内容LoRA组合另列组合实验。** Noct可以先按其作者六步路线核对，再与现有RED做同分辨率/参考图的控制比较；Qwenvy则应同时记录作者原配方与六步控制配方，避免把20步/CFG3.5的样例效果归给六步。此处是后续实验优先级，本轮没有执行生成。

没有公开材料足以宣布新候选已经提升M4 Max速度、画质或人物一致性。既有[Ray/RED受控实测](RAY_QWEN21_TURBO_COMPARISON_2026-10-11.md)继续有效，但其内容覆盖也不能延伸为露骨NSFW能力已验证。本轮完成的是公开来源核验，不是新模型效果评测；受限模型HTML/评论区未完整访问，错标/私有条目不能保证穷尽。

---

以下保留此前复查记录，避免把不同时间和筛选口径混为同一次结论。

## 2026-10-15 复查

Checkpoint 三组完整查询返回 Qwen 2.1 / Qwen 2 / Qwen 共 **24 / 4 / 72** 个条目，均无下一页，合计 100 个不同 checkpoint；比 10-13 晚间新增一个模型 Qwenvy 2.1。另外，旧测试合并条目新增 v2.0。比较覆盖已有版本的名称、底模、描述、发布时间及文件 id/name/size/hash/格式，除新增版本外未发现已有版本这些字段变化。[本轮查询增量](../../.scratch/qwen21-civitai-20261015/query-delta.json)、[汇总](../../.scratch/qwen21-civitai-20261015/research-summary.json)

### 新 checkpoint 与版本

| 候选 | 发布时间（纽约） | 实际核验 |
| --- | --- | --- |
| Qwenvy 2.1 v1.0 / 3406222 | 10-15 01:29 | 新 Qwen 2.1 微调模型，作者主打减少噪点、改善细节，并支持编辑 |
| Qwenvy 2.1 v1.0-turbo / 3406326 | **10-15 02:33** | 今日新 Turbo 命名版本，SafeTensor/INT8，约 7.26 GB；版本说明为空，模型说明未明确 NSFW 解锁或官方 Turbo 谱系 |
| VERY EARLY TEST MERGE QWEN 2.1 v2.0 / 3404279 | 10-14 01:19 | 提供 INT8、INT4、NVFP4；作者仍只写 `test`，NSFW 与 Turbo 属性信息不足 |

Qwenvy 作者为 `_Envy_`。作者推荐配套工作流、自有改进采样器节点及 RES4LYF 的 bong_tangent scheduler，这些只是作者推荐，并非本机已经验证的路径。此前 Ray 六步的速度和数值结论不能套到该新模型，也不能据文件精度字段断言本机加速节点兼容。[Qwenvy 模型元数据](https://civitai.red/api/v1/models/3002606)、[Turbo 版本元数据](https://civitai.red/api/v1/model-versions/3406326)、[早期测试合并](https://civitai.red/api/v1/models/2999797)

Turbo 文件 `qwenvy21_v10Turbo.safetensors`，fileId **3297789**，站点公布大小 **7,256,783,608 bytes**，SHA256：`29B035AF4AD229C636F1C87ACC2F05ED8ACFF4BB3F883592D2997B1608B476C8`。在本次 Qwen 2.1 checkpoint 返回的文件中，只发现 Qwenvy 自己使用该公布 SHA256；没有发现与 Ray / CoffeeMix 等其它条目公布相同文件 hash。该事实只用于发布身份比较，没有下载权重或证明权重级训练来源。[公布 hash 比较](../../.scratch/qwen21-civitai-20261015/qwenvy-hash-matches.json)

### 已知候选与容易误判的新增条目

独立读取三个已知模型及其关键版本 API：Ray 仍是 v1.3 / 3395380，CoffeeMix 仍是 Turbo v1 / 3401001；Noct Q 最新 Base 仍为 V4.0 / 3372040，最新 Turbo 仍是 09-25 发布的 V3.0 Turbo / 3355719。模型/版本描述、全部文件身份及公布 SHA256 与 10-13 基线一致，没有新增 NSFW 或官方 Turbo 谱系声明。[独立核验记录](../../.scratch/qwen21-civitai-20261015/KNOWN_MODEL_DELTA.md)、[Ray 当前版本](https://civitai.red/api/v1/models/2972899)、[CoffeeMix 当前版本](https://civitai.red/api/v1/models/2998444)、[Noct 当前版本](https://civitai.red/api/v1/models/2958896)

新查到 Angles Sheet 和 Clothing Sheet 两项 LoRA，虽然站点标记 NSFW，作者却明确写明 **base Qwen Image 2.1 (not Turbo)**，25 步。它们用于人物多角度设定图及服装平铺图，不能计为官方 Turbo NSFW 解锁模型。[Angles Sheet](https://civitai.red/api/v1/models/3000994)、[Clothing Sheet](https://civitai.red/api/v1/models/3000995)

Turbo Multi-Image Edit 于 10-15 00:27 更新 v1.1 / 3406204，作者新增最多六张输入及每张参考图的服装选择框；这是工作流更新，不是新 checkpoint。其公开描述仍为官方 Turbo 八步配方，本轮未导入或测试。[工作流元数据](https://civitai.red/api/v1/models/3000002)

Qwen 2.1 全类型最新列表的第一页共 100 项，翻页边界已到 10-08，足以覆盖本次新增时间段；另以名称搜索交叉检查底模标签，没有发现新的 Qwen Turbo 独立标签。本轮全部新旧分类及去示例图快照保存在 `.scratch/qwen21-civitai-20261015/`。[全部类型增量](../../.scratch/qwen21-civitai-20261015/all-type-delta.json)、[新候选明细](../../.scratch/qwen21-civitai-20261015/candidate-details.json)

本轮结论：**Qwenvy Turbo 是新增值得记录的候选，NSFW 属性、官方 Turbo 谱系及本机速度/画质/人物一致性仍未实测或证实；目前没有新的公开元数据证据可以把它直接认定为 NSFW 升级。** 以下历史结论及数目保留对应日期的口径。

## 2026-10-13 19:46 晚间复查

完整 Checkpoint 查询返回 Qwen 2.1 / Qwen 2 / Qwen 共 **23 / 4 / 72 个条目**，均无下一页，合计 99 个不同 checkpoint。相较今早只新增一个 Qwen 2.1 checkpoint。对已有版本进一步比较版本名、底模、描述、发布时间及文件 id/name/size/hash/格式，未发现这些字段变化；没有只看版本号而漏掉同版本文件替换。[最新查询增量](../../.scratch/qwen21-civitai-20261013-evening/query-delta.json)、[已有版本与文件比较](../../.scratch/qwen21-civitai-20261013-evening/existing-version-delta.json)

| 新增或更新条目 | 类型 / 时间（纽约） | 核验结果 |
| --- | --- | --- |
| VERY EARLY TEST MERGE QWEN 2.1，v1.0 / 3402631 | Checkpoint，10-13 06:41 | 新测试合并条目，提供 INT8/NVFP4/INT4；作者描述只有 `test`，无明确 Turbo 谱系或 NSFW 解锁说明 |
| Western_Woman_Legswithstockings_4_Qwen-Image-2.1，v1.0 / 3402884 | LoRA，10-13 09:44 | 站点标记 NSFW；底模只标 Qwen 2.1，公开说明未明确针对官方 Turbo 训练或适配 |
| Qwen Image 2.1 Turbo Generate + Edit，v1.2 / 3403821 | Workflows，10-13 19:43 | 官方 Turbo 的八步生成/编辑工作流更新，非新 checkpoint 或 NSFW 解锁模型；更新涉及放大细节及编辑前后对照 |

一手元数据：[早期测试合并](https://civitai.red/api/v1/models/2999797)、[新服饰 LoRA](https://civitai.red/api/v1/models/2999997)、[Turbo 工作流](https://civitai.red/api/v1/models/2994247)。新工作流作者列出 ComfyUI 0.38 / AusBoss 2.10.0 起的依赖要求；没有安装、导入或在 M4 Max 上验证它，也不把作者 RTX 5090 的时间外推为本机性能。

独立复查直接读取 Ray / CoffeeMix 模型及版本 API，确认 Ray 最新仍是 `3395380 / turbo v1.3 int8convrot`，CoffeeMix 仍是 `3401001 / Turbo v1`；相较今早文件 SHA256、说明和解锁声明均没有新增证据。[晚间独立差异核验](../../.scratch/qwen21-civitai-20261013-evening/DELTA_RAY_COFFEE.md)、[Ray 当前公开版本](https://civitai.red/api/v1/models/2972899)、[CoffeeMix 当前公开版本](https://civitai.red/api/v1/models/2998444)

晚间全部类型的最新 100 个 Qwen 2.1 条目还包含 Multi-Image Edit、Inpaint 工作流和其他 LoRA 更新；该列表下一页已是 10-06 及更早，未继续翻旧条目。此处只记录与新 Turbo / NSFW 候选核验有关的新增事实。[全部类型增量](../../.scratch/qwen21-civitai-20261013-evening/all-type-delta.json)、[晚间汇总](../../.scratch/qwen21-civitai-20261013-evening/evening-summary.json)

以下保留 05:50 的检索范围与候选核对，数目为当时快照。

## 2026-10-13 05:50 首轮检索范围

直接请求站点 API，允许返回 NSFW 条目，并按 Qwen 2.1、Qwen 2、Qwen 三个底模标签分别过滤 Checkpoint。返回分别为 22、4、72 个条目，均没有下一页，合计 98 个不同 checkpoint。另交叉检查 Qwen/Qwen 2.1 搜索及 Qwen 2.1 最新列表；搜索参数本身有相关性/词序差异，不能只靠名称含 Turbo 的单一查询。NSFW 标签描述站点标记，不能独立证明模型是否解锁；Qwen 2.1 底模标签也没有单独区分官方 Turbo。

一手查询：[Qwen 2.1 checkpoints](https://civitai.red/api/v1/models?baseModels=Qwen%202.1&types=Checkpoint&limit=100&nsfw=true&sort=Newest)、[Qwen 2 checkpoints](https://civitai.red/api/v1/models?baseModels=Qwen%202&types=Checkpoint&limit=100&nsfw=true&sort=Newest)、[Qwen checkpoints](https://civitai.red/api/v1/models?baseModels=Qwen&types=Checkpoint&limit=100&nsfw=true&sort=Newest)。原始元数据经移除无关示例图字段后保存在 `.scratch/qwen21-civitai-20261013/`；[查询范围与分类记录](../../.scratch/qwen21-civitai-20261013/research-summary.json)。

## 候选核对

| 条目 / 版本 | 发布时间（纽约） | 核验结果 |
| --- | --- | --- |
| Ray，turbo v1.3 int8convrot / 3395380 | 10-09 19:32 | 作者仍声明基于 10-09 官方 Turbo、已解锁；公开 API 没有后续版本 |
| QI2.1_Turbo_CoffeeMix_Borgia_v01，Turbo v1 / 3401001 | 10-12 12:27 | 作者明确称 Qwen Image 2.1 Turbo checkpoint，站内仅提供 INT8；没有明确 NSFW 训练/解锁说明，暂列待核验 |
| Noct Q V4 Base NVFP4，V4.0 Base NVFP4 / 3397016 | 10-10 14:58 | 作者声明成人内容未受限；是 V4 Base 的 NVFP4 转换，非官方 Turbo 新解锁版 |
| Noct Q，V3.0 Turbo (Experimental) / 3355719 | 09-25 04:00 | 作者有成人内容及六步版本声明；发布时间早于 10-09 官方 Turbo，未提供基于该官方 Turbo 的说明，不能当作今天的新官方 Turbo 衍生 |

Ray 的文件、参数和更新时间与上一轮记录一致。最新仍为 modelId 2972899，versionId 3395380，fileId 3285289；站点公布 SHA256 与此前本地权重校验一致，本次没有重新下载。[Ray 当前模型](https://civitai.red/api/v1/models/2972899)、[Ray v1.3](https://civitai.red/api/v1/model-versions/3395380)、[独立更新核验](../../.scratch/qwen21-civitai-20261013/RAY_UPDATE_CHECK.md)

CoffeeMix 的描述包含“all policies have been removed”，但该句位于 license policy 的语境，不能直接解释成 NSFW 审核已解除。结构化 nsfw=false 同样不能反向证明它无法生成成人内容。文件为 SafeTensor/INT8，fileId 3291696，公布 SHA256 为 `4049010C02DF63BA12F1969596578093927A304066860A4F85B4FA8D66F8228B`，约 7.19 GB；在这次 Qwen 2.1 checkpoint 返回的文件中，没有发现其他条目使用同一 SHA256。这只核验发布身份，不证明权重级 Turbo 谱系、训练方式、兼容性或画质。[CoffeeMix 作者元数据](https://civitai.red/api/v1/models/2998444)、[Turbo v1 元数据](https://civitai.red/api/v1/model-versions/3401001)

Noct Q 原条目的最新 Base 是 V4.0 / 3372040，发布于 09-30，作者列为 25 步配方；10-10 新条目是它的 NVFP4 转换。旧 V3 Turbo 是 09-25 的实验六步版本。以上都是作者/站点说明，没有做本机生成或硬件兼容验证，不能拿旧 Turbo 名称或 CUDA 量化格式推断能替换 M4 Max 上的 RED 六步。[Noct Q 完整版本列表](https://civitai.red/api/v1/models/2958896)、[V4 Base NVFP4](https://civitai.red/api/v1/model-versions/3397016)

另外发现 10-11 的 Vince Fidelity，是官方 Turbo INT8 ConvRot 的混合 INT8/W4A4 量化实验；未看到明确的 NSFW 解锁说明，因此未纳入已确认 NSFW Turbo 候选。10-12 的普通 Qwen Image 2.1 条目新增 v2.1 Turbo，属于另一个 Turbo 发布条目，亦无明确 NSFW 解锁说明。[Vince Fidelity](https://civitai.red/api/v1/models/2997056)、[Qwen Image 2.1 发布条目](https://civitai.red/api/v1/models/2954443)

## 结论边界

此次只是当前公开元数据快照，不覆盖未公开或 API 未返回的模型。各轮均按纽约日期判断，不将 UTC 已跨日、纽约仍属前一天的发布误列为当天新增。没有执行 NSFW 效果、人物一致性、速度或新候选兼容测试；此前 [Ray / RED 实测结论](RAY_QWEN21_TURBO_COMPARISON_2026-10-11.md) 仍只适用于那次绑定的权重和配方。
