# Dark Beast 2740209 图生图适配评估

更新时间：2026-07-24

## 结论

Civitai 版本 `2740209` 适合作为 iDream 的**身份保持 / 换脸专用候选模型**，也适合作为 SNOFS 的底模；不适合作为当前 Qwen Image Edit 通用线路的直接替代。

建议保持现状：独立候选、默认关闭、0% 流量。下一阶段先完成真实双参考图和 Qwen 同条件 A/B，再决定是否晋级。若用于商业生产，还需要取得 FLUX.2 Klein 9B 对应的商业许可。

## 精确版本事实

- Civitai 版本：`2740209`
- 版本名：`DBKleinV2🟦BFS`
- 实际架构：FLUX.2 Klein 9B，而不是页面标题容易让人误判的 Krea2
- 类型：完整 Checkpoint，不是 LoRA
- 推荐配方：4–5 steps、CFG 1
- 文件：`darkBeastINT8Convrot2_dbkleinv2BFS.safetensors`
- 文件大小：`9,078,610,848` bytes
- SHA-256：`B20B6F2744E152FD3EFA2638E88A5FEAB478C778EE25C81B183FD80E03A099C3`

本机文件的完整 SHA-256 与 Civitai 精确版本一致。虽然文件名保留了 `INT8Convrot2`，本机 safetensors 头部显示其 201 个张量均为标准 `F8_E4M3`；它不是旧版 ConvRot INT8 执行路径，因此当前 MPS 不会遇到旧模型的 `aten::_int_mm` 阻塞。

## 为什么适合

1. **任务匹配**
   - 模型作者把该版本定位为 face swap / identity preservation。
   - FLUX.2 Klein 9B 原生支持单参考和多参考编辑。
   - 当前 iDream 工作流使用 `VAEEncode` 和链式 `ReferenceLatent`，可以表达 identity anchor、identity reference、source image 三类语义角色。

2. **当前环境已实际跑通**
   - ComfyUI：`0.28.0`
   - PyTorch：`2.10.0`
   - 设备：Apple MPS
   - 实测：832×1216、5 steps、Euler，约 116.5 秒
   - 输出通过图片完整性检查和人工视觉检查

3. **已完成项目侧候选接入**
   - 工作流：`packages/gen/workflows/darkbeast-flux2-klein-9b-multi-reference.json`
   - `modelId`：`darkbeast-flux2-klein-9b-bfs`
   - `workflowKey`：`darkbeast-flux2-klein-9b-multi-reference`
   - 当前发布状态：draft、disabled、0% rollout

## 不应直接替换 Qwen 的原因

1. **能力面更窄**
   - 当前证据支持它做身份、脸部和写实人像编辑。
   - 还没有证据证明它在服装、姿势、构图、场景重写、多身份和复杂指令遵循方面优于 Qwen。

2. **真正的多参考解耦尚未验证**
   - 已完成的“双参考”冒烟中，两张参考图实际字节完全相同。
   - 该次测试证明了运行链路和单参考式质量，但不能证明 identity reference 与 source image 的角色解耦。

3. **Qwen 对照仍不完整**
   - 先前 Qwen 对照在运行中结束，没有留下可用于最终判断的图像、耗时和质量结果。
   - 两条线路的原生配方也不同：Dark Beast 为 5-step Euler，Qwen 为 4-step SA Solver；后续应同时报告“最佳原生配方”与受控变量结果。

4. **生产许可未闭环**
   - 该精确版本继承 FLUX.2 Klein 9B。BFL 官方将 9B 权重列为非商业许可。
   - Civitai 作者页的商业使用选择不能替代上游基础模型许可；用于商业自托管生产前需要另行取得 BFL 商业许可。

## 与 SNOFS 的关系

Dark Beast 更适合作为底模，SNOFS 更适合作为可选的材质 / 风格增强层。

本机同源图、同提示词、同 seed、同 5 steps 的 A/B 显示：

- Dark Beast 单独运行已经能较好保持脸部与发型。
- 加载 SNOFS v1.4、strength 1 后，皮肤和网格材质更强、成片感更重。
- SNOFS 没有改善身份保持或肢体结构，局部手部、腋下和近距离纹理问题仍存在。
- 两次计时受模型驻留和运行顺序影响，不能用来宣称性能提升。

因此建议 Dark Beast 为该候选线路默认底模，SNOFS 默认关闭。若要启用 SNOFS，可先测试 `0.6–0.8` 强度；这个范围目前只是下一轮建议，尚不是本机已验证结论。

## 晋级前的最小验证

1. 使用三张真正不同的图片：
   - 身份锚点
   - 第二身份参考
   - 来源姿势 / 场景图
2. 固定分辨率、seed、提示词和参考图，分别执行：
   - Dark Beast
   - Dark Beast + SNOFS
   - Qwen Image Edit
3. 每条线路完成一次冷启动和至少两次改变 seed 的热运行，分开记录加载与推理耗时。
4. 独立评分：
   - 身份相似度
   - 姿势和场景服从度
   - 手部与局部结构
   - 皮肤与服装纹理
   - 多参考角色串扰
5. 只有在质量、稳定性和许可都通过后，才从 draft 候选晋级；不应静默改写现有 Qwen 生产路由。

## 主要来源

- [Civitai 精确版本 API](https://civitai.com/api/v1/model-versions/2740209)
- [Civitai 模型 API](https://civitai.com/api/v1/models/2242173)
- [Black Forest Labs FLUX.2 官方仓库](https://github.com/black-forest-labs/flux2)
- [Black Forest Labs FLUX.2 Klein 官方页面](https://bfl.ai/models/flux-2-klein)
- [FLUX.2 Klein 9B 官方 Hugging Face 页面](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B)
