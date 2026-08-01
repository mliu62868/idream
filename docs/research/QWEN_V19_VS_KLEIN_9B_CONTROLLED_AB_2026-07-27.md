# Qwen Rapid-AIO v19 与 Dark Beast Klein 9B 受控 A/B（identity + source 编辑）

日期：2026-07-27
范围：本机 ComfyUI `0.28.0` / PyTorch `2.10.0` / Apple MPS / 137 GiB unified memory。14 次真实生成，全部 `success`。
这是 [`QWEN_IMAGE_EDIT_VS_FLUX2_KLEIN_2026-07-25.md`](./QWEN_IMAGE_EDIT_VS_FLUX2_KLEIN_2026-07-25.md) 里一直缺的那次受控 A/B。

产物：[`output/model-ab/qwen-vs-klein-2026-07-27/`](../../output/model-ab/qwen-vs-klein-2026-07-27/)（14 张原图、`results.jsonl`、`review.html` 盲评页、`ab_run.py` 驱动脚本）。

## 结论

1. **两条线路都没有完成 identity + source 解耦编辑，但失败方向不同。** 之前没人发现，是因为唯一那次双参考冒烟用了两张字节相同的图 —— 相同输入让任何角色错配都不可见。
2. **Qwen v19 把 identity 图当服装参考，不换脸。** 输出保留 source 的人、五官、发色、室内场景，只把 identity 图的白比基尼搬过来。换 sampler（`sa_solver/beta` → `euler_ancestral/beta`）不改变这个行为。
3. **Klein 9B 的两个 reference 槽位没有语义区分。** 输出是「identity 图的场景 + source 图的脸」。把两个 `LoadImage` 的输入对调后（lane D），输出与未对调时基本一致 —— 说明 descriptor 声明的 `identity_image` / `source_image` 角色在该 graph 中**不产生任何效果**。
4. **速度上三条线路热跑接近，冷启差 2.5 倍。** Klein 冷启 `138.44s` vs Qwen 冷启 `352.58s`（9 GB vs 53 GiB checkpoint）；热跑 Qwen 132.4s / Klein 129.4s。Klein 热跑方差极小。
5. **两条受影响的线路都是 `enabled: true` / `rolloutPercent: 100` / `status: "active"`**，不是 draft 候选。

## 方法

固定全部变量，只变模型与采样配方：

| 变量 | 取值 |
|---|---|
| identity 图 | `ref-0.png`（800×999，金发、蓝眼、游艇、白比基尼、全身站姿） |
| source 图 | `idream-edit-src.png`（832×1216，红棕发、绿眼、室内、上半身特写） |
| prompt | 「把第二张图里的女人换成第一张图里的女人，保留她的脸、金发与发型；保留第二张图的姿势、取景、室内光线与背景」 |
| 输出 | 832×1216，单候选 |
| seed | 42 / 43 / 44 / 45（固定序列，跨 lane 复用） |

两张素材是**真正不同的人和场景**，identity 与 source 强冲突 —— 这正是上次冒烟用相同字节图所回避掉的检验。

| lane | 模型 | 配方 | 次数 |
|---|---|---|---|
| A | Qwen-Rapid-AIO-NSFW-v19-bf16 | 4 steps, `sa_solver/beta`, CFG 1 | 4（1 冷 + 3 热） |
| B | 同上 | 4 steps, `euler_ancestral/beta`, CFG 1 | 4（全热，与 A 共用已驻留 checkpoint） |
| C | darkBeastINT8Convrot2_dbkleinv2BFS | 5 steps, `euler` + Flux2Scheduler, CFG 1 | 4（1 冷 + 3 热） |
| D | 同 C，但两个 `LoadImage` 输入对调 | 同 C | 2（全热） |

`thermal` 按 **checkpoint 是否需要重新加载**标注，不按「lane 的第一次」标注 —— A 与 B 共用 Qwen 权重，B 从不付加载成本，机械标 cold 会虚报一个不存在的冷启。

驱动脚本直接打 ComfyUI `/prompt`，绕开 provider 抽象，确保喂进 graph 的就是上表的值。喂法与生产 `bindReferenceImageSlots` 的 `referenceRoles` 绑定等价（identity → 第一个 `LoadImage`，source → 第二个）。

**踩坑：** shell 里 `NO_PROXY` 被写成 URL（`http://127.0.0.1:7897`）而不是主机列表，导致 urllib 把发往本机 8188 的 POST 也丢给代理，返回 502 空响应体。脚本内用空 `ProxyHandler` 固定住。任何新写的本机 ComfyUI 客户端都会踩这个。

## 速度实测

| lane | 冷启 | 热跑 | 热跑均值 |
|---|---|---|---|
| A · Qwen `sa_solver` | **352.58s** | 120.38 / 132.38 / 144.44 | 132.4s |
| B · Qwen `euler_ancestral` | —（共用驻留权重） | 141.28 / 138.26 / 135.28 / 135.41 | 137.6s |
| C · Klein 9B | **138.44s** | 129.42 / 129.36 / 129.42 | 129.4s |
| D · Klein 9B（对调） | — | 114.32 / 129.41 | 121.9s |

可以说的：

- **冷启差距是真实且巨大的**：Qwen 要装 53 GiB BF16 AIO，Klein 只装 9 GB。切模型的代价完全不对称。
- **热跑三条线路差距很小**（129–138s，约 6%），换 sampler 带来的差异（132.4 → 137.6）和换模型带来的差异（132.4 → 129.4）在同一量级。**「换 Klein 9B 会更快」在热态下不成立。**
- Klein 热跑方差近乎为零（129.42 / 129.36 / 129.42），Qwen A 在 120–144s 之间摆动。对需要稳定 p95 的场景这是个真实优势。

不能说的：样本量是每 lane 3–4 次，不足以给 p95；未测官方 Klein 4B distilled；未控制机器上的其他负载。

## 质量实测

### Qwen v19：不换脸，只搬服装

`A_0`–`A_3`、`B_0`–`B_3` 全部呈现同一模式：输出里的人是 **source 图那个人**（同一张脸、绿眼、红棕发），场景、构图、光线也来自 source；从 identity 图迁移过来的只有**白比基尼**，以及被略微提亮的发色。

也就是说 Qwen 把 identity 图理解成了「服装 / 风格参考」，而不是「身份来源」。`euler_ancestral/beta`（作者对 v19 的推荐 recipe）与当前生产的 `sa_solver/beta` 在这一点上**没有差别** —— 这条至少排除了「sampler 选错导致不换脸」的假设。

### Klein 9B：槽位无语义区分

`C_0` / `C_1` 呈现相反的混合：**游艇场景、栏杆、海面、站姿、手放腰**全部来自 identity 图，而**脸、绿眼、红棕发**来自 source 图，identity 图的白比基尼则被脱掉（裸露状态跟随 source）。跨 seed 稳定复现。

关键验证在 lane D：把两个 `LoadImage` 的输入对调后重跑，`D_0` / `D_1` 与 `C_0` / `C_1` **基本一致**。

这否定了「槽位接反了」这个较轻的解释，留下较重的那个：**在这个 graph 里两个 reference 是对称的，谁进哪个节点不影响结果**。模型按图像内容自行分配角色（大构图取自全身图、面部特征取自特写图），descriptor 里的 `identity_image` / `source_image` 声明是空头支票。

根因在图结构：两张图都只经 `VAEEncode` → `ReferenceLatent` 链式追加进 conditioning，latent 走的是 `EmptyFlux2LatentImage`（空 latent）。source 图从未作为 init latent 参与去噪，因此它在模型眼里和 identity 图地位完全相同。要真正区分，graph 本身要改（让 source 走 init latent，或给两条 reference 不同权重），不是改一行绑定能解决的。

## 影响范围

| profileKey | workflowKey | 状态 | 本次是否覆盖 |
|---|---|---|---|
| `character-image-variation` | `qwen-image-edit-multi-reference` | enabled / 100% / active，**自动路由** | 是 → 不换脸 |
| `character-image-variation-darkbeast` | `darkbeast-flux2-klein-9b-multi-reference` | enabled / 100% / active，`explicitOnly`，surface `generator_image_edit` | 是 → 槽位无语义 |
| `chat-image-edit` | `qwen-image-edit-img2img` | enabled / 100% / active | **否**（单图路径，本次未测） |

两条被证伪的线路都不是 draft。Dark Beast 那条虽然 `explicitOnly`（不进自动路由），但用户在 generator 的 image-edit 界面显式选「Dark Beast · Identity Focus」就会走到它，且它的 `dryRunSummary` 记录的正是 `sampleCount: 1`、2026-07-19 那次相同字节双参考冒烟 —— 那次冒烟的 `p95LatencyMs: 116_500` 也因此不能代表真实双参考场景。

## 这次实验不能声称的

- **prompt 是本次自拟的，不是生产模板。** 仓库里没有找到对应的 identity+source 编辑 prompt 模板（唯一相近的是 `creative.ts` 的 `scenePrompt`）。Qwen 的不换脸行为有可能随 prompt 表述改变；Klein 的槽位对称性则与 prompt 无关（lane D 已隔离）。
- **只用了一对素材。** 结论对「全身+特写」这一组合成立，未验证其他构图组合。
- **未做多人盲评。** `review.html` 已生成（14 张、lane 标签默认隐藏、四个维度 0–5 分、可导出 JSON），但目前只有我单人目视判读。
- **未测官方 Klein 4B distilled**，它仍是 [`QWEN_IMAGE_EDIT_VS_FLUX2_KLEIN_2026-07-25.md`](./QWEN_IMAGE_EDIT_VS_FLUX2_KLEIN_2026-07-25.md) 里的首选速度候选。

## 建议

1. **先修 Klein 的 graph，或把 `character-image-variation-darkbeast` 降级。** 现状是它对外宣称 identity+source 语义，实际不具备。两个选项：重做 graph（source 走 init latent / 差异化 reference 权重）后重测，或在修好前把它从 `generator_image_edit` 的可选项里摘掉。**不建议保持现状** —— 用户选它得到的是不可预期的混合。
2. **Qwen 那条先试 prompt，再谈换模型。** 不换脸是当前最影响产品的行为，而 sampler 已被排除。下一步成本最低的是拿 Qwen 官方 2511 的指代写法重测同一素材，判断是 prompt 表述问题还是 Rapid-AIO 4-step 蒸馏丢了身份迁移能力。
3. **把「两张参考图必须真正不同」写进冒烟的准入条件。** 这次能发现问题，唯一的原因就是换掉了相同字节的素材。
4. **`character-image-variation` 是 100% 自动路由**，在上面两件事有结论前不要再往它上面叠新功能。

## 复现

```bash
python3 output/model-ab/qwen-vs-klein-2026-07-27/ab_run.py \
  --lanes A:0,B:0,C:0,D:0 --runs 4 \
  --outdir output/model-ab/<新目录>
open output/model-ab/<新目录>/review.html
```
