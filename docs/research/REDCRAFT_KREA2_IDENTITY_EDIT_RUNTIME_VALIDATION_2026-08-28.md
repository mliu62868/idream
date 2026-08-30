# RedCraft + Krea2 Identity Edit 本机验证

日期：2026-08-28  
环境：Apple Silicon / MPS，128 GB unified memory，ComfyUI `0.33.0`，PyTorch `2.10.0`

## 结论

工作流工程链路通过，参考图输入契约得到明确验证：

- 单参考图绑定、RedCraft FP8、Identity Edit v1.2、双条件节点、稳定种子和 PNG 交付均真实运行成功；
- 全身参考图会把服装与姿势一并当成 appearance：`4/768`、`2/512`、`1/384` 都保留了白色比基尼；
- 只含脸和头发的 reference 在相同 prompt/seed 下完整执行酒店、单人和裸露指令，没有服装泄漏；
- 脸图 `4/768` 比 `2/512` 更接近参考的眼型、脸宽和笑容结构，因此成为默认；
- 脸图没有身体像素，身体比例必须由 Character 的结构化 appearance 文本负责；
- profile 继续保持 `publicSelection.explicitOnly=true`，直到多角色固定集证明身份通过率。

## 固定输入

- full-body reference：`packages/main/public/images/ourdream/card-alexa-reeves.webp`
- face-only reference：`/tmp/idream-alexa-face-only-reference.png`，从同一原图裁出，仅含头脸与头发，SHA-256 `29f8043353c9880410fde1ef3e859e45706e9a946b77fd9d0d8b3ab6dcb90d50`
- reference role：`identity_anchor`
- seed：`486071801727172`
- output：`832×1216`
- sampler：Euler / Simple
- steps / CFG：`12 / 1`
- prompt 意图：保持 Alexa 的脸、眼睛、发际线、长金发和肤色，把角色重构成夜间酒店卧室的全身裸露编辑图。脸图不能为身体比例提供像素证据。

## 精确运行资产

| 资产 | 本机路径 | SHA-256 / revision |
|---|---|---|
| RedCraft 3.0 Krea2 FP8 | `/Users/kk/ComfyUI-Shared/models/diffusion_models/Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` | `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA` |
| Identity Edit v1.2 full | `/Users/kk/ComfyUI-Shared/models/loras/Krea2/krea2_identity_edit_v1_2.safetensors` | `6ADF9A69CC9502D286DB7B69964D37DA7E9CFE4B05B4D004BC275F087D3FD3CF` |
| `comfyui-krea2edit` | `/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI/custom_nodes/comfyui-krea2edit` | `bdfa8b267fdb13730868d435b277dcfe696ec083` / package `1.2.5` |

## 真实推理结果

| reference | 参数 `ref_boost / grounding_px` | 耗时 | 文件 SHA-256 | 身份 | 场景/裸露指令 |
|---|---|---:|---|---|---|
| 全身图 | `4 / 768` | `587,480 ms` | `911190e72677240e9c382b8dfa4d544f9e16aef48372518a388c4d746e5eb911` | 强，但复制姿势 | 场景通过；裸露失败 |
| 全身图 | `2 / 512` | `496,303 ms` | `79eb5c6d69332cd07868297e2ebe1bcc74a1682490ba18fe26a9b1b2b742ba1c` | 强 | 场景通过；裸露失败 |
| 全身图 | `1 / 384` | `555,806 ms` | `3b9bae7f4a01cfa126bf43d942c584ce137b80812213d3cf028c1ab73fe09d4b` | 强 | 场景通过；裸露失败 |
| 纯脸图 | `2 / 512` | `923,778 ms` | `b8c5a6c8d5b0a0cb681f6cd8a6cde6726da709cb374ae700a18e9c87be0d4f50` | 中等，脸宽/鼻口有漂移 | 全部通过 |
| 纯脸图 | `4 / 768` | `800,118 ms` | `ae27826fd921a8e176cad1afa7fd365c1b0d7e26ac1bbbd9b710e175caf4f81d` | 本组最佳，仍需多角色验收 | 全部通过 |

输出分别位于：

- `/tmp/idream-redcraft-krea2-identity-alexa-seed486071801727172.png`
- `/tmp/idream-redcraft-krea2-identity-alexa-rb2-g512-seed486071801727172.png`
- `/tmp/idream-redcraft-krea2-identity-alexa-rb1-g384-seed486071801727172.png`
- `/tmp/idream-redcraft-krea2-face-only-alexa-rb2-g512-seed486071801727172.png`
- `/tmp/idream-redcraft-krea2-face-only-alexa-rb4-g768-seed486071801727172.png`

当前默认固化为“纯脸 identity anchor + `ref_boost=4 / grounding_px=768`”。`2/512` 是构图自由度更高、身份更松的备选档，不再是默认。

## 工作流证据

运行图同时满足以下约束：

1. 同一张 reference 经 `VAEEncode` 进入 `Krea2EditModelPatch.source_latent`；
2. 原始像素经 `source_image + VAE` 进入 `fit` pixel path；
3. 同一张 reference 同时进入正、负 `Krea2EditGroundedEncode`；
4. `EmptySD3LatentImage` 同时连接 sampler 和 `target_latent`；
5. Identity v1.2 只加载一次，strength `1.0`；
6. smoke 请求携带不可变 `workflowKey@version`，后端只透传描述符声明过的数值控制。

ComfyUI 日志确认 `pixel path ACTIVE`、`STRIDE1-POS fit`，HTTP preflight 检查 `8` 个描述符、`47` 个节点类型、`17` 个模型引用，结果 `0 problem(s)`。

质量样本完成后，活动 8188 被并行的 LTX 2.5 工作切换到 ComfyUI `0.34.2` / PyTorch `2.13.0` 新安装。已将同一 `comfyui-krea2edit` commit 安装到该 runner，并在既有 LTX 队列排空后重启：

- `Krea2EditModelPatch`、`Krea2EditGroundedEncode` 均重新注册；
- 当前 runner 的 1-step 全图兼容性 smoke 成功，ComfyUI 图执行 `74.55 s`；端到端 `813,400 ms` 包含前序 LTX 队列等待；
- 兼容性产物 `/tmp/idream-redcraft-krea2-current-runner-compatibility.png`，SHA-256 `555b72c3b78dfc41b86d54f6c5199dbb2e1a4e0979ec271017e6bb7f31a0af29`；
- 该低步数产物只证明新 runner 能执行完整 Krea 图，不用于画质评分。
- 重启后的全量 HTTP preflight 覆盖 `9` 个描述符、`48` 个节点类型、`21` 个模型引用，结果 `0 problem(s)`。

## Qwen 对照与运行边界

同图、同提示、同种子的 Qwen Rapid-AIO NSFW v19 对照在模型切换后、采样 `0/4` 时退出。日志显示约 `19.5 GB` diffusion、`7.4 GB` text encoder 和 VAE 已加载，随后统一内存压力终止 ComfyUI/PM2；没有产物，不能作为 Qwen 质量结论。

这证明 Krea 与 26.5 GiB Qwen AIO 不应在同一个长期 ComfyUI/MPS 进程里热切换。后续 A/B 应使用隔离 runner，或在排空队列后冷启动单模型 runner。

## 后续资格赛

1. 把批准的人脸近景设为 Character identity anchor；全身/服装图只能作为 look 或 body QA 资产，不能进入这个单图 identity slot；
2. Character appearance 文本必须保存身高、体型、胸腰臀比例、肤色和稳定身体特征；
3. 在隔离 runner 上补 Qwen 固定 A/B；
4. 至少使用 5 个角色、每个角色 4 种场景，分别评分 identity、intent、anatomy、reference leakage 和 latency；
5. 只有固定集总体胜过现有 Qwen 路线后，才移除 `explicitOnly`；Raw fallback 仅用于真正的对象删除，不再用于补偿错误的全身 identity reference。

## 2026-08-29 双 runner 提速复验

- 图片 runner 固定为 `8189 + --use-pytorch-cross-attention`，与 `8188` 的 RedGraft split-attention 视频 runner 隔离；
- 同一 face-only anchor、seed `486071801727172`、`ref_boost=4 / grounding_px=768` 的 8-step Gen backend 复验成功：832×1216，E2E `306,096 ms`，sampler 约 `240 s`；
- 产物 `/tmp/idream-redcraft-krea2-image-runner-8step.png`，SHA-256 `c05631a4e962c1c95601d4105efd655b824e0325bdaa70d89097811251d65482`，像素 sanity 与人工检查通过；
- 连同前一轮 8-step `277.44 s / 243.20 s sampler` 成功样本，工作流 v2 将默认 steps 固化为作者支持的 `8`；`12` 只保留为显式质量覆盖。
