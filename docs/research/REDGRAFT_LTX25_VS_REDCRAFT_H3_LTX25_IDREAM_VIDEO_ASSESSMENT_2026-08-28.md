# RedGraft LTX 2.5 vs RedCraft H3 + LTX 2.5：iDream 视频生成适配评估

日期：2026-08-28  
范围：仅核验公开模型页、Civitai API、可下载 workflow、官方上游文档与许可证；未下载大模型、未做本机生成、未改运行配置。  
证据标记：**事实** = 可由文件/API直接核验；**作者宣称** = 模型作者描述；**推断** = 基于已核验事实给出的工程判断。

## 结论

**当前 iDream 应优先把 RedGraft `3250230` 作为 LTX 2.5 候选做受控 A/B，不应把 RedCraft beta2 `3262321` 当作当前视频默认路由的直接替代。**

原因很直接：

1. **RedGraft 是单一 LTX 2.5 diffusion checkpoint，并附带可下载的完整 ComfyUI workflow JSON。** 工作流明确包含 I2V/T2V 切换、首帧条件、音视频 latent、8 步低分辨率采样、×2 latent upscale 和 3 步高分辨率细化。它与 iDream 当前的角色首图 → 视频产品形态、LTX 2.x 后端边界更接近。
2. **RedCraft 当前 beta2 只公开了一个 MiniMax H3 INT8 checkpoint。** 作者所说的 H3 → LTX 2.5 IC-V2V → RIFE → VSR 2K 链没有公开 workflow、LTX checkpoint、IC-LoRA、RIFE/VSR 文件清单或版本锁；不能凭这一份 H3 文件复现宣传链路。
3. 对角色一致性，RedGraft 至少有可审计的首帧 I2V 条件路径；RedCraft 的 beta2 页面只有作者对“双阶段更稳”的说明，没有可复现参数或 identity benchmark。两者都没有公开跨 seed、跨动作的角色一致性量化结果，所以不能仅看样例断言质量胜负。
4. RedCraft 还叠加 MiniMax H3 与 LTX 两套上游许可证和两套运行栈。若开发或服务位于美国、欧盟、英国或韩国，MiniMax H3 社区许可证本身不授予使用权，需要另行申请授权；这使它不适合作为 iDream 当前默认候选。

RedCraft beta2 更适合保留为一条**未来高规格研究路线**：当目标是先由 H3 生成更强的语义草稿和原生音频，再花第二阶段成本做 LTX 清晰化时再评估。它不是一个“下载后直接替换 LTX”的模型。

## 1. 两个链接实际指向什么

### A. RedGraft `3250230`

来源：[模型页](https://civitai.red/models/1295569/redgraft-ltx-25-fast-2k-or-sulphur2-ported?modelVersionId=3250230)、[version API](https://civitai.red/api/v1/model-versions/3250230)、[model API](https://civitai.red/api/v1/models/1295569)、[workflow 下载](https://civitai.red/api/download/models/3250230?fileId=3133242)（访问：2026-08-28）。

| 项目 | 已核验值 |
| --- | --- |
| 模型 / 版本 | `REDGraft LTX 2.5 ... sulphur2 ported` / `LTX 2.5 REDGraft（NSFW）` |
| Civitai model type | `Checkpoint` |
| base model | `LTXV 2.5`，`Standard` |
| 主文件 | `redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors` |
| 文件类型 / 格式 / 精度 | `Diffusion Model` / SafeTensor / `int8` |
| 大小 | `16,626,975.796875 KiB`，约 **15.857 GiB** |
| SHA-256 | `AB59BB5E74E76937B55A6876FB23C4B58261E798227EB544F7D8A2934728C882` |
| 附带文件 | `redgraftLTX25Fast2K_ltx25RedgraftNSFW.json`，约 0.198 MiB |
| 作者说明 | “same-architecture weight-space transfer / sulphur2 ported / Fast 2K”；没有训练集、合并比例、对照实验或硬件计时 |

**事实：** JSON 是真实可下载、可解析的 ComfyUI workflow，不只是页面附件占位。  
**事实：** 下载文件名与 workflow 默认引用的 `REDGraft-ltx25-sulphur2-int8-convrot-ComfyMCP.safetensors` 不一致，导入时需要显式绑定或改 workflow 中的模型名。  
**证据缺口：** 页面没有说明权重移植的源 checkpoint、方法细节、训练/合并数据、质量回归或许可证文件；“sulphur2 ported”只能作为作者命名，不能独立证明具体能力来源。

### B. RedCraft 无版本参数链接

来源：[模型页](https://civitai.red/models/958009/redcraft-or-or-redmix-hybrid-a2a-beta2-ltx25-2k)、[model API](https://civitai.red/api/v1/models/958009)、[当前 beta2 version API](https://civitai.red/api/v1/model-versions/3262321)（访问：2026-08-28）。

该链接没有固定 `modelVersionId`。本轮以 model API 排在最前、且与页面标题 `beta2 + LTX25 2k` 对应的当前版本 **`3262321` / `H3 A2A-RED ( beta2 )`** 为比较对象；以后页面更新时必须重新固定版本。

| 项目 | 已核验值 |
| --- | --- |
| Civitai model type | `Checkpoint` |
| 当前版本 | `3262321` / `H3 A2A-RED ( beta2 )` |
| base model | **MiniMax H3**，不是 LTX 2.5 |
| 公开文件 | 仅 `redcraftREDMIXHybridA2A_h3A2AREDBeta2.safetensors` |
| 文件类型 / 格式 / 精度 | `Diffusion Model` / SafeTensor / `int8` |
| 大小 | `21,984,166.7265625 KiB`，约 **20.966 GiB** |
| SHA-256 | `6A1E09871380982A96C0AF058AF35CD61B34E4A47A567B4704BDAA7D0F5FD60F` |
| workflow / config | **未公开** |

**事实：** Civitai API 只列出这一份 H3 checkpoint；没有 LTX 2.5 权重、IC-LoRA、RIFE、VSR 或 workflow JSON。  
**推断：** 页面标题中的 `+LTX25 2k` 描述的是作者使用该 H3 checkpoint 的外部多阶段配方，不是这个 checkpoint 自身的 base model 或自包含能力。

## 2. 工作流与真实输出规格

### RedGraft：可审计的单 LTX 两阶段工作流

可下载 JSON 的当前默认值如下：

| 项目 | workflow 事实 |
| --- | --- |
| 当前模式 | `Switch to Text to Video? = false`，走首帧 I2V；工作流同时暴露 T2V 切换 |
| 时长 / 帧率 | 10 秒 / 24 fps；表达式为 `duration × fps + 1`，即 **241 帧** latent |
| 目标尺寸 | **1152×768**；低分辨率 latent 使用宽高各除以 2，即 576×384 |
| 主采样 | Euler、CFG 1、手动 sigma 8 个区间（8 步） |
| 放大细化 | LTX latent spatial upscaler ×2，再用 3 个 sigma 区间（3 步） |
| I2V 条件 | `LTXVImgToVideoInplace`，默认 strength 0.7 |
| 音频 | 创建 LTX audio latent，使用 LTX 2.5 audio VAE 解码，最终 H.264 MP4 带音频 |
| active decoder | tiled video VAE decode；可选 FILM、SeedVR2、额外 1.25× image upscale 均处于 bypass |

工作流引用但不随附件一起提供的主要依赖包括：

- `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`；
- `ltx-2.3-spatial-upscaler-x2-1.1.safetensors`；
- `ltx-2.5-video-vae-conv-bf16.safetensors`；
- `ltx-2.5-audio-vae-bf16.safetensors`；
- ComfyUI VideoHelperSuite、rgthree Power Lora Loader、数学/resize/VRAM 等节点；
- workflow 中列有多项可选 LoRA，但默认均关闭；不能把这些 LoRA 的能力算到主 checkpoint 上。

Civitai version API 的 10 个样例均是视频，尺寸只有 **768×1152 或 1152×768**，metadata 为 11 steps、CFG 1、Euler / Euler a。这与 workflow 的 8+3 步一致。

**结论：当前可下载 workflow 并没有实际配置成 2K。** `Fast 2K` 是标题/作者定位；附件能直接证明的是 1152×768、10 秒、24 fps、8+3 步的两阶段 LTX 路线。要声称 2K，仍需固定更高分辨率配置并实测显存、时间和角色稳定性。

### RedCraft：作者描述的 H3 → LTX → 后处理链

作者页面描述：

1. MiniMax H3 低分辨率 I2V，同时生成画面与音频，约 6 steps；
2. LTX 2.5 22B 以 H3 成片做 IC-LoRA 视频引导，蒸馏约 8 steps；
3. latent ×2 upscale 再约 3 steps；
4. RIFE 插帧到 48 fps；
5. VSR 输出约 1440×2160。

作者给出的 CUDA 计时是 8 秒 2K：A5000 24 GB 约 200 秒、5090D 24 GB 约 120 秒，并称 16 GB+ VRAM 可跑。

这些都是**作者宣称**，不是可复现实验记录：API 样例虽含 768×1152 与 1440×2160 视频，也记录了 11/19/21 steps、CFG 1 和 Euler / Euler a，但没有帧数、时长、workflow 或逐阶段资源 metadata。公开下载又只有 H3 checkpoint，因此本轮无法验证作者完整链的速度、2K 输出、角色一致性或依赖版本。

## 3. I2V、T2V、角色一致性与音频

| 维度 | RedGraft `3250230` | RedCraft beta2 `3262321` |
| --- | --- | --- |
| I2V | **直接证据强**：workflow 的默认分支就是首帧 I2V，strength 0.7 | **作者说明有**：H3 先做低分辨率 I2V；但 beta2 workflow 未公开 |
| T2V | workflow 有显式 T2V 开关；默认关闭 | 官方 MiniMax H3 基座支持 T2VA，但 beta2 具体图未公开 |
| V2V / reference | 当前附件是 image-conditioned LTX；未见多参考身份图接口 | 作者让 LTX 以 H3 成片做 IC-V2V；具体 IC 模型和参数未公开 |
| 原生音频 | workflow 建 audio latent 并用 LTX audio VAE 解码 | 作者称 H3 负责原生音频，LTX 复用/同步；上游 H3 官方支持同步音视频 |
| 角色一致性 | 首帧条件路径可审计，较贴合 iDream；无公开 identity benchmark | 双阶段可能保留动作/语义，但两次生成与 VSR 也可能累积身份漂移；无公开 identity benchmark |
| 可复现性 | **中**：有 JSON，仍缺模型依赖包与版本锁 | **低**：只有 H3 checkpoint，完整链缺失 |

MiniMax 官方模型卡确认 H3 基座支持 T2VA、FL2VA 与 Ref2VA，并能生成同步立体声音频、最长 15 秒、最高 2K；这些是**上游 H3 能力**，不能自动等同于 RedCraft beta2 checkpoint 已公开相同工作流。[MiniMax H3 官方模型卡](https://huggingface.co/MiniMaxAI/MiniMax-H3)（访问：2026-08-28）。

## 4. 硬件与运行风险

### NVIDIA / CUDA

- RedGraft workflow 同时使用 INT8 LTX checkpoint 与 INT8 ConvRot Gemma；其内部旧名还带 `CutDownToFit_24gbGpus`。但作者没有为 RedGraft 发布任何实际硬件计时。
- Comfy 官方 INT8 tensorwise / ConvRot 文档把原生快路径建立在 **NVIDIA SM >= 7.5** 上；不支持的设备会退到 eager 或反量化 matmul，能加载不等于得到 INT8 加速。[Comfy INT8 tensorwise 格式](https://github.com/Comfy-Org/comfy-quants/blob/main/docs/formats/int8_tensorwise.md)、[LTX 量化说明](https://github.com/Comfy-Org/comfy-quants/blob/main/docs/quantization/ltx2.md)（访问：2026-08-28）。
- RedCraft 的 120–200 秒数据明确是 24 GB NVIDIA 卡，而且覆盖作者完整双阶段链；不能换算成 Mac 时间。

### Apple Silicon / iDream 本地候选

官方 LTX 2.5 有可用的 Apple Silicon 路线：LTX-2 源码优先选择 MPS 并使用 `mps-sdpa`，LTX Desktop 允许 Apple Silicon 在至少约 15 GB 空闲 RAM 时做本地 streaming；v1.2.7 还专门修复了 LTX 2.5 Fast 在 Mac denoise 阶段内存暴涨/冻结的问题。[LTX-2 官方仓库](https://github.com/Lightricks/LTX-2)、[LTX Desktop runtime policy](https://github.com/Lightricks/LTX-Desktop/blob/main/backend/runtime_config/runtime_policy.py)、[LTX Desktop v1.2.7](https://github.com/Lightricks/LTX-Desktop/releases/tag/v1.2.7)（访问：2026-08-28）。

这只证明**官方 BF16 LTX 2.5 pipeline**存在 Mac 支持，不证明 RedGraft 的第三方 INT8 port 在 MPS 上有相同性能。对 iDream 的 Mac 路线，RedGraft 应先作为 checkpoint/quality 候选；若 INT8 没有原生 MPS 快路，应比较官方 BF16 streaming，而不是把 `int8` 文件大小当成实际加速。

RedCraft 需要 H3 与 LTX 两阶段、额外 IC/RIFE/VSR 资产和阶段卸载。即使统一内存足够，它仍有更高磁盘、编排、错误恢复和总延迟成本；公开页面没有 MPS benchmark。

## 5. 许可证与商业使用边界

### Civitai 页面权限

两个模型的 model API 均显示：

- `allowCommercialUse`: `Image`, `Rent`, `RentCivit`；
- `allowDerivatives: true`；
- `allowDifferentLicense: true`；
- `allowNoCredit: false`。

这是 Civitai 作者设置，不会覆盖上游基础模型许可证。

### RedGraft / LTX 2.5

LTX-2.x Community License 自 2026-08-11 起适用于 LTX 2.5：通常授予使用和衍生权，但年收入达到 **1,000 万美元** 的实体，除纯非商业用途外，需要向 Lightricks 获取付费商业协议；衍生 checkpoint 仍受该许可证约束。[官方许可证入口](https://github.com/Lightricks/LTX-2/blob/main/LICENSE)、[LTX-2.x 条款](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x)（访问：2026-08-28）。

### RedCraft / MiniMax H3 + LTX 2.5

MiniMax H3 Community License 把美国、欧盟、英国、韩国列为排除地区；社区许可证只在其它“Applicable Territory”授予权利，排除地区需另行联系 MiniMax 申请授权。适用地区内，年收入超过 **2,000 万美元** 的商业产品/服务还需事先书面授权，并有 UI 标识等条件。[MiniMax H3 官方许可证](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)（访问：2026-08-28）。

若使用作者描述的第二阶段，还要同时满足 LTX 2.5 许可证。**因此 RedCraft 路线的商业授权复杂度显著高于单 LTX RedGraft。** 这里仅记录公开条款，不构成法律意见；生产采用前应按实际经营实体、部署地域和收入核对。

## 6. 对 iDream 的选择建议

### 首选候选：RedGraft `3250230`

适合验证的目标：

- 角色首图驱动的 5–10 秒 I2V；
- LTX 2.x 后端的最小增量升级；
- 单模型家族、可审计 workflow、音视频同生成；
- 固定输入图、prompt、seed、分辨率与 8+3 步，和现有 route 做身份、动作、音频、延迟 A/B。

它仍**不应直接上线**，因为当前只有作者样例，没有 iDream 自有角色图的 identity benchmark；“2K”也未由附件默认配置证明。最低验证应记录 checkpoint SHA、实际 device/quant path、峰值内存、wall time、帧数、输出尺寸、音频轨、面部/身体身份漂移和失败恢复。

### 研究候选：RedCraft beta2 `3262321`

仅当以下目标优先时考虑：

- H3 的语义草稿与原生声音价值足以抵消第二阶段成本；
- 已拿到 MiniMax 授权（若部署/开发落在排除地区）；
- 作者提供或团队自行重建并锁定完整 H3 → LTX IC-V2V → RIFE → VSR 图；
- 可接受双模型资产、阶段卸载、更多中间产物和更长恢复链。

在这些条件满足前，它不是可公平对比的“另一个单模型”；它是一条未完整公开的多阶段系统方案。

## 7. 尚不能从公开资料得出的结论

- 哪个模型对 iDream 的同一角色、同一 seed、同一动作更像；必须生成 A/B。
- RedGraft 权重移植是否优于官方 LTX 2.5 distilled；作者没有公开消融或基准。
- RedGraft 是否能按标题稳定产出 2K；公开 workflow 与样例只证明到 1152×768 / 768×1152。
- RedCraft beta2 完整 2K 链能否由公众复现；当前缺 workflow 和依赖锁。
- 两者在 Apple M4 上的真实速度；作者硬件数据仅覆盖 RedCraft 的 NVIDIA 路线。

因此当前决策应是：**先测 RedGraft，保留 RedCraft 为需要补齐 workflow 与授权后才进入的高规格实验，不替换默认 route。**
