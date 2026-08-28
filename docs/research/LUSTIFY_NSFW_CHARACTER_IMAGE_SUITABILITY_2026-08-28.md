# Lustify 是否适合 iDream 的 NSFW 角色图片生成

> 核验日期：2026-08-28  
> 目标资源：[LUSTIFY! [NSFW checkpoint]](https://civitai.red/models/573152/lustify-nsfw-checkpoint)  
> 最新版本：[v10 (Krea 2), modelVersionId=3112728](https://civitai.red/models/573152?modelVersionId=3112728)

## 结论

**模型能力层面：适合做“写真女性 + 显式成人场景”的专用文生图候选。** 作者把 Lustify 定义为针对女性显式/性场景优化的 photoreal checkpoint，支持自然语言和 Danbooru tag；最新 v10 已迁移到 Krea 2，并提供 Turbo、Raw、INT8 ConvRot、FP8/BF16 和 GGUF 变体。作者展示样本确实包含复杂成人动作、低机位、多人和明确解剖提示，使用的是 Turbo INT8 ConvRot、8 steps、CFG 1。[模型说明](https://civitai.red/api/v1/models/573152)；[v10 API](https://civitai.red/api/v1/model-versions/3112728)

**产品定位层面：不应替代 iDream 的通用角色主模型。** 它的明确训练目标是女性写真和成人场景，不是跨性别、跨画风、跨角色类型的通用角色资产引擎；而且 checkpoint 本身只有 T2I，不提供人物参考图或身份保持。作者另发的 Krea 2 Edit 工作流明确要求安装 `comfyui-krea2edit` 和独立 Identity Edit LoRA，说明人物保持不是 v10 checkpoint 的内置能力。[Lustify Workflows 说明](https://civitai.red/api/v1/models/2503119)

**当前 iDream 接入层面：不能直接接入。** iDream 现有 RedCraft 描述符虽然也是 Krea 2，但锁定了另一个 UNet、`qwen3vl_4b_bf16` 和 `qwen_image_vae`，且身份模式为 `none`；当前本机 ComfyUI 也没有 Lustify 权重、作者工作流使用的 `wan_2.1_vae`、`Krea2EditModelPatch` 或 `Krea2EditGroundedEncode`。需要新增独立、版本固定的 workflow descriptor，不能只替换文件名。

**生产许可层面：当前权限不支持把它作为 iDream 站外付费生成服务的模型。** Civitai API 返回 `allowCommercialUse=["RentCivit","Image"]`，但没有 `Rent`；Civitai 自己的权威 UI 映射把 `Image` 解释为“可以出售生成图片”，`RentCivit` 解释为“可以在 Civitai 运行”，而只有 `Rent` 才表示“可以运行在收费生成服务上”。因此它可作为受控内部资产制作/研究候选，但**不能仅凭当前权限元数据批准面向客户的收费在线生成**；这条路径至少需要作者对站外服务的书面许可。另有 Krea 2 底层社区许可证的一百万美元年营收门槛，达到门槛必须另购企业许可。[Civitai 权限元数据](https://civitai.red/api/v1/models/573152)；[Civitai 权限语义源码](https://github.com/civitai/civitai/blob/390a70c33285c5470a3b33f455f286afeb522972/src/components/PermissionIndicator/PermissionIndicator.tsx#L39-L54)；[Krea 2 Community License](https://github.com/krea-ai/krea-2/blob/db3984fbc6e13b34c0064990fc2d95ac64d00058/docs/KREA-2-COMMUNITY-LICENSE#L21-L31)

因此建议是：

- **不进入当前客户默认模型或 Premium 主模型。**
- **可进入隔离候选池**，优先比较成人写真/解剖/提示词遵循，而不是先替换人物保持路线。
- **若只用于 Admin 内部创建可商用角色资产**，当前 `Image` 权限提供了比客户付费生成更明确的依据，但仍应记录模型版本、文件 hash、Krea 2 营收门槛，并避免把它解释成已获站外 SaaS 授权。
- **若希望面向用户开放**，先取得作者允许 `Rent`/站外收费生成的明确授权；否则不发布。

## 1. 页面实际包含两套架构

这个 Civitai 页面不是单一架构。它有 17 个公开版本：最新 v10 是 Krea 2，之前主要是 SDXL 1.0/SDXL Lightning。

| 版本组 | versionId | Base model | 文件形态 | 适用判断 |
|---|---:|---|---|---|
| v10 (Krea 2) | 3112728 | Krea 2 Standard | 7 个 Raw/Turbo、SafeTensor/GGUF 变体 | 本报告的主要候选；最接近 iDream 当前 Krea 2 后端 |
| ZENITH v9 | 3045803 | SDXL 1.0 | FP16 pruned，约 6.46 GiB | 旧 SDXL 路线 |
| APEX v8 | 2808677 | SDXL 1.0 | FP16 pruned，约 6.46 GiB | 旧 SDXL 路线 |
| APEX Inpainting | 2875936 | SDXL 1.0 Inpainting | FP16 pruned，约 6.46 GiB | 局部修复专用，不是人物参考图模型 |
| GGWP v7 | 2155386 | SDXL 1.0 | FP16 pruned，约 6.46 GiB | 旧 SDXL 路线 |
| OLT 系列 | 1510911 / 1569593 / 1588039 | SDXL 1.0 / Inpainting | FP16 pruned，约 6.46 GiB | 旧 SDXL 路线 |
| ENDGAME 系列 | 1094291 / 1099200 | SDXL 1.0 | 普通 + DMD2，约 6.46 GiB | 旧 SDXL 路线 |
| v4 系列 | 926965 / 938628 | SDXL 1.0 / Lightning | 普通 + DMD2，约 6.46 GiB | 旧 SDXL 路线 |
| v2 系列 | 708635 / 715933 / 709664 | SDXL 1.0 / Inpainting / Lightning | 约 6.46 GiB | 旧 SDXL 路线 |
| v1 系列 | 638929 / 639425 | SDXL 1.0 / Lightning | 约 6.46–6.65 GiB | 最旧版本 |

版本、架构、文件大小来自同一个模型的当前 [Civitai Model API](https://civitai.red/api/v1/models/573152)。页面总说明仍写着“standard SDXL checkpoint”，这只准确描述旧版本；不能把它套在 v10 Krea 2 上。判断任何运行方式时都必须固定 `modelVersionId`。

### v10 精确文件

| fileId | 精确文件名 | 约大小 | SHA256 |
|---:|---|---:|---|
| 2997637 | `lustify-v10-krea-turbo-fp8.safetensors` | 11.94 GiB | `94D92700FC45200EF053895EC5655D4F64A69B924C1EFAA457521DFC22BD5E00` |
| 2996235 | `lustify-v10-krea-turbo-int8_convrot.safetensors` | 12.25 GiB | `0505412ED2AC568286C4BF43F8ACE93F9F5A6DD7A607F47F1912A68767E6900D` |
| 3015314 | `lustify-v10-krea-turbo-bf16.safetensors` | 24.48 GiB | `04571B6CF9B9C8A3868ED3695C94DE48D8206A37670EA36C6A043E86DDA327D3` |
| 3015315 | `lustify-v10-krea-raw-bf16.safetensors` | 24.48 GiB | `017F3363CAB2C9245CB156A70E41D12D67938DD6AF052B8432FF565436FEBBA4` |
| 3001078 | `lustify-v10-krea-turbo-Q2_K.gguf` | 4.68 GiB | `25656F59C6200AB625826F7CFA2D67CFD7C70FA4BE9D88BDB47BE6481CA4E5B1` |
| 3002352 | `lustify-v10-krea-turbo-Q4_0.gguf` | 7.74 GiB | `29DE9543AFD89548E1E630CF0759B7DDCA2C7FDB321A97AAA527FE608624376D` |
| 2997070 | `lustify-v10-krea-raw-int8_convrot.safetensors` | 12.25 GiB | `F165D4DB2A4C9A8CE67F88851216EC41EE64ED508F0755DE9D4DCD03175BC865` |

来源：[v10 API](https://civitai.red/api/v1/model-versions/3112728) 与模型页内嵌的一手文件元数据。Civitai 的简化 API 会把多个变体显示成同一个名字，因此实际接入必须同时 pin `fileId + SHA256`，不能只写页面版本号。

作者的版本说明给出的方向是：Turbo 用于日常推理，Raw 用于训练/微调；4 GB 选 Q2/Q4，8 GB 优先 Turbo Q4，12 GB 优先 Turbo INT8 ConvRot 或 Turbo FP8，24 GB 可运行完整 Turbo。[v10 版本说明](https://civitai.red/api/v1/model-versions/3112728) 这也与 Krea 官方“Raw 训练、Turbo 推理”的建议一致。[Krea 2 官方仓库](https://github.com/krea-ai/krea-2/tree/db3984fbc6e13b34c0064990fc2d95ac64d00058#usage)

## 2. 它擅长什么，边界是什么

作者明确声明的训练目标是：

- photoreal；
- 女性主体；
- explicit/sexual scenarios；
- 同时理解自然语言和 Danbooru tags；
- 强 NSFW 偏置，但也能生成 SFW 摄影、物体、动物和幻想环境。

来源：[模型作者说明](https://civitai.red/api/v1/models/573152)。

v10 的十张作者样本都记录为：

- `lustify-v10-krea-turbo-int8_convrot.safetensors`；
- `wan_2.1_vae.safetensors`；
- 1152×1536；
- 8 steps；
- CFG 1；
- Euler；
- simple 或 beta57 scheduler。

样本提示词覆盖女性单人、多人、低机位、舞台/夜店、明确成人动作与器具。这能证明模型及其作者工作流可以生成显式成人内容，但**作者精选样本不能证明人物跨图一致性、失败率或生产稳定性**。[v10 样本元数据](https://civitai.red/api/v1/model-versions/3112728)

对 iDream 的具体含义：

| 目标 | 适配度 | 原因 |
|---|---|---|
| 新建女性成人写真角色的首批草稿 | 高 | 与作者明确训练目标一致 |
| 显式成人姿势/场景 T2I | 高潜力 | v10 作者样本覆盖此类提示词 |
| 通用角色主模型 | 中低 | 训练目标偏女性写真；没有跨角色类型的作者承诺或基准 |
| 同一角色连续多张图 | 低（checkpoint 单独使用） | checkpoint 没有参考图输入；固定 seed 不能替代身份保持 |
| 一张参考图换姿势/服装/背景 | 可研究，未验证 | 需要额外 Krea2 Edit 节点 + Identity LoRA |
| 两个不同人物同时保持 | 实验性 | Identity Edit 作者明确说人脸分离仍不完美 |
| 局部修脸/修手 | v10 T2I 本身不负责 | 作者工作流另带 Face/Hand Detailer；当前 iDream ComfyUI 未安装对应节点 |

旧 SDXL 版本的作者参数是 DPM++ 2M SDE 或 3M SDE、Exponential/Karras、30 steps、CFG 2.5–4.5，highres 1.4–1.5、denoise 约 0.4；远景人脸/手建议 Inpainting 或 ADetailer。[模型作者说明](https://civitai.red/api/v1/models/573152) 这些参数不适用于 v10 Krea 2。

## 3. 人物保持不是 v10 的内置能力

Lustify 作者另外发布了 [Lustify Workflows](https://civitai.red/models/2503119/lustify-workflows-krea-2-sdxl)，其中 Krea 2 T2I 工作流是 `3123550`，Krea 2 Edit 工作流是 `3159388`。作者明确写明，Edit 路线必须另外取得：

1. [`comfyui-krea2edit`](https://github.com/lbouaraba/comfyui-krea2edit)；
2. [`krea2-identity-edit`](https://huggingface.co/conradlocke/krea2-identity-edit) LoRA；
3. 否则 edit functionality 不工作。

来源：[工作流模型说明](https://civitai.red/api/v1/models/2503119)。

Identity Edit 节点作者要求同时使用两条条件链：

- `Krea2EditModelPatch`：把 VAE 编码参考图作为 in-context latent token 注入；
- `Krea2EditGroundedEncode`：让 Qwen3-VL 在读编辑指令时真正看到参考图；
- 两个节点缺一不可，普通 `CLIPTextEncode` 会显著降低质量；
- v1.2 是当前推荐 LoRA，默认 `fit_mode=fit`、`ref_boost=1.0`；人物 likeness 可以尝试 `grounding_px=1024`；
- Turbo 快速路径是 8 steps、CFG 1；输出不超过 2 MP。

来源：[`comfyui-krea2edit` README](https://github.com/lbouaraba/comfyui-krea2edit/blob/86f886dac23013d88996e3a2e99093ba44d322fb/README.md#minimal-wiring)。

但这里存在一个必须诚实保留的证据边界：Identity Edit 作者只声称它作用于 Krea 2 Raw/Turbo，并明确说它只用 SFW 数据训练、没有训练或支持 NSFW 数据；Lustify 作者则推荐把它用于自己的 Krea 2 Edit 工作流。因此可以认为**结构上可组合**，但不能把“Lustify NSFW + Identity Edit 的成人角色保持质量”当作已被 Identity Edit 作者验证的能力。必须用实际成人角色参考图做 A/B。

## 4. 与 iDream 当前路线的关系

### 4.1 RedCraft Krea 2 T2I

iDream 当前 RedCraft 描述符是 ComfyUI T2I：

- `workflowKey=redcraft-krea2-redmix3-txt2img`；
- `modelId=redcraft-krea2-redmix3-fp8`；
- `UNETLoader` + `qwen3vl_4b_bf16` + `qwen_image_vae`；
- 832×1216、12 steps、CFG 1、Euler/simple；
- `identity.mode=none`，不接受任何参考图。

来源：[`packages/gen/workflows/redcraft-krea2-redmix3-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-redmix3-txt2img.json)。

Lustify v10 与它同属 Krea 2，基础 T2I 图结构相近，所以**新增一个平行 descriptor 的工作量较小**；但不能修改 RedCraft descriptor 去动态换权重。Lustify 作者工作流使用的是 `wan_2.1_vae`，iDream 使用 `qwen_image_vae`，二者能否互换没有本轮一手实跑证据，应遵循作者工作流先装 `wan_2.1_vae`，再单独验证是否能安全收敛到现有 VAE。

### 4.2 Qwen 角色参考图路线

iDream 当前人物保持路线是 `qwen-image-edit-multi-reference`：

- checkpoint：`Qwen-Rapid-AIO-NSFW-v19.safetensors`；
- `TextEncodeQwenImageEditPlus`；
- 接受 `identity_anchor` / `identity_reference` / `source_image`；
- 支持身份图 + source image；
- 4 steps、CFG 1、SA Solver/beta。

来源：[`packages/gen/workflows/qwen-image-edit-multi-reference.json`](../../packages/gen/workflows/qwen-image-edit-multi-reference.json)。

Lustify/Krea2 Edit **不能加载到 Qwen Image Edit workflow 中**。两者的 checkpoint、文本编码节点和参考图注入机制不同。可复用的是 iDream 上层的不可变 Reference Set、语义角色和候选/QA 流程；底层必须是另一个 versioned workflow descriptor。

### 4.3 当前本机 ComfyUI 事实

2026-08-28 的只读运行态探测：

- iDream ComfyUI 正监听 `127.0.0.1:8188`，Gen 默认也指向这个地址（[`packages/gen/src/env.ts`](../../packages/gen/src/env.ts)）；
- ComfyUI `0.33.0`、PyTorch `2.10.0`、设备是 MPS、统一内存 128 GiB；
- 已可见：`Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors`、`qwen3vl_4b_bf16.safetensors`、`qwen_image_vae.safetensors`、`UnetLoaderGGUF`；
- 不可见：任何 Lustify v10 UNet、`wan_2.1_vae.safetensors`、`Krea2EditModelPatch`、`Krea2EditGroundedEncode`；
- 作者完整工作流还依赖的 rgthree Power LoRA Loader 与 Impact Face/Hand Detailer 当前也不可见。

因此：

- T2I 也不是“下载一个 checkpoint 即可上线”，至少要增加模型/VAE和 descriptor；
- Edit 路线还要安装自定义节点、Identity LoRA，并建立参考图 slot 契约；
- 当前只确认了运行时具备原生 Krea 2 CLIP 类型和 GGUF Loader，**没有运行 Lustify**。

## 5. 许可判断

### 5.1 Lustify 作者在 Civitai 设置的权限

当前 API：

```json
{
  "allowNoCredit": true,
  "allowCommercialUse": ["RentCivit", "Image"],
  "allowDerivatives": false,
  "allowDifferentLicense": false
}
```

来源：[Civitai Model API](https://civitai.red/api/v1/models/573152)。

Civitai 自己的权限组件逐项定义为：

- `Image` → “Sell images they generate”；
- `Rent` → “Run on services that generate for money”；
- `RentCivit` → “Run on Civitai”；
- `allowDerivatives` → “Share merges using this model”。

来源：[Civitai 权限组件源码，固定 revision](https://github.com/civitai/civitai/blob/390a70c33285c5470a3b33f455f286afeb522972/src/components/PermissionIndicator/PermissionIndicator.tsx#L39-L54)。

所以当前权限支持无署名使用和商业化生成图片，也允许在 Civitai 上运行；但没有给出站外收费生成服务的 `Rent` 权限，并禁止分享 merge。iDream 是站外生成服务，不能把 `Image + RentCivit` 推导成 `Rent`。

### 5.2 Krea 2 底层许可

Krea 2 Community License v1 允许使用、修改、创建 derivative 和生成输出，但商业使用只覆盖全公司过去 12 个月总营收低于 100 万美元的主体；达到或超过门槛必须先获得 Krea Enterprise License。分发模型/derivative 或包含它的产品/服务还附带协议、命名和 NOTICE 要求。来源：[Krea 2 Community License，固定 revision](https://github.com/krea-ai/krea-2/blob/db3984fbc6e13b34c0064990fc2d95ac64d00058/docs/KREA-2-COMMUNITY-LICENSE)。

Krea AUP 没有按名称一刀切禁止虚构成年人的自愿成人内容，但会约束 CSAM、NCII、违法、侵权等用途；许可证还要求部署者采用合理的内容过滤措施。来源：[Krea 2 Acceptable Use Policy](https://www.krea.ai/krea-2-use-policy) 与 [Community License §4.2](https://github.com/krea-ai/krea-2/blob/db3984fbc6e13b34c0064990fc2d95ac64d00058/docs/KREA-2-COMMUNITY-LICENSE#L35-L56)。这部分不改变 iDream 已定产品边界，只是上线前必须保留的底层许可条件。

两层许可要同时满足；Krea 底层允许并不能覆盖 Lustify 作者没有开放 `Rent` 的问题。

## 6. 如果取得许可，最小验证顺序

### 阶段 A：只验证 T2I 专项能力

不要先接默认 profile。新增隔离 candidate descriptor，固定：

- `modelVersionId=3112728`；
- 精确 `fileId + SHA256`；
- CUDA 候选优先作者推荐的 Turbo INT8 ConvRot；
- 当前 MPS 环境优先以 Turbo BF16 做正确性基准，再测 Turbo FP8；INT8 ConvRot 是否能在当前 MPS/comfy-kitchen 路径执行必须实跑，不能从“能被 Loader 看见”推导；
- 按作者证据先使用 `wan_2.1_vae`；
- 1152×1536、8 steps、CFG 1、Euler/simple 作为第一组；
- 与 RedCraft 使用同一批 prompt、seed、分辨率和候选数进行对照。

至少覆盖：单人半身、单人全身、远景、极端机位、双人、多人、遮挡、手部互动、文字/服装/背景约束。记录 artifact、脸数、解剖错误、提示词遵循、人物多样性、延迟和峰值内存。

### 阶段 B：验证角色身份保持

在 T2I 通过后再安装固定 revision 的 `comfyui-krea2edit` 与 `krea2_identity_edit_v1_2`，增加新的参考图 descriptor，不复用 T2I descriptor：

- `Krea2EditModelPatch` + `Krea2EditGroundedEncode` 两节点同时存在；
- LoRA strength 1.0；
- `fit_mode=fit`；
- `ref_boost=1.0` 起步；
- 人物参考 `grounding_px=1024` 起步；
- Turbo 8 steps、CFG 1；
- 输出 ≤2 MP；
- 同一个 Reference Set 做服装、姿势、背景、镜头距离、显式程度五轴变化；
- 与当前 Qwen multi-reference 的身份相似度、身体特征保持和动作完成率对照。

由于 Identity Edit 作者没有提供 NSFW 训练/支持，只有这组实测能回答“Lustify 的成人能力与 Identity Edit 的人物保持是否能同时成立”。

### 阶段 C：发布门槛

只有以下条件同时满足才考虑成为产品 profile：

1. 已有 Lustify 作者对站外收费生成服务的明确授权；
2. Krea 2 营收门槛/企业许可状态已记录；
3. 当前 CUDA 或 MPS 目标硬件的真实 workflow probe 通过；
4. 人物身份与成人动作 A/B 达到既定阈值；
5. descriptor、模型 hash、节点 revision、VAE、LoRA 和输入 slot 都不可变固定；
6. 仍作为“成人写真专项”profile，而不是未经验证替换通用角色主模型。

## 7. 本轮没有证明什么

- 没有下载 v10 权重：Civitai 下载端点要求登录，本轮没有借用用户会话或凭证。
- 没有在本机、CUDA 或生产环境生成图片。
- 没有测速度、峰值内存、失败率、身份相似度或解剖正确率。
- 没有证明 Lustify 可以直接使用 iDream 当前 `qwen_image_vae`。
- 没有证明 Krea2 Identity Edit 在 Lustify 的显式成人场景中保持身份。
- 没有把作者精选图或 Civitai 点赞/下载量当作生产质量基准。
- 没有修改任何代码、profile、数据库或 ComfyUI 安装。

当前能下的结论只是：**它是一个技术上很值得隔离实测的成人写真 T2I 专用候选；现有许可和人物保持证据不足以批准成为 iDream 的客户生成主模型。**

## 一手来源

- [Lustify Civitai Model API](https://civitai.red/api/v1/models/573152)
- [Lustify v10 Krea 2 Version API](https://civitai.red/api/v1/model-versions/3112728)
- [Lustify Workflows Model API](https://civitai.red/api/v1/models/2503119)
- [Krea 2 官方仓库](https://github.com/krea-ai/krea-2/tree/db3984fbc6e13b34c0064990fc2d95ac64d00058)
- [Krea 2 Community License](https://github.com/krea-ai/krea-2/blob/db3984fbc6e13b34c0064990fc2d95ac64d00058/docs/KREA-2-COMMUNITY-LICENSE)
- [Krea 2 Acceptable Use Policy](https://www.krea.ai/krea-2-use-policy)
- [`comfyui-krea2edit` README](https://github.com/lbouaraba/comfyui-krea2edit/blob/86f886dac23013d88996e3a2e99093ba44d322fb/README.md)
- [`krea2-identity-edit` 模型仓库](https://huggingface.co/conradlocke/krea2-identity-edit)
- [Civitai 权限语义源码](https://github.com/civitai/civitai/blob/390a70c33285c5470a3b33f455f286afeb522972/src/components/PermissionIndicator/PermissionIndicator.tsx)
- [iDream RedCraft Krea 2 descriptor](../../packages/gen/workflows/redcraft-krea2-redmix3-txt2img.json)
- [iDream Qwen multi-reference descriptor](../../packages/gen/workflows/qwen-image-edit-multi-reference.json)
- [iDream Gen ComfyUI runtime address](../../packages/gen/src/env.ts)
