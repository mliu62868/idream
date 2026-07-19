# Dark Beast DBKleinV2 BFS 多参考图能力核验

核验日期：2026-07-19
目标：Civitai `modelVersionId=2740209`

## 结论

**支持。** 精确版本 `2740209` 是 `DBKleinV2🟦BFS`，底模是 **FLUX.2 [klein] 9B**，不是 URL 标题看起来像的 Krea 2 版本。FLUX.2 Klein 9B 原生支持单图和多参考图编辑；BFL 给 Klein 的公开上限是 **4 张参考图**。

这是模型架构原生的 reference-latent 能力，但必须使用 image-edit / multi-reference 工作流。仅把 checkpoint 放进普通 txt2img 工作流，不会自动获得参考图输入。

## 证据

1. [Civitai 版本 API](https://civitai.com/api/v1/model-versions/2740209) 返回：
   - `name: DBKleinV2🟦BFS`
   - `baseModel: Flux.2 Klein 9B`
   - 主文件：`darkBeastINT8Convrot2_dbkleinv2BFS.safetensors`
   - 作者说明其用法与 BFL 官方 FLUX.2 Klein 9B accelerated release 相同。

2. [BFL 官方 FLUX.2 仓库](https://github.com/black-forest-labs/flux2)在模型矩阵中把普通 `FLUX.2 [klein] 9B` 的 `Image Editing (Multi-reference)` 标为支持，并将 Klein 定义为文生图、图像编辑、多参考统一架构。官方推理代码的 `input_images` 是列表，并逐张编码后把所有 reference tokens 拼入模型条件；这不是外接 IPAdapter/Redux/ControlNet 才获得的能力。

3. [BFL 官方模型说明](https://docs.bfl.ai/flux_2/flux2_overview)将 Klein 的 multi-reference 上限列为 4 张。普通 9B 已支持；`9B KV` 的区别是为多参考编辑增加 KV-cache 加速，而不是才开始支持多参考。

4. 作者关联的 [Civitai 工作流版本 `2740453`](https://civitai.com/api/v1/model-versions/2740453) 提供 `Klein9b-BFS-20260303.json`。下载并核对 SHA-256 为 `5A4C0913A042E934D947EF10872AD6C2A655E2CA587692C87FADDCDDBF504E1C` 的归档后可见：
   - 两条 reference conditioning 路径；
   - 每张图均经 `VAEEncode`；
   - 两个内置 `ReferenceLatent` 将参考 latent 串入同一 conditioning；
   - 未使用 IPAdapter、Redux 或 ControlNet 来承载这两张参考图。

   该配套工作流还包含额外 LoRA 和 SeedVR2 放大节点；它们服务于作者的换脸/后处理方案，不是 FLUX.2 多参考输入的必要机制。

5. [ComfyUI 内置 `ReferenceLatent` 源码](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_edit_model.py)明确说明：模型支持时可以串联多个节点设置多张参考图；实现上以 `append=True` 追加到 `reference_latents`。这与配套工作流的结构一致。[ComfyUI 官方 Klein 指南](https://docs.comfy.org/tutorials/flux/flux-2-klein)也分别提供 9B txt2img 与 image-edit 工作流，并要求使用匹配的 Qwen 8B 文本编码器、FLUX.2 VAE 和足够新的 ComfyUI。

## 使用边界

- **模型能力：是。** 可以用人物、服装、姿势/场景等多张图做组合式编辑/生成。
- **工作流能力：有条件。** 每张参考图应走 `LoadImage → VAEEncode → ReferenceLatent`，并把多个 `ReferenceLatent` 串在同一 conditioning 链上。
- **不是传统 denoise 型 img2img。** 这里是 FLUX.2 的 reference-conditioned editing；不要用旧 SD img2img 参数模型来理解。
- **INT8 ConvRot 只改变运行格式，不取消多参考架构能力。** 但能否实际运行仍取决于匹配的量化 loader、kernel、ComfyUI 版本和硬件；多一张参考图也会增加显存占用。
- **质量需实测。** “架构支持”已经确认；社区 aggressive 微调及量化后的身份一致性、参考遵从度，仍需用实际素材做 A/B 验证。

## URL 歧义

同一 Civitai 模型容器后来也包含真正的 Krea 2 版本，例如 `modelVersionId=3091496`。因此不能依据页面 slug 或模型容器标题判断底模；本结论只对应用户链接明确选中的 `2740209`。
