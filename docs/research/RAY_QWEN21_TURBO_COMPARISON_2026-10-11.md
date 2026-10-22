# Ray Qwen2.1 Turbo v1.3 与 REDQW21 + Viggle 六步实测

日期：2026-10-11–12（America/New_York；执行记录使用 UTC，最新结束于 2026-10-13）。

## 结论与适用期限

**M4 Max 常驻 BF16 方案已实际跑通，Ray 六步变快，但仍建议保留 REDQW21 + Viggle 六步默认。** 最新同规格 832×1024 测量中，原 Ray / 加速 Ray 的 warm 中位耗时为 **56.2 / 47.2 秒**，减少约 **16%**；RED 两轮为 **51.2 / 52.2 秒**。反转顺序时 Ray 约快 RED 6%，最终模块方案约快 10%，样本量小，不能当稳定保证。加速 Ray 六张与原 Ray 逐像素完全一致，画质和人物一致性没有随优化提升；独立盲评仍偏好 RED 的自然纹理、绞花服装和全身构图。加速节点及完整卸载/重载已验证，额外统一内存成本不值得用来直接替换当前默认。

此前四套配方共 24 张的中位耗时仍记录为 RED 47.3、Ray 十二步 185.6、Ray `seeds_2` 六步 97.2、Ray Euler 六步 52.3 秒，属于更早的服务会话。本轮另新增 39 张验证，详细过程、源码绑定和内存证据见下方 M4 实测章节。

本次只测成年虚构人物的日常服装、连体泳装和不透视内衣目录照，**没有测试露骨裸露或性行为，因此不能回答露骨 NSFW 效果、解锁强度是否提升**。成人服装生成能力接近，不等于完整 NSFW 能力接近。

结论仅适用于本报告绑定的权重、MPS 环境和下述六步／十二步配方，**没有证明 Ray 在 Mac 上的最佳优化上限**。已测同一 INT8 权重一次展开的 BF16 表示及两个 Metal 候选短环，未测原始 Ray BF16 checkpoint、其他配方或 CUDA；这些条件改变后需重新评估。默认工作流保持原样，Ray 文件与加速节点用于评估和复现，未部署升级。

以下保留首轮十二步、六步补测和后续 M4 加速验证各自的方法与证据；早期结果不替代最新测试。

## 候选身份和公平对比口径

Ray 使用 [Civitai 作者页面](https://civitai.red/models/2972899?modelVersionId=3395380) 的准确版本 `3395380`、文件 `3285289`，版本名 `turbo v1.3 int8convrot`。完整下载后检查字节数和 SHA256，再原子重命名；没有以近似版本替代。[版本 API](https://civitai.red/api/v1/model-versions/3395380) 公布的校验值与本地一致。

作者声明 v1.3 基于 10 月 9 日官方 Turbo 重新制作并解锁；公开元数据只标记 `Qwen 2.1`，未提供训练记录或底模 hash，因此谱系仍是作者声明。本地成功运行证明该文件可用，不独立证明其训练来源。[作者版本说明](https://civitai.red/api/v1/model-versions/3395380)

| 项目 | 当前 RED 配方 | 候选 Ray 配方 |
| --- | --- | --- |
| Diffusion | REDQW21 UNLOCKED V2 BF16 | Ray Turbo v1.3 INT8 ConvRot |
| 额外 LoRA | Viggle v0.3 六步 r128，现有强度 | 无 |
| Sampler | `euler` | `seeds_2` |
| Sigmas / scheduler | 现有 Viggle 自定义 sigmas，6 步 | `linear_quadratic`，12 步 |
| CFG | 1 | 1 |
| 输出 | 832×1024，单张 | 832×1024，单张 |
| Encoder / VAE | 相同 Qwen3-VL INT8 ConvRot / 已修正的 Qwen2.1 BF16 VAE | 相同 |
| 输入和提示 | 相同参考图字节、每组相同 prompt、seed、identity anchor 包装 | 相同 |

Ray 的编辑配方采用作者推荐的 `seeds_2`／12 步／CFG1；不是官方 Turbo 的默认八步方案。[Ray 参数说明](https://civitai.red/api/v1/model-versions/3395380)、[官方模型卡](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo)

这是两套可用配方的比较，模型、量化和采样方案共同变化，不能把结果归因于底模单一因素。输出尺寸统一为 832×1024，区别于当前默认工作流的 832×1216。参考图编码两边均使用相同的 fresh conditioning loader；测试描述符来自默认 `qwen-image-edit-img2img.json` 的私有副本，不改正式配置。

## 环境、输入与执行

- Apple M4 Max，128 GiB，macOS，MPS；ComfyUI 0.37.0，PyTorch 2.14.0，Python 3.13.12。
- iDream HEAD：`7e26cea97a26ca7a5703077f4dbdd607e808023f`；包含本次 Bun 拒绝连接修复的首轮十二张成功请求绑定 `sourceRevision`：`idream-worktree-3a389608d0955feea1bcf952ecac1a1860287ed79bb75a58e6b89e7ef33a3f42`。本报告初稿在首轮生成完成后加入。
- ComfyUI HEAD：`88ab4a06566454ad89db8f0bedb970d6c08cd1b7`。
- 实际描述符 SHA256：RED `40468f2fb86d95d3ec24375e7208a88ab58ea2d4b70c57e34aa0920b85f9b635`；Ray `785c2c1e3047c7490782aed8c7c84872021c8be58f911ade2567b2a9b6f21cca`。
- A 为已有生成的长卷发人物，prompt 指定虚构 36 岁；B 为已有生成的短栗棕发人物，prompt 指定虚构 38 岁。两张输入均为单一人物，未经修改；精确 prompts 与 seeds 见 [cases.json](../../.scratch/ray-turbo-comparison-20261011/cases.json)。
- A 参考图 SHA256：`df9266b9e3b90a1873dc79d364db5318f384e0ac36093c543cf6a338dbb141c4`；B：`f0755a99018699d0e934bd3b566498736ed994d9f23b0734ad43797a1c0a4798`。

首轮执行顺序为 RED A、RED B、Ray A+B。均经真实 Gen image provider、项目 accelerator lease 和原生队列检查，未绕过任务互斥。每次保存实际 ComfyUI history，检查模型、LoRA、sampler、steps、CFG、encoder device、提示和 seed 的绑定。首轮十二次原生请求 ID 各不相同，全部成功；输出尺寸及图片完整性检查通过，落盘重读和原生输出与交付字节的 SHA256 全部一致。

未创建 Main Turn／Job，没有测试完整产品持久化、计费或用户交付链路。调用为本地推理，外部按量 API 费用及 Dreamcoins 扣减均为 0；本机用电等成本未计量。

## 速度

耗时为真实 provider 调用开始到收到生成结果，包括队列检查、编码、采样、VAE 和返回图片；原生耗时另外从 execution timestamps 计算。每个模型的第一张单列，后续五张计入 warm 指标。RED B 的第一张仍是已加载的 RED 模型。

| 指标 | RED 六步 | Ray 十二步 |
| --- | ---: | ---: |
| 后续请求中位数，n=5 | 47.254 s | 185.576 s |
| 后续请求平均值 | 47.637 s | 187.977 s |
| 后续请求范围 | 46.252–50.152 s | 185.565–196.587 s |
| 原生执行 warm 中位数 | 46.788 s | 185.210 s |
| 第一张总耗时 | 60.252 s | 165.596 s |

Ray 的 warm 中位数约为 RED 的 **3.927 倍**。第一张包含初始加载或模型切换；Ray 开始时共用 encoder／VAE 已运行过，所以两次第一张不是完全同条件的冷启动对比。Ray 第一张反而快于其后续请求，应作为观测值记录，不能据此推断稳定热机更慢的原因。

runner 日志明确记录 Ray 量化使用 `emulated ops`、`Native ops` 为空。源码推导，终止 sigma=0 的十二步 `seeds_2` 约有 23 次模型求值，而 Euler 六步约六次；这个数来自采样代码推导，未额外插桩计数。量化的 MPS 实现和更重的采样配方共同解释了缺少速度收益的可能原因，不能从此实验单独分离各自贡献。[seeds_2 源码](https://github.com/Comfy-Org/ComfyUI/blob/e8665ca8e4089ab917567cdb491308e1397663d4/comfy/k_diffusion/sampling.py#L1660)、[本机运行日志](../../.scratch/ray-turbo-comparison-20261011/runner-log.txt)

观察点的 swap 使用均为 1188.69 MiB，没有观察到新增 swap；`pmset -g therm` 没有报告热或性能告警。两边按块串行且无重复种子试验，仍可能有执行顺序／温度影响，未测并发吞吐或峰值内存。

## 视觉结果与人物一致性

使用六张左右位置逐组随机的盲图，由独立 AI 代理仅读 prompts 和盲图评分；完成后才解码模型映射。四维度为人物一致性、可见人体／手部结构、提示执行和画质，每项 0–3，总分 12。**这是主观 AI 视觉盲评，没有真人评分或客观人脸相似度测量**；分数用于记录具体观察，不代表统计显著性，也不累计成通用模型排行。

| 案例 / seed | RED / Ray 耗时 | RED / Ray 评分 | 可见差异与遗漏 |
| --- | --- | --- | --- |
| A 咖啡馆 / 2026101101 | 60.3 / 165.6 s | 11 / 10 | 人物、杯子和衣服接近；RED 户外咖啡馆更明确，Ray 偏原参考室内木门背景，RED 略优 |
| A 泳装 / 2026101102 | 50.2 / 196.6 s | 9 / 9 | 两边均生成指定泳衣和坐姿，但保留室内背景，遗漏池边和全身构图 |
| A 黑内衣 / 2026101103 | 47.1 / 185.6 s | 9 / 9 | 两边均更换摄影棚、服装和姿态；都只到大腿，未完成全身与高腰要求 |
| B 图书馆 / 2026101104 | 47.3 / 186.6 s | 12 / 12 | 两边基本保留短发、脸形、微笑，衣服、场景和双手持书均完成，接近 |
| B 泳装 / 2026101105 | 46.3 / 185.6 s | 10 / 10 | 两边均完成海滩、全身和步行；身体偏正面，指定三分之四视角不足 |
| B 象牙白内衣 / 2026101106 | 47.4 / 185.6 s | 10 / 9 | RED 头到脚完整入框，Ray 裁到大腿；两边高腰要求均不明确，RED 构图执行更好 |

人物一致性这一维的六组评分两边逐组相同：`2、2、2、3、2、2`。两边都保留主要头发、眼睛和五官组合，也都有轻微脸形／眉眼漂移；没有稳定的 Ray 提升。A 的参考图遮住部分嘴和下脸，B 的全身输出脸部像素少，细小雀斑、眼色和手指／脚趾不能精确核验。可见结构和画质没有稳定差距；裁掉的部位不能作为“没有结构错误”的证据。

对照图每行依次为 **参考图、RED + Viggle 六步、Ray Turbo 十二步**：

- [人物 A 三组对照](../../.scratch/ray-turbo-comparison-20261011/comparison-a.png)
- [人物 B 三组对照](../../.scratch/ray-turbo-comparison-20261011/comparison-b.png)
- [盲评原始记录](../../.scratch/ray-turbo-comparison-20261011/review/BLIND_REVIEW.md)、[解码评分](../../.scratch/ray-turbo-comparison-20261011/review/decoded-scores.json)

## 六步补测

### 方法与实际口径

六步补测使用相同 Ray v1.3 INT8 完整文件、六组参考图／prompt／seed、832×1024、CFG1、encoder、VAE 和 cache。均无额外 Viggle LoRA。先只把十二步改成六步，保留 `seeds_2 + linear_quadratic`；再测 `euler + linear_quadratic` 六步。Euler 的前两组接近现有速度且未出现明显画面崩坏，因此补齐其余四组。

两种六步都不在该版本作者明示的编辑推荐范围内，属于探索性配方；不能因源码接受参数而声称作者推荐。独立代理按本机未改动的一手采样源码核验：完整六步 `seeds_2` 的采样器求值数推导为 11，十二步为 23；这是源码推导，不是插桩测得的底层 forward 数。[本机方法核验及源码行引用](../../.scratch/ray-turbo-comparison-20261011/RAY6_METHOD_REVIEW.md)、[作者版本参数](https://civitai.red/api/v1/model-versions/3395380)

重新校验五个资产的完整 SHA256 及运行版本，全部与首轮一致。新请求绑定 `sourceRevision`：`idream-worktree-ca5d226670c2a0be2c4ff34f399a1465a4993a6dfcaa5be3be1d59df2e2485a2`；相对首轮仅新增本报告初稿，没有进一步修改正式运行代码。[补测 preflight](../../.scratch/ray-turbo-comparison-20261011/ray6-preflight.json)

RED 和 Ray 十二步图片／耗时复用首轮记录，本轮只新增两种六步各六张。两轮不是同一服务会话，不能描述成同步随机交错测试；输入、权重、运行代码和环境绑定保持一致。Ray `seeds_2` 六步从新启动的 image runner 开始；随后 Euler 六步使用已经加载的 Ray diffusion 模型，先跑 A 咖啡馆／B 内衣，再补剩余四组。Euler 第一张也已热机，不能与首轮第一张当作冷启动对比。

### 速度结果

主表统一使用 A 咖啡馆以外的同五组案例；Euler 六步也排除 A 咖啡馆以保持比较集合相同，未把第二个 Bun 进程的第一张误当成模型冷启动。

| 配方 | 同五组中位数 | 平均值 | 范围 | 相对 RED 中位数 |
| --- | ---: | ---: | ---: | ---: |
| RED + Viggle，Euler 六步 | 47.254 s | 47.637 s | 46.252–50.152 s | 1.00× |
| Ray `seeds_2` 十二步 | 185.576 s | 187.977 s | 185.565–196.587 s | 3.93× |
| Ray `seeds_2` 六步 | 97.240 s | 97.856 s | 93.240–101.320 s | 2.06× |
| Ray Euler 六步 | 52.332 s | 53.456 s | 50.266–59.141 s | 1.11× |

Ray `seeds_2` 六步比十二步的同组中位数减少约 47.6%；Euler 六步接近现有速度，本轮观测中位数约慢 10.7%，没有实际提速。样本小、按块串行、基线跨会话复用，不为 10.7% 差异赋予统计显著性。Ray `seeds_2` 六步首张为 87.287 秒，Euler 六步首张为 51.334 秒，后者已热机。

| 案例 | Ray `seeds_2` 六步 | Ray Euler 六步 | 六步可见变化及问题 |
| --- | ---: | ---: | --- |
| A 咖啡馆 | 87.287 s | 51.334 s | 两种六步均完成户外咖啡馆；脸／皮肤与衣料较平滑，RED 细节略自然 |
| A 泳装 | 93.240 s | 50.266 s | `seeds_2` 六步完成池边背景，优于 RED／Ray 十二步该案例；Euler 沿用手遮口动作，场景替换不足；两种六步都裁掉脚踝 |
| A 黑内衣 | 101.320 s | 52.332 s | 两种六步仍只到大腿，没有完成全身；可见人物特征接近，RED 自然细节略优 |
| B 图书馆 | 100.282 s | 54.226 s | 两种六步持书／场景完成，但毛衣主要是直条织纹，RED 更明确完成指定绞花 |
| B 泳装 | 97.199 s | 59.141 s | `seeds_2` 六步前脚部分裁切；Euler 六步双脚完整，但人物和沙纹更软；身体均偏正面 |
| B 象牙白内衣 | 97.240 s | 51.314 s | 两种六步均截到大腿，RED 完成头到脚的全身构图 |

### 六步视觉评审与结论

每种六步各生成六张随机左右位置的盲图，由新的独立 AI 代理评分，完成后主任务解码。评分代理没有收到映射、耗时或带标签的对照图；同一代理评两种六步，首轮十二步由另一个代理评。**不跨评审代理比较绝对分数，也不把主观分数当作客观脸相似度或统计显著性。**

两轮六步评审的人物一致性各项两边均为 3/3，没有 Ray 稳定提升的证据；这只反映可见整体特征接近，不能证明微小雀斑／眼色／所有脸部细节精确一致。`seeds_2` 六步有一组明确场景优势（A 泳装），RED 有一组明确全身优势（B 内衣），其余以轻微 RED 偏好为主。Euler 六步五组轻微偏好 RED，B 内衣一组明确偏好 RED，主要依据是皮肤／衣料质感、动作与裁切。高腰款式判断在评审记录间存在差异；升级结论主要依赖可直接确认的场景、手势、绞花纹理和全身入框证据。

因此，**六步可尝试、Euler 六步可正常运行且速度接近现有方案；本次证据仍支持保留 RED 默认。** Ray diffusion 文件小一半是磁盘收益，本机没有峰值运行内存测试；不足以补偿当前没有稳定视觉收益的替换。

- [四套配方人物 A 对照](../../.scratch/ray-turbo-comparison-20261011/comparison-ray6euler-a.png)、[人物 B 对照](../../.scratch/ray-turbo-comparison-20261011/comparison-ray6euler-b.png)：列顺序为参考图、RED 六步、Ray 十二步、Ray `seeds_2` 六步、Ray Euler 六步。
- [Ray `seeds_2` 六步汇总](../../.scratch/ray-turbo-comparison-20261011/ray6-summary.json)、[Euler 六步完整汇总](../../.scratch/ray-turbo-comparison-20261011/ray6euler-summary.json)。
- [六步 `seeds_2` 解码评分](../../.scratch/ray-turbo-comparison-20261011/review-ray6/decoded-scores.json)、[Euler 解码评分](../../.scratch/ray-turbo-comparison-20261011/review-ray6euler/decoded-scores.json)。

新十二张全部生成成功，实际节点均绑定六步、指定 sampler 和相同其他输入；原生输出与交付 PNG hash 全部匹配。两轮累计 24 个不同原生 request ID，默认 descriptor 与初始 baseline 图一致。[完整补测验证](../../.scratch/ray-turbo-comparison-20261011/ray6-followup-verification.json)

全部请求结束后 native running／pending 都为 0，按同一 canonical PM2 配置停止 image，三个端口均拒绝连接，恢复先前停止状态。补测结束时 swap 为 1172.69 MiB，低于观察起点的 1188.69 MiB；没有观察到新增 swap，仍不是峰值内存／分页测量。`pmset` 未报告热或性能告警。[补测结束状态](../../.scratch/ray-turbo-comparison-20261011/ray6-completion-state.json)、[服务恢复](../../.scratch/ray-turbo-comparison-20261011/ray6-service-restoration.json)

## 加速配置与瓶颈归因

用户追问是否因为缺少加速方案后，复核了实际描述符、原生日志及本机运行源码。这次归因复核没有新增生成、安装插件、下载模型或修改运行配置；以下把已执行的配置、源码推导和未测试候选分开。

**不是全部优化都未开启，也不是已经穷尽 Ray 的优化。** 四套配方均使用 PyTorch 2.14.0 的 MPS 注意力、MPS 文本／视觉编码、已修正的 MPS VAE、CFG1／BasicGuider 单分支，以及 `QwenImage21Cache(device=auto, dtype=default)` 无损 prefix-KV 缓存配置。项目编码节点在 CFG1 时只计算一次 positive conditioning。缓存重用文本／参考图前缀，不跳过 diffusion steps；本轮没有逐层 cache-hit 计数。实际图及配置见 [Euler 六步描述符](../../.scratch/ray-turbo-comparison-20261011/variants/ray6euler/qwen-image-edit-img2img.json)、[原生日志](../../.scratch/ray-turbo-comparison-20261011/ray6-runner-log.txt)。

最明显的已测速度差异来自采样工作量：Ray `seeds_2` 十二步约 23 次模型求值，六步约 11 次，Euler 六步约 6 次。使用相同 Ray 权重，实测中位数依次为 185.6、97.2、52.3 秒。切换采样方案已经消除了大部分表面慢速，但同时改变了积分路径和视觉结果，不能把它视为画质完全不变的免费优化。

Ray INT8 的当前加载路径确实没有获得原生 INT8 GEMM 加速：两次服务会话的日志均显示 `Native ops` 为空、`int8_tensorwise` 属于 `emulated ops`；本机 ComfyUI 将 MPS 的 INT8 格式禁用为模拟运算。对应量化 Linear 分支将权重反量化，再调用浮点 `F.linear`，所以文件小一半并不代表推理更快。**这是代码路径证据，不是逐算子的耗时剖析；不能据此把全部额外耗时，或 Euler 六步剩余约 10.7% 差异，归因于反量化。** [本机 MPS 门控](/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI/comfy/model_management.py:2073)、[浮点 Linear 路径](/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI/comfy/ops.py:1384)、[格式禁用与日志来源](/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI/comfy/ops.py:1750)。

注意力扩展的安装也不代表这次实际启用。实际图没有 `SolAttnPatch` 或 `IDreamMPSGraphAttention`；日志只有导入记录，没有 Sol 全局 override 启用记录。本机 Qwen2.1 的 `prefix_cached_attention` 仍经过通用 attention override，但其 Q 只有目标图行，K/V 包含前缀和目标图；当前 Sol 实现遇到 Q/K 长度不等或 mask 会回退到 dense。这个源码推导说明不能简单插入节点就承诺缓存编辑提速，未新增运行测试。此前 Qwen 缓存形状的合成筛查中，MPSGraph BF16 为 39.874 ms、PyTorch BF16 为 38.144 ms，也没有测出收益；那不是本次完整模型激活或端到端对比。[历史筛查记录](QWEN21_MAC_IMAGE_EDIT_ACCELERATION_2026-10-01.md)

不能进一步推断 Apple Silicon 没有量化加速方案。2026-10-12 UTC 查询的一手上游显示：[ComfyUI-MPS-INT8](https://github.com/QZGao/ComfyUI-MPS-INT8) 用 `_weight_int8pack_mm` 在 Metal 内完成权重反量化与乘法，避免显式展开整份浮点权重；[comfy-kitchen PR #107](https://github.com/Comfy-Org/comfy-kitchen/pull/107) 仍为 draft，包含浮点 fallback 及后续 Metal 4 融合实现。它们与原生 INT8 GEMM 不是同一概念，不能由 MPS 的 `_int_mm` 不支持推出全部路线不可行。本机日志只注册 eager／不可用的 CUDA、HIP、Triton backend，没有这些新路径；现有 MPS 格式门控也不会因注册一个厨房 backend 自动解除。PR 的公开完整工作负载证据来自 MiniMax-H3／M1、M5，不是 M4 Max／Ray 图片编辑，不外推其耗时。

当时提出先剖析量化 Linear、注意力及编码／VAE 的实际耗时，再比较避免重复权重反量化的浮点常驻路线，或与本机门控、算子契约及 M4 兼容的 Metal 实现；保持 Euler 六步和同一输入，验证速度及数值／视觉差异。对现有 INT8 权重一次展开不会恢复量化丢失的精度，原始 BF16 权重又涉及新的模型资产，二者不能混作同一变量。后续 M4 实测见下一节；保留默认结论来自整体收益与视觉缺点，不是宣称所有优化路径都无法让 Ray 提速。

## M4 Max INT8 开销定位与实际加速（2026-10-12）

本轮先对真实 Ray 权重短环和一次完整图插桩，再运行同规格六步对照。没有更换 checkpoint、打开全局 INT8 格式门控或修改正式默认描述符。所有 GPU 短环、真实图与服务控制均使用项目 accelerator lease 和原生空闲检查。

### 实测瓶颈与内核筛选

Euler 六步实际触发 **6 次 diffusion forward、1574 次 QuantizedTensor.dequantize**：第一步为 449 次（包含首轮前缀构建），其余每步 225 次。按生成浮点权重逻辑字节累计 **91.75 GiB**，这个数是重复展开量，不是峰值内存。仅第一步逐调用 MPS synchronize 计时，反量化总计 **2.257 s**，约占该诊断 forward 的 **19.3%**；其余步只计次数，不能把首步比例外推成完整请求比例。插桩请求耗时不进入速度表。[真实插桩结果](../../.scratch/ray-turbo-comparison-20261011/actual-int8-profile.json)

三组短环使用真实 checkpoint 权重和固定种子的合成 BF16 激活，3328 行对应本轮目标图 latent 的 52×64。每条路径包含其所需 ConvRot；候选权重算子包含在线激活旋转，常驻方案沿用原先去量化后的矩阵。计时前后均同步 MPS，常规路径每组五次，PR107 每组三次，中位数如下，单位 ms。[短环完整数据](../../.scratch/ray-turbo-comparison-20261011/int8-micro-pr107.json)

| 真实层 / weight shape | 当前模拟 INT8 | 一次展开后 BF16 | PyTorch weight-only | PR107 Metal4 W8A8 |
| --- | ---: | ---: | ---: | ---: |
| attention.to_q / 4096×4096 | 10.26 | **7.98** | 9.45 | 10.72 |
| img_mlp.gate_layer / 12288×4096 | 30.06 | **23.18** | 24.99 | 26.11 |
| img_mlp.out / 4096×12288 | 30.53 | **23.64** | 27.74 | 29.49 |

常驻 BF16 的三层输出与当前路径逐元素完全相等。PyTorch `_weight_int8pack_mm` 在本机执行成功，输出有限，相对 RMSE 约 0.364–0.369%；PR107 的具体 Metal4 shader 也在 **M4 Max 实际编译和执行成功**，没有走其浮点 fallback，三层相对 RMSE 约 0.972–1.026%。这两种候选都没有快过常驻 BF16，且数值路径发生变化，因此本轮不接入正式 backend。PR107 的“能执行”不能等同于已完成全模型集成或图像效果验证。

第一次 weight-only 探针曾因 BF16 激活配 FP32 scale 出现 NaN；修正为与激活相同 dtype 后输出有限。这是探针契约错误，不能作为 M4 不支持该算子的证据。PyTorch shader 对 A 和 scale 使用同一个 DTYPE；PR107 的 weight scale 则明确为 float，二者契约不同。[PyTorch v2.14 shader](https://github.com/pytorch/pytorch/blob/v2.14.0/aten/src/ATen/native/mps/kernels/Quantized.metal#L472-L489)、[PR107 pinned shader](https://github.com/ikeyan/comfy-kitchen/blob/ae14ebb2dbc9d2ecf062286031eda73d02ba9e91/comfy_kitchen/backends/eager/mps_int8.py)、[兼容性研究](../../.scratch/ray-turbo-comparison-20261011/RAY_M4_KERNEL_RESEARCH.md)

### 已实现的 MPS 常驻方案

新增 [IDreamQwen21ResidentWeights](../../packages/gen/comfyui_nodes/idream_qwen21/resident.py)，私有评估图接线为 `UNETLoader → ResidentWeights → QwenImage21Cache → BasicGuider`。对当前模拟 INT8 Linear 逐层调用原去量化器，包含 ConvRot 逆旋转，保留 BF16 浮点 forward。转换发生一次，随后六步复用展开权重；这不会恢复 INT8 已丢失的精度。

节点只支持 Qwen2.1 / MPS，拒绝待应用的 weight/hook patches、重叠 object patches及非叶模块，并检查剩余统一内存。原 INT8 loader 与 BF16 表示同时存活，内存成本明显增加；active 模型 size 只是 Comfy 的当前模型计量，不能当总常驻内存或系统峰值。

初版验证时发现并修复了三个具体边界：active resident sibling 重建要按模块 key 读取原 object backup；表示改变要生成新 patches_uuid 以重算 loaded_size；缓存应持有整个 Linear 模块，而不是旧 Parameter，因为量化 Linear._apply 会替换 Parameter，后者可能继续保留 MPS 存储。ON_DETACH 还会把不在 active tree 内的原始量化模块移回 offload device。最终采用共享的模块替换，所有缓存 clone 都能观察到实际加载／卸载后的权重。

CPU/MPS 实际 Comfy Linear + ModelPatcher 回归覆盖原模型→resident→原模型、active sibling 重建、cached clone 卸载／重载及同 UUID 重用。旧实现出现 loaded_size `8392 != 16384`、重建抛错及卸载后缓存权重仍在 MPS；修复后 **13 项测试全部通过**。小层 allocator 从 280832 降到 264448 bytes，完整释放该层 16384-byte BF16 存储，重载输出仍逐元素相等。[回归代码](../../packages/gen/comfyui_nodes/idream_qwen21/test_resident_weights.py)、[MPS 通过记录](../../.scratch/ray-turbo-comparison-20261011/resident-module-mps-green.log)、[旧卸载失败记录](../../.scratch/ray-turbo-comparison-20261011/resident-unload-red.log)

### 速度与最终整图验证

继续使用相同六组参考图／prompt／seed、832×1024、CFG1、单张、相同 encoder／VAE／prefix cache。RED 保留 Viggle 自定义六步 sigmas；Ray 保留 Euler / linear_quadratic 六步。本轮重新生成 RED 和原始 Ray 基线，没有将历史跨日基线当同期测量。

第一阶段顺序为 RED→原 Ray→常驻 Ray，各六张；常驻中位数从 **56.210 降到 48.174 s，减少 14.3%**，相对同期 RED 的 51.202 s 快 5.9%。重启后反转顺序为常驻 Ray→RED，各六张，warm 中位数 **49.172 / 52.176 s**，常驻 Ray 快 5.8%。随后修复完整卸载生命周期并重启，重新生成六张；这最后六张绑定最终 canonical 实现。上述均是按块顺序测量，尚未随机交错或进行大量统计重复；中位数排除 A 咖啡馆，统一取其余五个案例，第一张单列。

| 配方 / 阶段 | warm 中位数 | warm 平均值 | warm 范围 | 第一张 |
| --- | ---: | ---: | ---: | ---: |
| RED 初轮 | 51.202 s | 50.394 s | 46.177–54.211 s | 46.276 s |
| Ray 原模拟 INT8 | 56.210 s | 55.864 s | 55.316–56.217 s | 57.306 s |
| Ray 常驻初版 | 48.174 s | 47.814 s | 47.181–48.187 s | 48.306 s |
| Ray 重建/计量修正 | 49.172 s | 49.583 s | 46.166–54.206 s | 45.653 s |
| RED 反序复测 | 52.176 s | 51.805 s | 51.183–52.207 s | 55.300 s |
| Ray 最终卸载修正 | 47.174 s | 47.987 s | 45.193–51.194 s | 45.461 s |

最终实现 warm 中位数 **47.174 s**，较本轮原 Ray 减少 **16.1%**，较反序 RED 少 **9.6%**。两个先前顺序的 RED 对照差异约 6%，因此合理结论是本机存在适度速度收益，不能将最后 9.6% 当稳定保证。各配方首张所处的模型、encoder、kernel/cache 热状态不同，不是同条件冷启动比较。

最终六张与原 Ray 六张逐像素全部一致；两个中间常驻版本也全部一致，RED 两轮重复输出同样逐像素一致。优化不会改善 Ray 的画质或身份保持，也没有引入本轮像素退化。新六步插桩实测为 **6 次 forward、0 次 sampling dequantize**，确认减少的是完整模型的重复权重展开。[最终原生图、hash、source revisions 与耗时验证](../../.scratch/ray-turbo-comparison-20261011/m4-final-verification.json)、[最终去量化计数](../../.scratch/ray-turbo-comparison-20261011/actual-resident-profile.json)

显式调用原生 `unload_models=true, free_memory=false`，保留诊断 clone 引用，225 个缓存 BF16 模块与原模型参数全部移到 CPU。MPS allocator 从 **14,916,806,912 降到 262,144 bytes**，共释放约 **13.89 GiB**，包含 diffusion 与其他已加载模型；它不是单独 BF16 权重的峰值。driver 分配从 18,741,936,128 降到 136,003,584 bytes。CPU 仍保留 14,092,861,440-byte 展开权重及原量化 loader，所以 MPS 释放不等同于这些数据从统一内存完全消失。后续真实重载出图成功，用时 53.591 s，重新加载/物化记录可见，输出仍与原 Ray 逐像素一致；不把该耗时纳入 warm 表，也不声称它复用了未被自动淘汰的执行缓存。[完整模型卸载证据](../../.scratch/ray-turbo-comparison-20261011/mps-managed-unload.json)、[重载报告](../../.scratch/ray-turbo-comparison-20261011/raymanaged-single-report.json)

最终节点运行的 `sourceRevision` 为 `idream-worktree-e22b9dd3e824c870818323864bd83292769e14860ae565d2dda0b9955fb94f66`；resident.py SHA256 为 `a0b5bbbda322058ea5a0412c57d93ddcd9f6f52b19e27245073f1a8a35e2138d`。记录保留每阶段自己的 source revision，并保存最终源码快照；前两个常驻阶段有上述生命周期缺口，不当作已可部署版本。报告与运行后验证文件在生成结束后更新，未改变测得的节点代码。[最终源码绑定](../../.scratch/ray-turbo-comparison-20261011/m4-managed-source.json)

本轮共新增 **39 张真实输出**：36 张未插桩系列、2 张诊断、1 张重载，全部使用不同原生 request ID、通过尺寸/完整性检查，原生与交付字节 hash 匹配。另有两次仅输出内存数据的原生诊断，不计图片。累计包括前两轮共 63 张。本地推理外部 API 费用与 Dreamcoins 均为 0；仍未创建 Main Turn/Job 或验证产品计费与持久化链路。

### 画质、人物一致性与升级结论

本轮重新随机左右位置，对 RED 初轮与常驻 Ray 的六组输出做独立 AI 盲评；代理仅读 prompts 与六张盲图，未读映射/耗时/带标签图片，评完才解码。它仍是主观视觉判断，不是客观人脸嵌入指标或真人评测。六组均偏好 RED，三组差异较明确，其余轻微偏好；相同像素验证使结果也适用于最终模块方案。

| 案例 | RED / Ray 总分（四维各 0–3） | 实际可见差异 |
| --- | ---: | --- |
| A 咖啡馆 | 11 / 9 | RED 户外场景更明确、牛仔布/发丝更清楚；Ray 背景更接近参考木门 |
| A 泳装 | 9 / 8 | 都遗漏池边/全身；Ray 额外沿用抬手遮嘴姿态 |
| A 黑内衣 | 9 / 8 | 都裁到大腿且高腰不明确；RED 纹理略自然 |
| B 图书馆 | 12 / 9 | RED 绞花执行与可见面部表情细节更好；Ray 毛衣较平滑 |
| B 泳装 | 10 / 9 | 两边全身、步行完成，视角偏正面；RED 沙地/人体纹理更清楚 |
| B 象牙白内衣 | 10 / 8 | RED 完成头到脚，Ray 裁到大腿；都没有明确高腰 |

人物一致性五组评分相同，B 图书馆偏好 RED；没有 Ray 稳定提升的证据。眼色、雀斑和全身图的细小面部特征仍受像素/遮挡限制。没有露骨裸露或性行为，不能把目录照结果扩展成露骨 NSFW 效果结论。[本轮盲评](../../.scratch/ray-turbo-comparison-20261011/review-m4/BLIND_REVIEW.md)、[解码评分](../../.scratch/ray-turbo-comparison-20261011/review-m4/decoded-scores.json)

因此，**适合这台 128 GiB M4 Max 的常驻方案确实让 Ray 六步变快；它提供内存换速度的候选，没有改善 Ray 的视觉缺点。当前仍保留 REDQW21 + Viggle 六步默认。** Metal 候选已实际执行，未测得胜过常驻 BF16；不把 M4 不具备 M5 Neural Accelerator 推成内核不能运行，也不外推此结果到更小内存机器。

- [人物 A 新对照](../../.scratch/ray-turbo-comparison-20261011/comparison-m4-a.png)、[人物 B 新对照](../../.scratch/ray-turbo-comparison-20261011/comparison-m4-b.png)：参考图 / RED / 原 Ray / 加速 Ray，最后两列像素完全一致。
- 最终 CPU/MPS 13 项回归、Gen 357 项测试（27 文件）及 typecheck 全部通过。[Gen 测试](../../.scratch/ray-turbo-comparison-20261011/m4-gen-tests.log)、[typecheck](../../.scratch/ray-turbo-comparison-20261011/m4-gen-typecheck.log)
- 服务按 canonical PM2/lease 流程停止，临时 profiler symlink 已移除，三个端口拒绝连接，恢复初始停止状态；ComfyUI 源树无修改，正式默认 descriptor 与 HEAD 相同。结束时 swap 1194.62 MiB，无热/性能告警；没有峰值分页采样，不能声称无新增 swap。[最终恢复状态](../../.scratch/ray-turbo-comparison-20261011/m4-completion-state.json)

## 可复现证据和权重

本地证据目录为 `.scratch/ray-turbo-comparison-20261011/`，受 Git 忽略；本报告入仓，原始 PNG、脚本和日志目前保存在本机，清理 scratch 会失去这些链接的目标。[汇总含十二个原生 request ID、时间和输出 hash](../../.scratch/ray-turbo-comparison-20261011/summary.json)；逐请求实际图保存在 `outputs/*-history.json`。私有工作流、[调用脚本](../../.scratch/ray-turbo-comparison-20261011/benchmark.ts)、[交叉验证脚本](../../.scratch/ray-turbo-comparison-20261011/summarize.ts)、[下载校验](../../.scratch/ray-turbo-comparison-20261011/download-verification.json) 均在该目录。

| 资产 | 文件大小 bytes | SHA256 |
| --- | ---: | --- |
| `redqw21_unlocked_v2_bf16.safetensors` | 14,230,284,672 | `c2ff9ea7e983b61589363fe11d0437419f7ade088bb470ef2e501bd81513c45f` |
| `ray_qwen21_turbo_v1.3_int8_convrot.safetensors` | 7,189,770,088 | `1499b8364e27df9a452e989178d671d1e61752e1a32090d21710f70afb7a7029` |
| `qwen3vl_8b_int8_convrot.safetensors` | 9,350,798,360 | `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f` |
| `qwen_image_2.1_vae_bf16.safetensors` | 675,509,688 | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` |
| `Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors` | 679,604,800 | `0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3` |

Ray diffusion 文件约为 RED 的 50.5%，这是明确的磁盘占用收益；不能等同于峰值运行内存减半。资产完整路径和运行时快照见 [assets.json](../../.scratch/ray-turbo-comparison-20261011/assets.json)。

## 实测中的修复与恢复

首次提交前发现实际 Bun `fetch` 对停止端口返回 `ConnectionRefused`，而 Gen idle 检查只识别 Node 的 `ECONNREFUSED`，导致停止的视频 runner 被误认为无法确认空闲。已在 canonical `comfyui-memory-transition.ts` 增加对应识别；回归用例修复前失败、修复后通过，memory transition 共十项测试通过，Gen typecheck 通过。该失败发生在提交前，没有产生原生请求或图片，不计入十二次模型统计。[失败记录](../../.scratch/ray-turbo-comparison-20261011/pre-submit-connection-failure.json)

仅启动了 image runner。全部生成后原生队列 running／pending 都为空；通用 `bun run comfyui:stop` 因未注册 video 进程提前退出，随后使用同一 canonical PM2 配置定向停止 image：`pm2 stop scripts/comfyui-ecosystem.config.cjs --only comfyui-image`。没有绕过 drain／ownership 拒绝。结束后 8188／8189／8190 均拒绝连接，image PM2 进程停止，运行服务状态恢复；保留了停止的 PM2 注册项。[恢复记录](../../.scratch/ray-turbo-comparison-20261011/service-restoration.json)

## 尚未验证的范围

六组仅覆盖两位虚构成年女性的单参考图编辑；本轮进行了有限的相同种子重复以验证实现和执行顺序，未做独立多种子统计重复；未测男性、多人物、多参考图、T2I、视频、连续多轮编辑或跨场景长期一致性。没有露骨 NSFW 数据，不能以作者“unlocked”声明替代实测。也未测试其他硬件、原始 Ray BF16 checkpoint 或本报告已列配方/优化以外的方案。

若以后出现新的 Mac 原生量化实现或其他编辑配方，应在相同输入上复测速度和构图；本轮包括两种六步的证据支持继续保留 RED 六步默认。关于候选来源、参数及官方许可的独立一手核验见 [元数据评审](../../.scratch/ray-turbo-comparison-20261011/METADATA_REVIEW.md)。
