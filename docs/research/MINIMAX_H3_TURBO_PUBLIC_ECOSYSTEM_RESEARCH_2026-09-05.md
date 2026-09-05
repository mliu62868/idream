# MiniMax-H3 Turbo 公开生态与社区反馈调研

核查日期：2026-09-05。范围：通用视频模型的技术谱系、公开资源类型、作者版本建议及第一手社区反馈。未执行模型生成或质量盲测。

## 结论

Larry 的 Turbo 是 MiniMax-H3 的少步数加速 LoRA。Civitai.red 可公开核实到使用它的通用工作流，但工作流的评价不能转移给 LoRA 或其他衍生模型。公开资料支持“有相当关注度，也有多位用户正面反馈”，不支持“全站第一”或“社区一致公认最好”。[作者模型卡](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) · [Civitai 工作流](https://civitai.red/models/2838258/minimax-h3-4-steps-turbo-video-aio-workflow)

本次没有完整访问登录后目录，也未核实专用内容模型的训练与质量，因此不据此作其存在性或推荐排名结论。

## 技术谱系与版本

| 对象 | 第一手可确认的角色 | 来源 |
| --- | --- | --- |
| MiniMaxAI/MiniMax-H3 | 原始 33B 音视频基础模型，FL2VA 与 Ref2VA 为不同任务 checkpoint | [官方模型卡](https://huggingface.co/MiniMaxAI/MiniMax-H3) |
| Comfy-Org/MiniMax-H3 | 面向 ComfyUI 重新封装的模型文件；不是仅凭平台模型树标签即可认定的再训练模型 | [Comfy-Org 模型卡](https://huggingface.co/Comfy-Org/MiniMax-H3) |
| larryvrh/MiniMax-H3-Turbo-Lora | 附加于 H3 基础模型的加速适配器；作者称采样从约 20 步降到最低 4 步，约 5 倍仅指采样加速 | [作者模型卡](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) |
| ComfyUI-MiniMax-H3-Turbo | 加载适配器和处理音视频采样兼容性的节点代码，不是另一套模型权重 | [作者 GitHub](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) |

作者目前把 `minimax_h3_turbo_v4_step600_ema.safetensors` 列为通用首选，主张其改善静态、小幅动作、面部与细节。对于 4 步下的大幅快速动作，作者保留 v1-850 的特定用途；作者同时明确产品仍为 preview，音频与快速动作仍待改善。这些属于作者判断，不等于独立评测结论。[版本说明](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora#which-checkpoint--v4-step-600-or-v1-850)

不要把“最新上传文件”理解成“最新正式推荐”：

- v4-600 EMA 上传：2026-08-07 22:46:18 UTC。[对应提交](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/commit/7b7ac96b0616100db75ea285090210c3ddf37c04)
- 模型卡版本取舍更新：2026-08-07 23:30:05 UTC。[对应提交](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/commit/afc0346516372a17162c14df3c5264de1d9aa1c0)
- 仓库最新上传：2026-08-08 20:07:30 UTC，`experimental_v5_step_600.bin`；现有模型卡仍推荐 v4-600 EMA。[对应提交](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/commit/43a74557ac3f6539db8e0f2a959d03feb7a81480)

## Civitai.red 的公开证据

本轮访问确认以下通用资源；没有把搜索引擎摘要当成模型详情页证明。

| 字段 | 公开页面观测 | 能支持的判断 |
| --- | --- | --- |
| 条目 | `MiniMax-H3 4 Steps Turbo Video AIO Workflow`，作者 EKKIVOK | 存在通用 H3 Turbo 工作流 |
| 类型与文件 | Type 为 Workflows；V3 FINAL；JSON 65.84 KB；页面日期 Aug 6 | 是工作流配置，不是独立训练权重 |
| 评价 | 主页面 `Very Positive (101)` | 该工作流收到较多正面评价 |
| 评价列表 | 对应版本评价页标题显示 100 条，与主页面 101 不一致 | 保留口径差异，不计算精确好评率 |
| 数字统计 | 顶部显示 4.3k，版本 Stats 显示 3918；抓取文本未保留图标含义 | 不擅自标为下载量或独立使用人数 |
| 关联资源 | 工作流链接到条目 2838221，版本 3203523；目标详情页要求登录 | 未核实关联 LoRA 的当前版本说明与统计 |

来源：[工作流详情](https://civitai.red/models/2838258/minimax-h3-4-steps-turbo-video-aio-workflow) · [该版本评价页](https://civitai.red/models/2838258/reviews?modelVersionId=3203564) · [关联通用 LoRA 条目](https://civitai.red/models/2838221/minimax-h3-turbo-lora?modelVersionId=3203523)

上述两个条目的公共 API 请求均返回 HTTP 403。登录墙和 API 访问失败意味着目录覆盖不完整；“未核实到”不能写成“没有”。

## 第一手社区反馈

讨论日期由 Hugging Face 公开 API 的绝对时间核实，以下日期均为 UTC。摘要区分用户自述、作者解释和未解决问题。

| 讨论与日期 | 正面反馈 | 负面反馈或证据限制 |
| --- | --- | --- |
| [#26，2026-08-08](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/26) | kipdg 表示新版修复近景面部问题；另一用户也认可画面效果 | 帖内提到低步数音频不好、暗灰墙面色阶断层；评论混有旧版命名，不能当严格统一版本测试 |
| [#30，2026-08-08 至 09](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/30) | 发帖者喜爱正常运行时的效果；RTX 4060 Laptop 8 GB、96 GB RAM 调整节点后报告 16 分 37 秒、17 分 42 秒，属本机局部缓解 | 初始耗时大幅波动；另有意外衣饰、低显存模式画质下降反馈。作者只推测 offload/swap，不能归为 LoRA 必然缺陷或推及 MPS |
| [#36，2026-08-16 至 17](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/36) | 用户做了基础版与 Turbo 的对照描述 | 报告色偏、过锐、景深改变和随机瑕疵；所称 pruned 文件来源被其他用户追问，实验可复现性不完整 |
| [#39，2026-08-19 至 29](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/39) | 多位用户认可 Larry 版本的画质与速度 | 对其他加速方案的看法分歧；作者 8 月 19 日承认更优四步版本尚无满意成果，没有承诺等质 |
| [#42，2026-08-25 至 29](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/42) | 两位用户称其为自己当前最满意的 H3 LoRA | 样本小、主观评价；参考视频兼容性的回答来自普通用户，不能当作者保证 |
| [#43，2026-09-04](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/43) | 无质量评价 | 用户询问是否仍需自定义节点；本次读取时未见答复 |

上述六帖是定向样本，不是全量评价抽样调查；没有统一硬件、输入、随机种子和盲评协议，不能算成功率或可靠排名。

## 维护与兼容性

作者 GitHub 说明：较新 ComfyUI 已原生处理音视频不同采样时间表；自定义采样器会检测版本并适配。加载节点还负责裁剪基础模型的时间条件补回及低显存权衡，因此“新 ComfyUI 的普通采样器可用”不等于“所有自定义节点都没用了”。[作者 README](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo#why-a-custom-sampler-and-how-it-adapts)

GitHub 默认分支最新提交为 `4274783a23afcfdbea3b4876cb79effd6c510785`，2026-08-14 合入参考图像、视频、音频的条件处理修复。这证明有兼容性维护，不证明所有工作流、所有平台均已稳定。[对应提交](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo/commit/4274783a23afcfdbea3b4876cb79effd6c510785)

## 关注度及统计边界

| 公开指标 | 2026-09-05 观测 | 来源 |
| --- | --- | --- |
| HF likes | 926 | [模型 API](https://huggingface.co/api/models/larryvrh/MiniMax-H3-Turbo-Lora) |
| HF downloads / 页面 Downloads last month | 696,647 | [模型 API](https://huggingface.co/api/models/larryvrh/MiniMax-H3-Turbo-Lora) · [模型页](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) |
| HF 当前 revision | `43a74557ac3f6539db8e0f2a959d03feb7a81480` | [模型 API](https://huggingface.co/api/models/larryvrh/MiniMax-H3-Turbo-Lora) |
| GitHub stars / forks | 552 / 40 | [仓库 API](https://api.github.com/repos/Larryvrh/ComfyUI-MiniMax-H3-Turbo) |

HF 官方按特定文件请求计数，包含 GET 和 HEAD；独立用户去重需要另外处理。因此 696,647 不能表述为约 70 万人使用，也不能代表某个 checkpoint 的独立下载人数。[HF 官方统计说明](https://huggingface.co/docs/hub/models-download-stats)

这些指标适合说明项目的关注度和分发活动，不能单独证明画质、成功率、口碑一致性或 Civitai 排名。当前证据最稳妥的描述是：Larry Turbo 有公开使用与正面评价基础，通用作者首选仍为 v4-600 EMA，但存在实质性质量和运行反馈分歧。
