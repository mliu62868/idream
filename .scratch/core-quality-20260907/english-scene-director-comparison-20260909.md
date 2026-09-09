# 英文场景：原文渲染与独立图片指令对照

Status: in_progress

## 当前结果

本轮没有合格的正式修复。直接把历史原文交给 Gen，可以保住单一场景的左右关系，但在用户更新场景后生成多个笔记本，将历史布置和新布置混在一起。独立图片指令、替换为 Qwen3.5-4B、开启该模型推理，也未完整保留固定用例的场景事实。以上候选均只在 task-local 诊断中运行，正式代码、模型配置和图片配方没有采用它们。

## 原文渲染：真实 Main 报价 / 预留 → Gen

Source: `idream-worktree-6e9ce5be88e45e07a70c71164ead6e34b7a0f547f0a801e07544214f97db99a5`。这是隔离渲染实验，绕过 Chat 接纳、工具生成和会话交付，不是新的完整 Chat 验收。使用原失败用例的固定成年角色、相同 Visual Profile / Reference Set、同一 seed、ComfyUI `qwen-image-edit-img2img` v2、832×1024、每次 1 张。提交前确认完整原文仍在最终编译 prompt 中，没有因 900 字符方向预算或 2,000 字符最终预算丢失对话。

| 输入 | Job / Attempt | 实际视觉结果 |
| --- | --- | --- |
| 冻结的原始英文对话 | `cmttkb50h0002a7l7eoi1cken` / `cmttkb5130008a7l7qzy5gpy6` | 雨夜、闭合蓝色笔记本平放窗台、笔记本在白杯左侧均可见；杯被角色握住，构图含腿部，因此不把局部约束成功等同于完整视觉质量合格 |
| 用户把雨夜左侧改成晴天右侧，助手随后仍复述旧场景 | `cmttkg6ki0002h2l7n9pzecp8` / `cmttkg6l30008h2l7t6z6x9bq` | 出现多本蓝色笔记本，分别在窗台左侧和另一张桌上，未正确表现单本笔记本移动到杯右侧；失败 |

准备好的“将来移动提议 + 角色点燃蜡烛”用例没有提交，原因是场景更新用例已失败；没有为该用例发放额度或创建 Job。

两次渲染均为原始 attempt，持久化及单次扣费核对通过，各消耗 8 个本地审计 Dreamcoins，共 16；余额为 0。只创建了短期下载登录 Session，下载后已删除，没有创建 Chat 会话或公开发布图片。

[原始对照证据](../../.tmp/core-fidelity-20260908/raw-scene-render.json) · [原始对照图](../../.tmp/core-fidelity-20260908/raw-scene-render.json.png) · [更新用例证据](../../.tmp/core-fidelity-20260908/raw-scene-render-change.json) · [更新失败图](../../.tmp/core-fidelity-20260908/raw-scene-render-change.json.png) · [视觉审阅](../../.tmp/core-fidelity-20260908/raw-scene-render-visual.json)

## 独立图片指令与模型比较

沿用已冻结的英文六例及真实 `sceneForReply` 产生的状态。图片调用在诊断中替换 system 为专门的场景解析 / 图片工具指令，仍使用实际 adapter 与来源格式；非图片用例保持原配置。替换后的 system、请求正文、返回及模型标识都保存在报告中，不将它们伪装成未修改的正式编译器输出。

- Ornith，专门图片 system：实际雨夜用例仍把左右关系压缩成 next to；助手冲突与最新用户变更两个用例方向较完整。6 次本地 HTTP，没有执行图片工具。
- Qwen3.5-4B，同 system 和采样：实际用例把对象相对位置写成角色左侧；最新晴天更新用例 prompt 写左侧而 caption 写右侧；不合格。6 次本地 HTTP，没有执行图片工具。
- Qwen3.5-4B，开启推理：从上一组原始请求直接重放 3 个图片用例，开启 `enable_thinking`，输出预算扩至 2,048 以容纳推理。实际用例保留左侧但没有明确夜晚，助手冲突例加入 outside windowsill，更新例把内部标记 Main 当人物名；不合格。仅诊断请求改变，没有修改共享适配器或服务配置。

[Ornith 独立指令](../../.tmp/core-fidelity-20260908/image-director-system-run.json) · [Qwen 独立指令](../../.tmp/core-fidelity-20260908/image-director-qwen-run.json) · [Qwen 推理对照](../../.tmp/core-fidelity-20260908/image-director-thinking-run.json)

当前 `/v1/models` 包含 Ling-3.0-tiny，但一次最小可用性请求返回 409：模型上次加载失败，273 个权重参数与运行实现不匹配。因此不能把目录中存在模型名当成可用候选；本轮未更改模型文件、加载器或服务设置。

## 工程边界

这组证据说明：保持原文并不能替代“从历史解析当前状态”，加长提示也不能视为事实遵从修复。下一候选需要对用户更新、助手矛盾、未来提议及未改变的既有属性形成可靠的当前场景，再进入图片生成；不能把未经验证的模型事实清单存成权威，也不能直接同时渲染历史和当前状态。当前事项继续保持 in_progress。
