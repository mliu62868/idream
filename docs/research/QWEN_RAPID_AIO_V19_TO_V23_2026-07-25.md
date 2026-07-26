# Qwen Rapid-AIO v19–v23：是否该升级

日期：2026-07-25  
范围：Phr00t `Qwen-Image-Edit-Rapid-AIO` v19–v23、iDream 当前 ComfyUI / Apple MPS 路径。未下载新模型、未做 v19/v23 实图 A/B、未改变任何运行路由。

## 结论

1. **v19 不是“不好”。** Phr00t 结束该系列更新时，明确把 **v19 定位为编辑一致性更好**，把 **v23 定位为提示词遵循更好**。因此它们是取舍，不是 v23 全面淘汰 v19。[作者模型卡（固定提交）](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md)
2. **iDream 暂不应原地升级默认路由。** 当前 v19 BF16 已在本机 MPS 完成真实编辑冒烟，且角色身份保持是 iDream 的关键指标；v23 尚未在本机转换、出图或与 v19 同参比较。应保留 v19 为默认，把 v23 作为“复杂指令 / 提示遵循”显式候选。
3. **升级 v20–v23 不会自然变快。** 五版都是同一量级的 Qwen 20B AIO、约 28.43 GB FP8 文件，并沿用 CFG 1、少步采样。作者没有发布逐版速度 benchmark；主要变化是底模混合比例、加速 LoRA 与皮肤 / 写实 / 其他 LoRA 配方，而不是缩小模型。[v19 文件](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/tree/main/v19)、[v23 文件](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/tree/main/v23)
4. **截至 2026-07-25 没有 v24。** Hugging Face 文件树止于 v23；仓库最后提交是 2026-02-03 的 README 更新。作者也已写明停止常规更新。[完整文件树](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/tree/main)、[提交历史](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/commits/main)

## v19 到底是什么

以下是作者配方说明，不等于官方 Qwen 原始 checkpoint：

- v17 开始混合 `Qwen-Image-Edit-2509` 与 `2511`；
- v18 提高 2511、降低 2509 比例；
- v19 在该混合线上再加入新的 **Qwen Edit 2511 8-step Lightning**，作者仍建议 4–8 steps；
- AIO 单文件还合并了 accelerator、VAE、CLIP 与用途 LoRA；常规加载方式是 `CheckpointLoaderSimple`，全局建议 CFG 1、4 steps；
- 所以 v19 是 **2509/2511 混合 + Lightning / accelerator + VAE / CLIP + 多个 LoRA 的 FP8 AIO**，不是“官方 Qwen-Image-Edit-2511 BF16 的小版本”。

直接来源：[作者 v17–v19 说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L126-L129)、[作者 AIO / 4-step 说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L95-L101)。

这解释了 v19 的两面：

- **优点：** 作者认为它最偏编辑一致性；iDream 本机单图编辑也已验证保持身份。
- **局限：** 混合底模和多 LoRA 使行为不如纯 2511 清晰；复杂指令遵循、几何关系和多人物组合不能只按“含 2511”推断为官方 2511 的完整能力。

## 每版具体变化

| 版本 | 作者写明的变化 | 对 iDream 的实际含义 |
|---|---|---|
| **v19** | 延续 2509/2511 混合，加入 2511 8-step Lightning；NSFW 版加入 GNASS；推荐 `er_sde/beta` 或 `euler_ancestral/beta` | 作者最终认为编辑一致性最佳；适合优先守住角色脸、发型、服装局部编辑。[说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L126-L129) |
| **v20** | 回到 **100% Qwen Edit 2511**；重调 accelerators，少量 BestFaceSwap，调整写实和 NSFW LoRA；推荐 `euler_ancestral/beta` | 血统比 v19 清晰，但作者没有说它全面优于 v19；可作为“纯 2511 Rapid 配方”诊断基线。[说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L130) |
| **v21** | 移除旧写实 LoRA，加入 2511 的 `anything2real`、`anime2real`，明显偏写实；作者提示纯平面 2D 动漫可能更适合 v19/v20 | 不适合当通用升级；风格倾向变强，可能压过角色既定画风。[说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L131) |
| **v22** | 撤掉 v21 两个 LoRA，因为它们会覆盖风格并造成不一致；改加少量 JibMix Skin、qwen-skin-edit v1.1；再次调整 NSFW 权重 | 是对 v21 风格与一致性回退的修复，但仍是中间配方，不值得仅因版本号专门迁移。[说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L132) |
| **v23** | 再调皮肤 / 写实 LoRA，移除会产生异常的 JibMix，降低令写实结果更困难的“plastic” NSFW LoRA；推荐 `euler_ancestral/beta` | 作者最终认为提示词遵循最佳；适合复杂换装、多个属性、空间关系等 intent-heavy 编辑候选，但角色一致性仍需与 v19 实测。[说明](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L133) |

v21 的新增项在 v22 被作者明确撤回、v22 的 JibMix 又在 v23 被撤回，直接说明 v20–v23 是多次配方探索，不是单向质量增长。

## 与官方 Qwen 2511 的关系

官方 `Qwen-Image-Edit-2511` 是 20B、BF16、Apache-2.0 模型；官方示例采用 40 inference steps。官方声明相对 2509 改进 image drift、人物与多人物一致性、内置 LoRA 能力、工业设计和几何推理。[Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)

必须保持两条事实分开：

- **官方事实：** 这些是官方 2511 相对 2509 的能力声明。
- **Rapid-AIO 作者事实：** v20–v23 以 100% 2511 为底线继续混入 accelerator 和用途 LoRA；v23 的 prompt adherence 优势是 Phr00t 的经验判断。
- **未实测边界：** 不能把官方 40-step 2511 的能力和质量无条件外推到 4-step Rapid merge，也不能把作者判断当成本机角色资产 A/B 结果。

## 速度：换新版解决不了当前耗时

Hugging Face 元数据显示，v19–v23 每个 SFW / NSFW 文件都约 `28,431,840,000` bytes，差异只有几 KB；全局 recipe 仍是 CFG 1、4-step 级别。由此可以合理推断：

- 同分辨率、同 steps、同 sampler、同驻留状态下，v20–v23 不应有数量级速度差异；
- 冷启动仍要加载同量级的 AIO 权重，更新版本不会消除这一成本；
- 如果切换 sampler 或 steps，耗时差异来自 recipe 变化，不能归功于版本号；
- 真正的速度变量是模型是否常驻、分辨率、参考图数量、运行时、量化执行路径和更小架构。

这是基于相同架构、文件大小和 recipe 的**未实测推断**；Phr00t 没有给出 v19–v23 同硬件同参数耗时表。[HF API 元数据](https://huggingface.co/api/models/Phr00t/Qwen-Image-Edit-Rapid-AIO)、[作者模型卡](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md)。

## Mac MPS + ComfyUI：FP8 与 BF16 的真实边界

Phr00t 发布的 v19–v23 是约 28.4 GB 的 FP8 AIO。iDream 当前不是直接用该 FP8 文件，而是：

1. 用项目脚本把 plain FP8 数值 widening cast 到 BF16；
2. 得到约 53 GiB 的本地 BF16 AIO；
3. 由 ComfyUI `CheckpointLoaderSimple` 加载，在 MPS 上按 BF16 执行。

本地证据：

- [`dequant_fp8_to_bf16.py`](../../packages/gen/scripts/dequant_fp8_to_bf16.py) 明确把 Rapid-AIO plain FP8 做 `weight.to(bfloat16)`；
- [`qwen-image-edit-img2img.json`](../../packages/gen/workflows/qwen-image-edit-img2img.json) 当前固定 `Qwen-Rapid-AIO-NSFW-v19-bf16.safetensors`、4 steps、CFG 1；
- [`qwen-image-edit-multi-identity.json`](../../packages/gen/workflows/qwen-image-edit-multi-identity.json) 双身份参考同样固定 v19 BF16；
- [`qwen-image-edit-multi-reference.json`](../../packages/gen/workflows/qwen-image-edit-multi-reference.json) 多参考路由也固定 v19 BF16；
- [本机 P0 记录](../superpowers/specs/2026-07-07-image-generation-redesign-design.md#qwen-image-edit-rapid-aio-v19-端到端跑通2026-07-07p0-两模型全部收口) 记录了 v19 FP8 → BF16、MPS t2i 和编辑实图成功。

关键含义：

- 这个 BF16 是 **FP8 已量化数值的 BF16 容器**，不会恢复合并前官方 BF16 的精度；
- 它解决的是当前 MPS / ComfyUI 运行兼容性，同时把存储和驻留成本扩大约一倍；不是速度优化；
- v23 若沿当前生产路径验证，也要先检查文件布局，再转换为独立 BF16 候选；本轮没有下载或验证 v23，不能声称它已可直接替换。

还有一个不能混淆的变量：iDream 上述三个 v19 workflow 当前都是 `sa_solver/beta`，而作者现在对 v19 推荐 `er_sde/beta` 或 `euler_ancestral/beta`。现有 recipe 有本机成功证据，但若当前不满意的是画质或指令完成率，应先做受控 sampler A/B，不能把 recipe 差异全部归因于“v19 版本不好”。[作者 v19 recipe](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md#L129)

## 路由建议

### 现在

- **Auto / 默认：保留 v19。** 它已有本机运行证据，且作者最终仍把它列为编辑一致性优先版本；这更符合角色图片的首要目标。
- **不要把 v20、v21、v22 逐个接入生产。** 没有具体失败要诊断时，这三条中间配方只会增加模型驻留和运营复杂度。
- **新增一个 v23 显式候选，不自动回退或替换。** 仅用于复杂、多约束、空间关系或提示词经常漏执行的编辑。

### 升级门槛

用同一组 identity / source、prompt、seed、尺寸和 4 steps 做 v19 与 v23：

- 先测 `v19 + sa_solver/beta`（当前控制组）与 `v19 + euler_ancestral/beta`（作者 recipe），再用同一 `euler_ancestral/beta` 比 v19 / v23，避免同时换模型和 sampler；
- 冷启动一次、热运行至少三次；
- 记录端到端 wall time、加载时间、峰值统一内存和失败率；
- 分开评分：角色身份、发型 / 面部漂移、复杂指令完成率、画风污染、手部 / 皮肤伪影；
- v23 只有在目标路由的提示完成率明确提高，且身份分不退化到门槛以下时才激活。

若复杂指令仍失败，再增加**官方 Qwen-Image-Edit-2511 40-step** 作为质量基线；它用于判断问题来自 Rapid 蒸馏 / 合并还是 2511 本身，不直接作为低延迟默认。

最终建议不是“升级到 v23”，而是：**v19 守一致性默认，v23 做提示遵循候选；先 A/B，再按任务路由。**
