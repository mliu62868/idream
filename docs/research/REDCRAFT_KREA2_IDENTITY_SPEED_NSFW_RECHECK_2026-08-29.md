# RedCraft Krea2 Identity Edit：图片提速与 NSFW 链路复核

日期：2026-08-29

范围：iDream 当前 `RedCraft 3.0 Krea2 FP8 + Krea 2 Identity Edit v1.2 full + comfyui-krea2edit v1.2.5`，Apple M4 Max / MPS，图片 runner `127.0.0.1:8189`。

方法：资料结论只使用当前仓库/运行时源码、模型与节点作者资料、Krea/ComfyUI/PyTorch 一手来源；随后用隔离图片进程和 8189 当前进程做单变量真实 A/B。生产 descriptor 与启动配置均未修改。

## 结论

1. **当前主要提速已经生效。** 图片进程独立运行在 8189，使用 `--use-pytorch-cross-attention`；workflow 固定 8 steps、CFG 1，并正确连接 `target_latent`。最近一次真实 832×1216 请求是 305.84 秒，其中 sampler 约 240 秒。它已避开 split attention、12 steps 和 sampling 中途 VAE 驱逐这三个已知大坑。
2. **CFG 1 下第二次负面 grounded conditioning 不参与 denoise，但实跑没有证明删掉它会更快。** `ConditioningZeroOut(positive)` 与原 graph 的同 seed 输出像素完全相同；不过它执行 228.00 秒，同进程热态原 graph 是 218.90 秒。两次缓存姿态不完全对称，因此不能把 9.10 秒差值解释成稳定回归，但也没有依据把这项改动作为提速上线。
3. **当前图还把参考图 VAE 编码了两次。** node 6 先做普通 `VAEEncode`；node 8 的 pixel path 又按目标网格做 `_fit_encode_image(...)->vae.encode`，并在 forward 中覆盖前者的 `src_samples`。从固定源码看，pixel path 活跃时 node 6 的图像 latent 最终不会用于 denoise。这是第二个固定开销候选，但作者 workflow 仍把 `source_latent` 声明为必接，因此应先用固定输入证明“目标空 latent 仅作 required-socket 占位”与现图等价，再考虑生产化，不能直接默认修改。
4. **真正瓶颈是每步 FP8 解码/BF16 计算，不是 SaveImage，也不主要是 attention token 数。** 832×1216 → 768×1152 只把热态 E2E 从 218.90 秒降到 207.09 秒（5.4%），sampler 只降 2.4%。`ref_boost=1` 完全移除 dense attention bias 后是 198.95 秒（9.1%），但脸部锁定略弱，只适合显式 fast/自由编辑档，不能替换身份默认值 4。
5. **RedCraft checkpoint 有成人内容能力，但 Identity LoRA 不是成人 LoRA。** 精确 RedCraft 版本作者写了 `No Mosaics`，版本样图 API 含 `nsfwLevel=16`；Identity Edit 作者则明确说明 v1.2 只用 SFW 数据训练。后者不是过滤器，但也不提供成人编辑质量保证。最终“图片确实为 NSFW 且身份成立”只能靠 iDream 自己的固定参考图实跑和目检证明。
6. **在 Turbo / CFG 1 下，NSFW 意图必须写进正向 instruction。** 当前 negative prompt 在 denoise 中不生效；只写 `NSFW` 或只把 `clothes` 放进 negative 都不足以定义画面。对该 edit workflow，应使用明确的成年人物、构图、裸露程度、姿势、光线和身份保留指令。

## 一、当前运行事实

只读 API 与进程检查确认：

- 8189：ComfyUI `0.34.2`、PyTorch `2.13.0`、device `mps`；
- 启动参数：`--use-pytorch-cross-attention`；
- queue：检查时 `running=0 / pending=0`；
- workflow：`832×1216 / 8 steps / CFG 1 / Euler / Simple / LoRA 1 / ref_boost 4 / grounding_px 768`；
- 最近 prompt `84df00a2-5cfb-49aa-8aaf-a1dec90d7367`：305.84 秒，成功；
- 日志确认 `Krea2TEModel_` 8,464.46 MB 完整加载、VAE 242.03 MB 完整加载、Krea2 12,532.86 MB 完整加载；RedCraft FP8 位于 `emulated ops`，实际报告 `torch.bfloat16 / manual cast torch.bfloat16`；
- 日志确认 pixel good path：`pre-encoding sources at target 1216x832px`；
- 768×768 方形参考在 832×1216 输出中得到 reference grid `52×52`，target grid `76×52`；8 个 denoise step 均走该组合序列。

当前权威 graph：[`packages/gen/workflows/redcraft-krea2-identity-edit.json`](../../packages/gen/workflows/redcraft-krea2-identity-edit.json)。此前完整参数与 Mac 基线见 [`REDCRAFT_KREA2_OFFICIAL_PARAMETERS_AND_MAC_PERFORMANCE_2026-08-28.md`](./REDCRAFT_KREA2_OFFICIAL_PARAMETERS_AND_MAC_PERFORMANCE_2026-08-28.md)。

### 2026-08-29 真实 NSFW 单变量 A/B

固定输入：同一张 AI 成年女性脸部 reference、同一正向成年裸体 instruction、seed `486071801727172`、8 steps、CFG 1、Euler/Simple、grounding 768。除表中变量外保持一致；全部输出通过尺寸/像素 sanity 和人工目检，均为单一成年 NSFW 人物，无明显肢体错误。

| 运行 | 唯一变量 | E2E | sampler | 相对热态默认 | 结论 |
|---|---|---:|---:|---:|---|
| 冷基线 | 当前生产 graph，进程首跑 | 305.84s | 240.56s | 不可与热态直接比 | 当前冷启动事实 |
| Tier-A kernel 组合 | MPS TE + fused RMSNorm + fused RoPE | 312.68s | 253.68s | 冷态也更慢 | 回归；且触发 Gen 300s timeout，不采用 |
| A1 | negative -> `ConditioningZeroOut(positive)` | 228.00s | 180.88s | +4.2% E2E / -2.3% sampler | 缓存姿态不对称；无提速证据 |
| A0 warm | 原 graph，832×1216，ref boost 4 | 218.90s | 185.20s | 基准 | 热服务基线 |
| A3 | 768×1152 | 207.09s | 180.72s | -5.4% E2E / -2.4% sampler | 画质可用，但收益偏小 |
| A5 | 832×1216，ref boost 1 | 198.95s | 171.52s | -9.1% E2E / -7.4% sampler | NSFW/结构通过；脸部锁定略弱 |

A1 与 A0 warm 的 PNG 文件 SHA 不同是 metadata 差异；解码后的 RGB 像素 `RMSE=0`、`max_abs=0`。Tier-A kernel 输出视觉可用，但与默认路径 `RMSE=6.239/255`，且性能更差。

关键运行标识：

- Tier-A prompt `ea344edb-dbf1-433e-a306-38f7c0b45e0c`；
- A1 prompt `4d7f745e-43a0-4e21-b619-05f5c8f30873`；
- A0 warm prompt `e492814d-757b-4355-ba23-b071c76ecf5a`；
- A3 prompt `bc21cfd1-6767-4b15-a79f-2a4b93851c5d`；
- A5 prompt `0e505c6d-3a28-40bf-9086-4d40a28b8921`。

成年 NSFW 输出：

- `/Users/kk/ComfyUI-Shared/runners/image/output/idream_redcraft_krea2_nsfw_a0_warm_00001_.png`，SHA-256 `c840f9a5ecef4037292208df35c751bc090a494c41545550992797c4aad3c9f3`；
- `/Users/kk/ComfyUI-Shared/runners/image/output/idream_redcraft_krea2_nsfw_a3_768x1152_00001_.png`，SHA-256 `76fa39a79bf759226d349f464f465343fbdabd1db2ac5c4b0ae53325a84b525b`；
- `/Users/kk/ComfyUI-Shared/runners/image/output/idream_redcraft_krea2_nsfw_refboost1_00001_.png`，SHA-256 `f4c183a198ff9dcc8fe650e99efc2bf425adfa66c714d9681f603972595139d9`。

PyTorch 官方 MPS 环境变量也做了独立进程、Krea2 代表形状 `6656×6144 @ 6144×6144` 的 BF16 matmul micro-benchmark：默认 `33.010ms`，`PYTORCH_MPS_PREFER_METAL=1` 为 `365.134ms`（约慢 11 倍），`PYTORCH_MPS_FAST_MATH=1` 为 `33.021ms`（无可测收益）。两项均不进入完整生成或启动配置。

## 二、CFG-1 negative conditioning：像素等价，但没有提速证据

### 证据链

当前 node 10 是第二个 `Krea2EditGroundedEncode`，接同一张参考图；产品负面词会绑定到它。它不是普通字符串节点，而是让 CPU 上的 4B Qwen3-VL 再处理一次图像和 prompt。

但三个一手事实闭合：

1. 当前 KSampler 的 CFG 固定为 `1.0`，descriptor 没有暴露 CFG override；
2. 插件作者明确写的是 **“At CFG > 1, ground the negative too”**，example workflow 注释也写 negative **“only used at CFG > 1”**；
3. 当前 ComfyUI `sampling_function` 在 `cond_scale == 1` 且模型未禁用该优化时，直接执行 `uncond_ = None`。`comfyui-krea2edit` 没有设置 `disable_cfg1_optimization`。

来源：

- [`comfyui-krea2edit` README usage notes](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#usage-notes)
- [作者 example workflow 的 negative / CFG 注释](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/workflows/krea2_identity_edit.json)
- [ComfyUI 当前版本的 CFG-1 uncond skip](https://github.com/Comfy-Org/ComfyUI/blob/c645560264062e6a5b0688d25eaf3ee9906a7709/comfy/samplers.py#L609-L627)
- 本机同一源码：`/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/samplers.py:609`

### 候选 graph

```text
node 9  Krea2EditGroundedEncode(positive prompt + reference)
  ├─> KSampler.positive
  └─> ConditioningZeroOut -> KSampler.negative
```

这与 RedCraft 作者 T2I 样图使用 `ConditioningZeroOut(positive)` 的做法一致。严格边界是：**只适用于当前 Turbo / CFG 1 descriptor**。如果以后做 Raw / CFG 3，必须另建 graph 并恢复同图的 grounded negative，不能复用这个优化。

预期收益只来自 fixed overhead，不会缩短 8 次 DiT forward。真实 A/B 证明输出 RGB 像素完全一致，但没有得到净提速：A1 为 228.00 秒，同进程热态原 graph 为 218.90 秒。由于原 graph 的 positive/negative conditioning 更充分命中缓存，这不是严格的回归定论；但已足以否定“无需再测即可作为 P0 提速上线”。它最多是 CFG-1 graph 清理项。

验收：相同 prompt、seed、reference、尺寸、steps、`ref_boost`、`grounding_px`；比较 sampler/E2E、输出尺寸、像素 sanity、身份和 NSFW instruction adherence。源码上正向 sampling 输入等价，但 MPS 跨次执行不应仅以文件 SHA 作为质量判据。

## 三、P0/P1：避免 pixel path 下重复 VAE encode

当前 graph 同时存在：

```text
LoadImage -> VAEEncode -> node 8.source_latent
LoadImage -> node 8.source_image + VAE + target_latent
```

固定插件源码先读取 `source_latent`，随后在 pixel path 活跃时调用 `_fit_encode_image(...)->vae.encode`，并用得到的 `lat` 覆盖 `src_samples`：

- [`patch()` 的 required latent 与 pre-encode](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L288-L328)
- [forward 中 pixel path 覆盖 `src`](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L336-L373)
- 本机源码：`/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/comfyui-krea2edit/__init__.py:288`

所以当前 768×768 source 先被普通 VAEEncode 一次，又被 pixel path 以 fitted 832×832 编码一次。后者才是采样使用的 reference。

可验证候选是：保持 `vae + source_image + target_latent` 完全不变，让 required `source_latent` 暂接 node 7 的空目标 latent，仅作为不会被采用的类型正确占位，删除 node 6 的图像 VAEEncode。这个行为来自源码推导，不是作者公开保证，必须先做 graph validation 和一次等输入输出对照；更干净的长期解法是上游节点允许 pixel path 下 `source_latent` optional，而不是在 iDream 私改第三方插件。

## 四、P1：真正影响 8 步 sampler 的变量

### 1. 输出分辨率

Krea2 edit forward 的序列是 `[text | source | target]`，28 个 block 都处理组合序列；dense attention 的 pair 工作近似随总 token 数平方增长。[插件 forward 源码](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L172-L249)

按当前 768×768 方形 reference 和实际日志 grid 估算：

| 输出 | target grid | square-ref grid | image tokens 合计 | 相对当前 image-token pairs | 输出像素变化 |
|---|---:|---:|---:|---:|---:|
| 832×1216（当前） | 52×76 = 3,952 | 52×52 = 2,704 | 6,656 | 100% | 100% |
| 768×1152 | 48×72 = 3,456 | 48×48 = 2,304 | 5,760 | 74.9% | 87.5% |
| 704×1024 | 44×64 = 2,816 | 44×44 = 1,936 | 4,752 | 51.0% | 71.3% |

这是只针对 image token 的理论量，不含 text token、MLP、VAE、load/offload，因此不能直接当作端到端加速百分比。第一档应只测 **768×1152**；它与现有视频/产品竖图尺寸一致，像素只少 12.5%，比直接砍到 704×1024 风险小。

作者允许 Turbo 在 1K–2K 工作，Identity Edit 要求 `≤2MP`；低于 2MP 没有最低分辨率质量承诺。[Krea 2 官方 Turbo 用法](https://github.com/krea-ai/krea-2#turbo-oss_turbo)、[Identity Edit 推荐设置](https://huggingface.co/conradlocke/krea2-identity-edit/raw/main/README.md)

### 2. `ref_boost`

源码仅在 `ref_boost != 1` 时构建完整 `[1,1,L,L]` additive attention bias，并把 mask 交给每个 block 的 attention。设为 `1` 会完全移除该 bias/masked path；`2` 仍有 mask，但对参考 prior 的拉力低于当前 `4`。[`_ref_attn_bias` 与 forward](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L139-L249)

作者结论是 `4` 为强脸/身体 likeness 起点，`<1` 更自由，`>10` 会破坏删除/替换。对于“参考图有衣服、输出要求成人裸露”的编辑，高 `ref_boost` 可能同时拉回参考服装/构图；所以 NSFW A/B 可测 `4 -> 2 -> 1`，但不能未测就把全局默认改成 1。[Identity Edit 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit/raw/main/README.md#recommended-settings)

### 3. reference 几何

`fit` 对宽高比差异较大的 source 使用 native fitted grid，而不是一律扩成 target grid。当前方形脸部 reference 因此是 `52×52`，明显少于竖图 target 的 `76×52`。若换成与输出同宽高比的全身 reference，source token 会升到接近 target，attention 成本也会上升。

因此要把“脸部身份快路径”和“全身/身体特征保持路径”分开评价：方形脸/上半身 anchor 更快；竖幅全身 anchor 更有身体信息但更慢。不能为了 benchmark 把两类 reference 混为同一 workload。

## 五、P1/P2：固定开销与 Mac 环境旋钮

### `grounding_px=512`

作者训练范围是 384–768，并明确说明低值更服从编辑、高值更保 identity。把当前 768 降到 512，送入 Qwen3-VL 的图像像素面积约变为 44.4%；它能减少 positive grounded encode 的固定成本，并可能帮助显著场景/服装变化，但不会按该比例缩短 8 次 DiT forward。[节点作者说明](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#krea2editgroundedencode)

对 NSFW edit，建议先测 512，再测 640；保留 768 作为 likeness 上限基线。

### `PYTORCH_MPS_PREFER_METAL=1`

当前 image launcher 未设置它。PyTorch 官方说明该变量让 matmul 使用 Metal kernels 而不是 MPS Graph API；12.9B DiT 有大量 matmul，因此值得在隔离图片进程做固定输入 A/B，但官方没有承诺 Krea2 会更快。[PyTorch MPS 环境变量](https://docs.pytorch.org/docs/stable/mps_environment_variables.html)

`PYTORCH_MPS_FAST_MATH=1` 可作为其后的独立 A/B。它明确启用 Metal fast math，必须做脸部、皮肤、手指、颜色和 NaN/黑图回归；不能和 `PREFER_METAL` 同时首次启用。

### warm/cold 必须分开

当前 305.84 秒包含 Qwen、VAE、LoRA/UNet 的冷加载与准备。下一次同 runner、不调用 `/free` 的请求才是 warm 服务延迟。任何比较都必须分别记录：

- cold E2E；
- warm E2E；
- sampler；
- Qwen grounded encode；
- source VAE encode / final VAE decode；
- SaveImage。

低秩 Identity LoRA r128/r64 是作者提供的冷加载/显存候选，作者称保留 >99% 权重能量且近似质量；但用户指定的是 v1.2 **full**，且 LoRA 完整物化后不会降低 8 次 DiT 的层数，所以本轮不建议替换。[Identity Edit 模型卡低显存变体](https://huggingface.co/conradlocke/krea2-identity-edit/raw/main/README.md)

## 六、preview / VAE / save 为什么不是主线

- ComfyUI 当前 CLI 的默认 `--preview-method` 是 `none`；image launcher 也没有打开 preview，所以不存在每一步 TAESD/latent preview 解码。[ComfyUI `cli_args.py`](https://github.com/Comfy-Org/ComfyUI/blob/c645560264062e6a5b0688d25eaf3ee9906a7709/comfy/cli_args.py#L135)
- 当前 graph 只有一次最终 `VAEDecode`，交付像素图必需；没有 tiled decode、第二次 decode、upscaler 或 detailer。
- `SaveImage` 只在末尾把一个 batch=1 图像写成 PNG，compress level 4；`PreviewImage` 也会写 PNG，只是到 temp 且 compress level 1，不适合作为产品持久交付替代。[ComfyUI Save/Preview source](https://github.com/Comfy-Org/ComfyUI/blob/c645560264062e6a5b0688d25eaf3ee9906a7709/nodes.py#L1659-L1728)
- 如果后续分段计时证明 PNG 超过数秒，可以单测 compression 1/WebP 交付链；在 240 秒 sampler 面前，不应先为它增加自定义节点。

## 七、NSFW 能力链：五层不要混淆

| 层 | 当前事实 | 对“最终一定是 NSFW”的含义 |
|---|---|---|
| RedCraft checkpoint | 精确版本 `3139241` 作者写 `No Mosaics`，推荐 8–12 steps/CFG1；版本 API 的 10 张样图含 2 张 `nsfwLevel=16` | 有成人/无遮挡 prior，但不保证每个 prompt 都成功 |
| Identity Edit v1.2 full LoRA | 身份/编辑 LoRA，作者明确只用 SFW 数据训练 | 不是成人概念来源，也不是运行时过滤器；成人身份编辑质量必须自测 |
| `comfyui-krea2edit` workflow | 双条件注入，没有 safety/classifier 节点；当前 graph 13 个节点只有 loader/encode/patch/sample/decode/save | workflow 本身不删除 NSFW 词，也不做输出替换 |
| prompt / negative | 正向 prompt 进入 grounded Qwen3-VL；CFG1 下 negative 不参与 denoise | 成人内容、构图和裸露程度必须写在正向 instruction；negative 不能代替 |
| iDream moderation | Gen 当前 `GEN_MODERATION_PROVIDER=mock`；input gate 检查 prompt+negative，只拦 `underage/minor/csam`；生成后做像素 sanity/持久化，没有在该函数里做 NSFW image classifier | 成年 NSFW 请求会传给模型；这层不负责让结果“更成人” |

一手/本地来源：

- [RedCraft version `3139241` API](https://civitai.red/api/v1/model-versions/3139241)
- [Identity Edit 模型卡的 SFW training scope](https://huggingface.co/conradlocke/krea2-identity-edit/raw/main/README.md#scope-and-responsible-use)
- [`packages/gen/src/providers.ts`](../../packages/gen/src/providers.ts) 的 mock blocked terms
- [`packages/gen/src/pipeline.ts`](../../packages/gen/src/pipeline.ts) 的 input moderation 与 artifact sanity/persistence
- [`packages/main/src/server/modules/ourdream/generation-prompt.ts`](../../packages/main/src/server/modules/ourdream/generation-prompt.ts) 的通用 portrait prompt compiler

### NSFW 实跑 prompt 形状

Krea 官方建议自然语言、具体、较详细的 prompt；Identity Edit 作者要求 plain-language edit instruction。[Krea 官方 prompting guide](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)、[Identity Edit 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit/raw/main/README.md)

下一次受控验证应使用 AI 生成的成年 reference，正向 instruction 形如：

```text
Preserve the exact face, hairstyle, eye color, skin tone, and recognizable identity
of this fictional 25-year-old adult woman. Restage her as a tasteful explicit nude
boudoir photograph, one adult subject, full body visible, reclining naturally on dark
satin bedding, anatomically coherent hands and limbs, realistic skin texture, warm
cinematic side light, intimate high-end editorial photography, no clothing, no text.
```

这不是“通用最佳 prompt”，而是用来同时验证三件事的受控样本：RedCraft 成人 prior、Identity LoRA 的脸部保持、以及显著衣着/构图变化的 instruction adherence。不能拿 SFW 头像成功替代这层证据。

## 八、建议的单变量执行顺序

| 顺序 | 唯一变量 | 目的 | 通过条件 |
|---:|---|---|---|
| A0 | 当前 graph + 上述成年 NSFW instruction | 建立成人基线 | 确为 NSFW、单成人、脸部可识别、无明显肢体错误 |
| A1 | grounded negative -> `ConditioningZeroOut(positive)` | 去掉无效 Qwen3-VL encode | 质量不退，E2E 降；sampler 应基本不变 |
| A2 | 删除重复 source `VAEEncode`，required socket 用空 latent 占位 | 去掉第二次 source VAE encode | pixel/identity/NSFW 不退，pre-encode good-path 仍存在 |
| A3 | 832×1216 -> 768×1152 | 降低每步 token 成本 | sampler 明显下降，脸/手/皮肤仍可用 |
| A4 | `grounding_px` 768 -> 512 | 降固定 encoder 成本、提高 edit adherence | 成人指令更稳，identity 可接受 |
| A5 | `ref_boost` 4 -> 2；必要时再 1 | 测 masked attention 与 reference-prior 冲突 | 身份不越过阈值，成人变化更服从 |
| A6 | 仅 `PYTORCH_MPS_PREFER_METAL=1` | 测官方 Metal matmul 路径 | 同质量，cold/warm sampler 均不退 |
| A7 | 仅 `PYTORCH_MPS_FAST_MATH=1` | 测数值近似换吞吐 | 无 NaN/黑图/肤色漂移，质量集通过 |

本轮已经执行 A0/A1/A3/A5/A6/A7 中能直接隔离的项目。最终排序：

1. 保持当前生产默认 `832×1216 / ref_boost 4 / grounding 768 / 8 steps`，因为它的身份锁定最好；
2. 若产品需要显式“成人大幅改装 / 更自由”快速档，可继续扩样验证 `ref_boost=1`：本轮快 9.1%，但身份略弱；
3. `768×1152` 只快 5.4%，不足以直接替换默认分辨率；
4. A1 只保留为 graph 清理候选，不把它宣传成提速；
5. MPS TE + fused RMSNorm/RoPE、`PYTORCH_MPS_PREFER_METAL=1`、`PYTORCH_MPS_FAST_MATH=1` 均不采用；
6. 下一轮如继续投入，优先验证 A2 重复 VAE encode 和 A4 grounding 512 的固定开销；真正的大幅 sampler 提升仍需避免 M4 上每层每步 FP8->BF16 解码，例如离线 merged BF16 模型的独立 A/B，不能靠环境变量假装 native FP8。

## 来源索引

- [Krea 2 官方仓库与 Turbo 参数](https://github.com/krea-ai/krea-2)
- [Krea 2 官方 prompting guide](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md)
- [PyTorch MPS environment variables](https://docs.pytorch.org/docs/stable/mps_environment_variables.html)
- [ComfyUI current source `c645560`](https://github.com/Comfy-Org/ComfyUI/tree/c645560264062e6a5b0688d25eaf3ee9906a7709)
- [RedCraft version `3139241` API](https://civitai.red/api/v1/model-versions/3139241)
- [Identity Edit v1.2 model card](https://huggingface.co/conradlocke/krea2-identity-edit/raw/main/README.md)
- [`comfyui-krea2edit` pinned source `bdfa8b2`](https://github.com/lbouaraba/comfyui-krea2edit/tree/bdfa8b267fdb13730868d435b277dcfe696ec083)
