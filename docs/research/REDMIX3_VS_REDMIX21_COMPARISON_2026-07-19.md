# RedMix3 与 RedMix2.1 / 赤佬2 Krea2 对比

日期：2026-07-19
模型集合：Civitai Red model `958009`
对比版本：RedMix3 `3139241` vs RedMix2.1 / 赤佬2 `3086841`

## 结论

**RedMix3 是真实的新 Krea2 版本，不再只是集合标题中的预告；但现有 Civitai 样图不足以证明它在质量上全面优于 RedMix2.1，更不足以直接替换 iDream 的 Mac BF16 serving 路径。**

- `3139241` 于 2026-07-17 发布，API 名为“赤佬 3.0 (Krea2)”，与 `3086841` 一样是 `Krea 2 / Standard`。它不是旧文件改名：三个下载变体均有新的 file ID 与 SHA-256。
- 作者明确宣称 RedMix3 “Optimize visual effects”，推荐范围从 RedMix2.1 的固定 8 steps 扩为 8–12 steps；但没有公开训练配方、受控 benchmark、失败率或定量质量结果。
- RedMix3 当前提供 FP8、NF4、INT8 三个 SafeTensor；RedMix2.1 只提供一个 INT8 SafeTensor。RedMix3 的 FP8 primary 让 Mac 离线转 BF16 **更有研究价值**，但 Civitai 没有 BF16 文件，且本轮没有下载 12.24 GiB 权重检查 header，所以不能宣称现有 FP8 转换脚本可直接复用。
- 两个版本的 10 张作者样图全部使用各自的 **FP8 scaled 演示权重**，不是 INT8/NF4 下载变体的质量证明。
- RedMix3 样图全部是 12 steps / Euler；RedMix2.1 样图全部是 8 steps，且 sampler 有 Euler、ER_SDE、Euler ancestral。两组前两张虽然 prompt 完全相同，但 seed、steps、上传尺寸和后处理不同，不构成受控 A/B。
- 从实际缩略图可见，RedMix3 的展示集更集中于强反射/折射、夸张前景透视、多人密集构图、复杂室内和极端近景；这与作者“视觉效果优化”的展示意图一致。它只能证明作者选择了更高压力的展示任务，不能单独证明模型能力提升。
- Mac MPS 仍不能原生执行 INT8 ConvRot 快速路径，也没有官方证据证明 NF4/FP8 变体可直接在 MPS 上高效运行。正确候选顺序是：**RedMix3 FP8 → 检查布局 → 离线 BF16 → 独立 workflow A/B**；INT8/NF4 不作为 Mac 首选。

## 一、证据分层

本文把结论分成三类，避免把作者宣传或画廊观感写成事实：

1. **作者明确声明**：来自 Civitai version description，例如 “Optimize visual effects”、推荐 steps/sampler。
2. **文件与参数事实**：来自 `civitai.red/api/v1/model-versions/*` 的 version、file、hash、`images[].meta` 与内嵌 ComfyUI workflow。
3. **样图观察 / 推断**：来自本轮直接查看 Civitai CDN 的 20 张作者缩略图；只描述展示集倾向，不推导未受控的模型优劣。

主要来源：[RedMix3 `3139241` API](https://civitai.red/api/v1/model-versions/3139241)、[RedMix2.1 `3086841` API](https://civitai.red/api/v1/model-versions/3086841)、[model `958009` API](https://civitai.red/api/v1/models/958009)。

## 二、版本身份与作者声明

| 项目 | RedMix3 | RedMix2.1 |
| --- | --- | --- |
| Version ID | `3139241` | `3086841` |
| API name | 赤佬 3.0 (Krea2) | 赤佬2 (Krea2)Edition |
| Base / type | Krea 2 / Standard | Krea 2 / Standard |
| Created UTC | 2026-07-17 18:17:56 | 2026-07-01 02:30:01 |
| Published UTC | 2026-07-17 19:04:35 | 2026-07-01 13:55:47 |
| Updated UTC | 2026-07-17 19:04:35 | 2026-07-17 18:17:56 |
| 作者内容声明 | No Mosaics；Optimize visual effects | No Mosaics |
| 作者推荐 | ER_SDE / Euler；Simple；CFG 1；8–12 steps | ER_SDE / Euler；Simple；CFG 1；8 steps |

### 命名并不完全一致

RedMix3 同时存在四套名称：

- API version name：`赤佬 3.0 (Krea2)`；
- 作者 version description 的友好文件名：`Krea2RedMix3.1-INT8-Convrot-ComfyUI`；
- 10 张样图 metadata：`Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors`；
- 三个实际下载资产：`redcraft23INT8INT4FP8_30Krea2.safetensors`。

Civitai API 没有给出 “3.0 = 3.1” 的 hash 映射。供应链身份必须使用 version ID + file ID + precision + SHA，不能只用友好名称。

RedMix3 description 首行仍写 `Krea2-RED-Mix2`，同时下文又列 `Krea2RedMix3.1`；这很像从旧说明沿用的模板文本。可确认的版本身份应以 `3139241` API object 和文件 hash 为准，不能用这行文本把 RedMix3 解释成 RedMix2。

另一个时间关系也不能被过度解释：`3086841.updatedAt` 恰好等于 `3139241.createdAt`。它只能证明作者创建 RedMix3 时也更新了 RedMix2.1 的站点记录，不证明 RedMix2.1 的 file `2968503` 被重传；其 file ID 与 SHA 仍未变化。

来源：[RedMix3 API](https://civitai.red/api/v1/model-versions/3139241)、[RedMix2.1 API](https://civitai.red/api/v1/model-versions/3086841)。

## 三、下载变体、大小与 hash

### RedMix3 `3139241`

三个下载项的 API 文件名相同，必须用 file ID、`metadata.fp`、下载 query 和 hash 区分：

| File ID | API precision | Primary | 大小 | SHA-256 |
| --- | --- | --- | ---: | --- |
| `3019490` | SafeTensor FP8 | yes | 12,833,814.8125 KiB / 12.239280 GiB / 13,141,826,368 bytes | `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA` |
| `3019523` | SafeTensor NF4 | no | 6,269,985.6953125 KiB / 5.979524 GiB / 6,420,465,352 bytes | `167BC68F286D6ACCC69D0572DDF23850EBC43ADDA09D36CA3F3F891FA525A5F1` |
| `3019607` | SafeTensor INT8 | no | 12,528,865.40625 KiB / 11.948457 GiB / 12,829,558,176 bytes | `A5DD85F90F873F80E2B07CB8D06FD6011755FCFB22434DFBB04155345EAA44B9` |

下载链接：[FP8 primary](https://civitai.red/api/download/models/3139241)、[NF4](https://civitai.red/api/download/models/3139241?type=Diffusion%20Model&format=SafeTensor&fp=nf4)、[INT8](https://civitai.red/api/download/models/3139241?type=Diffusion%20Model&format=SafeTensor&fp=int8)。

完整补充 hash：

| Precision | BLAKE3 | AutoV2 | CRC32 |
| --- | --- | --- | --- |
| FP8 | `C0661E9E2F7629451F65F39BEE9C12994F81EEFCBF039797E748BEC699DBFF2C` | `F6088960C0` | `5A93E5CC` |
| NF4 | `76DA6E8E45788AB524075A2FAD79819F55535EEC04302552988F8D1D3EA09A7B` | `167BC68F28` | `27F939EC` |
| INT8 | `428BD4C00F285C458482AA76FBDF80EF32AB6B3D2CA7D348F4AD04B881B4B5A2` | `A5DD85F90F` | `A4EA8638` |

需要特别纠正：作者文字写 `INT8/INT4 Convrot`，但 Civitai 第二个文件的结构化 metadata 是 **`fp=nf4`**，不是 `int4`。在没有下载并解析 SafeTensor 内部 quant layout 前，API 只能证明它是 NF4 变体，不能独立证明它就是 ComfyUI v0.28 的 `convrot_w4a4` 布局。

### RedMix2.1 `3086841`

| File ID | API precision | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| `2968503` | SafeTensor INT8 | 13,801,011.46875 KiB / 13.161670 GiB / 14,132,235,744 bytes | `C7C8D0EED618F7B971629B0AA7B115D4536C8BEE14E3AFB6D928B0A9DC14F804` |

RedMix2.1 没有可下载的 FP8、NF4、INT4 或 BF16 附件。其 10 张样图所用 FP8 demo 也没有与唯一 INT8 下载物建立 hash 对应。

来源：[RedMix3 API files](https://civitai.red/api/v1/model-versions/3139241)、[RedMix2.1 API files](https://civitai.red/api/v1/model-versions/3086841)。

## 四、作者样图的真实运行参数

### 汇总

| 项目 | RedMix3 10 张 | RedMix2.1 10 张 |
| --- | --- | --- |
| 样图实际 UNet | `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` | `Krea2RedMix2.1-8Steps-fp8-scaled-ComfyUI.safetensors` |
| 下载文件是否就是样图文件 | 否；无 hash 对应 | 否；无 hash 对应 |
| Steps | 10/10 都是 12 | 10/10 都是 8 |
| Sampler | 10/10 Euler | 8 Euler、1 ER_SDE、1 Euler ancestral |
| Scheduler / CFG / denoise | 全部 Simple / 1 / 1 | 全部 Simple / 1 / 1 |
| Text encoder | 全部 `qwen3vl_4b_bf16.safetensors`, type=`krea2` | 相同 |
| VAE | 全部 `qwen_image_vae.safetensors` | 相同 |
| Negative | `ConditioningZeroOut` | 相同 |
| 原生生成尺寸 | 5 张 1440×2160；5 张 1024×1536 | 8 张 1440×2160；2 张 960×1440 |

RedMix3 作者 description 允许 8–12 steps，但实际画廊只展示 12 steps；因此画廊不能证明它在 8 steps 时与 RedMix2.1 等质或更好。

来源：[RedMix3 `images[].meta.comfy`](https://civitai.red/api/v1/model-versions/3139241)、[RedMix2.1 `images[].meta.comfy`](https://civitai.red/api/v1/model-versions/3086841)。

### 上传像素不等于原生生成尺寸

RedMix3 的前三张：

- `meta.width/height` 与 KSampler latent 为 1440×2160；
- Civitai 上传尺寸为 1920×2880；
- 内嵌 workflow 含 SeedVR2 DiT/VAE/upscaler，目标 resolution 1920。

RedMix2.1 的第 3、4 张：

- 原生生成尺寸为 960×1440；
- 上传尺寸为 1920×2880；
- 同样含 SeedVR2 放大链。

部分 RedMix3 workflow 还包含 `4x-ClearRealityV1.pth`、`ImageSharpen` 与额外 `ImageScale` 节点。即使某些上传尺寸与原生 metadata 相同，这些节点的存在也说明作者工作图不是纯粹的 “UNet → VAE → Save” 单变量比较。

所以不能用 Civitai 的 1920×2880 标签宣称模型原生输出了该尺寸，也不能把放大后的细节全部归因于 RedMix3。

## 五、同 prompt 样图对照为何仍不是 A/B

两组画廊的第 1、2 张使用 **字节级相同 prompt**，主题分别是：

1. 短发人物、眨眼、强烈百叶窗日光、手部框住镜头的近距离自拍；
2. 短发人物、白色蕾丝头饰与室内暖光肖像。

对应事实：

| Pair | RedMix3 seed / steps / upload | RedMix2.1 seed / steps / upload | 其他差异 |
| --- | --- | --- | --- |
| 1 | `486071801727172` / 12 / 1920×2880 | `814689809324741` / 8 / 1440×2160 | RedMix3 workflow 有 SeedVR2 |
| 2 | `504026452438077` / 12 / 1920×2880 | `352373993916756` / 8 / 1440×2160 | RedMix3 workflow 有 SeedVR2 |

这两组最适合观察“作者想展示什么”，但仍不能回答“同 seed、同 steps、同分辨率、无后处理时谁更好”。至少有四个混杂变量：checkpoint、seed、steps、upscale。

代表样图：[RedMix3 pair 1](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/ad0eb2e0-c228-4131-956d-ca01b95552d3/original=true/137002547.jpeg)、[RedMix2.1 pair 1](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/99b23182-3fb7-465b-affa-b4cf656dfcbf/original=true/135393478.jpeg)、[RedMix3 pair 2](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/efc16419-9ced-4029-bc41-0ffffb022b91/original=true/137002552.jpeg)、[RedMix2.1 pair 2](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/60cf56c5-ae20-4641-99e5-3db5737c350b/original=true/135393486.jpeg)。

## 六、视觉与构图倾向

以下是对本轮实际查看的 20 张 Civitai 缩略图的**展示集观察**，不是模型能力的定量结论。

### 作者展示意图

RedMix3 画廊明显把更多位置用于构图与视觉效果压力场景：

- 大面积透明/高光材质、红色球体与樱桃、浅景深散景；
- 玻璃/水波造成的面部折射与条纹光影；
- 超大前景手指、低机位广角、明显透视缩短；
- 十余人密集群像与多层遮挡；
- 多个近似人物同时出现在深景复杂室内；
- 男性时尚肖像、生活空间、成人场景和极端宏观近景并列，题材跨度更大。

RedMix2.1 画廊更偏“生活摄影叙事 + 成人压力场景”的混合：

- 火车高速运动背景、影院、跑步、餐厅等日常场景；
- 同样包含多人群像、极端前景、POV 与复杂成人构图；
- 视觉语言整体更接近自然光/纪实照片，特殊折射、透明材质与超复杂室内的占比更低。

这与作者对 RedMix3 的 “Optimize visual effects” 宣称方向一致；但画廊选题本身已经变化，因此不能据此证明 RedMix3 在随机业务 prompt 上普遍更擅长复杂构图。

### 同 prompt 两组的可见差异

在相同 prompt 的前两组缩略图中，RedMix3 展示结果呈现出：

- 更强的局部微对比、皮肤高光与材质边缘；
- 第 1 组更紧密的前景手部框景；
- 第 2 组更宽的坐姿/服装构图，而 RedMix2.1 更接近自拍裁切。

这些差异真实存在于作者上传图，但 RedMix3 同时换了 seed、增加 4 steps 并经过 SeedVR2，因此不能写成“RedMix3 模型本身带来更高细节或更好构图”。

### 不能从画廊得到的结论

- 不能证明 FP8、NF4、INT8 三个 RedMix3 下载变体质量等价；
- 不能证明 RedMix3 在同 seed 下优于 RedMix2.1；
- 不能证明 12 steps 的收益来自模型，而不是更多采样计算；
- 不能证明角色一致性、脸/手/肢体失败率或 prompt 遵循率改善；
- 不能证明上传图的锐度与高分辨率由原始 checkpoint 单独贡献。

## 七、Mac MPS 部署影响

### 三个 RedMix3 变体的含义

| 变体 | Mac MPS 判断 | 建议 |
| --- | --- | --- |
| FP8 primary | MPS 不能原生稳定执行 Float8 权重；但它最可能允许离线恢复到 BF16 | **Mac 首选研究对象**：先检查 header/layout，再决定能否复用 scaled-FP8 → BF16 工具 |
| NF4 | 作者称 INT4 ConvRot，但 API 只证实 NF4；没有 MPS 原生快速路径或该文件的成功证据 | 不作为 Mac serving 候选 |
| INT8 | ConvRot 快速 matmul 面向 CUDA；PyTorch `_int_mm` 无 MPS dispatch | 不作为 Mac serving 候选 |

RedMix3 比 RedMix2.1 更适合继续研究 Mac 路线的原因，不是它能直接跑 MPS，而是它**终于公开了 FP8 primary**。RedMix2.1 只有 INT8 ConvRot，若想恢复 BF16 需要正确处理 scale、group size 与逆 ConvRot；RedMix3 FP8 如果与旧 RedMix 1.1 的 scaled-FP8 布局一致，理论上转换路径更简单。

但“如果布局一致”目前仍是待验证条件。本轮没有下载 12.24 GiB FP8 文件，不能确认：

- tensor dtype 与 scale sidecar 命名；
- 是否所有量化权重都适用现有 `weight.float() * weight_scale` 逻辑；
- 样图所用 `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` 是否与 file `3019490` hash 相同；
- 转换后 BF16 是否与作者 FP8 demo 或 CUDA 结果数值/视觉一致。

### 官方运行时边界

- ComfyUI v0.27.0 引入原生 INT8 支持，并固定 `comfy-kitchen==0.2.16`。
- `TensorWiseINT8Layout` 的官方说明写明快速矩阵乘使用 `torch._int_mm` / cuBLASLt IMMA，最低 SM 7.5；无 CUDA capability 时 `supports_fast_matmul()` 返回 false。
- 专用 `convrot_w4a4` 支持在 ComfyUI 2026-07-09 的 commit / PR `#14859` 中加入并进入 v0.28.0，不在 v0.27.0。因此作者所写 “INT4 Convrot for ComfyUI 0.27” 与官方版本历史不一致。
- 截至 PyTorch 2.13.0，`_int_mm` dispatch 仍只有 CPU、CUDA、XPU，没有 MPS。

来源：[ComfyUI v0.27.0 requirements](https://github.com/Comfy-Org/ComfyUI/blob/v0.27.0/requirements.txt)、[ComfyUI INT4 ConvRot commit](https://github.com/Comfy-Org/ComfyUI/commit/73e84d5ec8b943dcb42535229eb94ee7ab3abea1)、[comfy-kitchen v0.2.16 INT8 layout](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.16/comfy_kitchen/tensor/int8.py)、[PyTorch 2.13.0 operator dispatch](https://github.com/pytorch/pytorch/blob/v2.13.0/aten/src/ATen/native/native_functions.yaml)。

## 八、对 iDream 的建议

### 当前不变

保留现有 [`redcraft-krea2-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-txt2img.json) 与 `redcraftKREA2RedMix_krea2Edition-bf16.safetensors` 作为 Mac 默认/回滚路径；不要用 RedMix3 FP8/NF4/INT8 文件直接覆盖。

### 下一步候选顺序

1. 下载 RedMix3 FP8 primary `3019490`，校验 SHA-256 `F608...09EA`。
2. 只读解析 SafeTensor header，核对 FP8 tensor、scale、metadata 与当前已跑通的 RedMix 1.1 FP8 布局。
3. 若布局兼容，离线生成独立命名的 RedMix3 BF16；若不兼容，停止套用旧转换器并实现对应 layout-aware 转换。
4. 新建独立 workflow key，推荐先测作者实际画廊配置 12 steps / Euler / Simple / CFG 1，同时增加 8 steps 同条件组。
5. 做三层受控对照：
   - RedMix3 BF16：8 vs 12 steps，隔离采样计算差异；
   - RedMix3 BF16 vs RedMix2.1/当前 RedMix 1.1 BF16：同 prompt/seed/resolution；
   - 如有 CUDA runner，再对 RedMix3 FP8/INT8/NF4 做同内容量化对照。
6. 验收角色资产核心指标：脸/手/身体结构、多人物遮挡、复杂室内、角色一致性、prompt 遵循、失败率、MPS 峰值内存与 p50/p95。

## 最终判断

**RedMix3 值得进入“Mac BF16 转换 + 受控 A/B”的下一阶段，但目前还不值得直接替换。**

相对 RedMix2.1，它的实际优势是：

- 版本和权重已经正式发布；
- 提供 FP8 primary，使 Mac 离线 BF16 路线比“只有 INT8 ConvRot”更现实；
- 作者样图展示了更广的复杂构图与视觉效果目标。

仍未解决的是：

- 下载 FP8 与作者样图 FP8 demo 没有 hash 对应；
- 没有 BF16 原生文件或 MPS 成功证据；
- 画廊不是同 seed / 同 steps / 同后处理的受控 A/B；
- 没有证明 RedMix3 在 iDream 最重要的角色资产一致性指标上更优。
