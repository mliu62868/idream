# 英文场景复验：明确物件关系仍被图片方向遗漏

Status: in_progress

## 已确认结果

2026-09-09 UTC，用固定成年摄影师和英文两轮请求，真实执行 Main → Chat → Gen。第一轮用户明确：雨夜，闭合蓝色笔记本平放木窗台，位于白杯左侧。第二轮只要求生成当前场景照片，不重复物件要求。

- Source: `idream-worktree-1afe0e08eb375ced0207a5d9ad253b30398a25865813772e4b5d77628f636709`；撤下场景关系正则之后的工作树。
- Chat: `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit`，两个 Turn 均为原始 attempt；记忆投影最终完成。
- Job: `cmtthdvl40003oql7sre6fwvn`；Attempt: `cmtthdvll0009oql7crkzjuos`。
- Gen: `comfyui` / `qwen-image-edit-img2img` v2，832×1024，1 张；约 95.8 秒，8 Dreamcoins。
- 冻结用户文本和历史、交付、持久化、下载、原键重播及唯一扣费检查通过；通过 Main DELETE 清理本次会话并等候记忆重建，余额为 0。

实际工具方向保留雨夜、闭合蓝色笔记本和木窗台，遗漏了“笔记本在白杯左侧”。最终图片中的笔记本明确在白杯右侧；夜景与雨滴可见。因此本次质量失败发生在工具方向阶段，并延续到成图；不能用技术链路通过覆盖质量失败，也不能从本次失败推断 Gen 在收到正确左右关系时一定不遵从。

[完整运行证据](../../.tmp/core-fidelity-20260908/english-withdrawn-scene.json) · [视觉审阅](../../.tmp/core-fidelity-20260908/english-withdrawn-visual-review.json) · [实际图片](../../.tmp/core-fidelity-20260908/english-withdrawn-scene.json.png)

## 同源受控模型对比

修正 task-local `fact-fidelity-scene.ts`：全部输入为英文；Scene 来自真实 `sceneForReply` 对各自历史的逐轮计算，不再把固定雨夜状态注入全部用例。六例包括上述真实回复、助手矛盾描述、最新用户更改、提议与完成动作、完整标签、角色已完成动作。诊断仍绕过 Main / DSH / igrep / Gen，因此只用于模型边界，不能替代真实链路。三组固定输入共 19 次本地 HTTP，未执行图片工具。

| 对比 | 实际雨夜用例 | 助手矛盾用例 | 用户改成晴天右侧 |
| --- | --- | --- | --- |
| 现有实现 | 漏左右关系，并加入 evening | 漏左右关系，并加入 evening；首次省略工具 | 保留晴天及笔记本在杯右侧 |
| 增加完整性提醒（仅诊断） | 仍漏物件之间关系 | 保留左侧，但加入 twilight | 将杯右侧改成角色右侧 |
| 工具增加 sceneConstraints 字段（仅诊断） | 清单与 prompt 都保留左侧 | 清单污染为 dusk，prompt 为夜景 | 清单保留右侧，但 prompt 遗漏 |

两个候选均不满足验收，**没有进入正式源码或运行配置**。不能将独立清单视为已核实的事实权威；也不能将语义失败替换为关键词门通过。事实问答基线还把角色未来种植提议回答成已经完成，表明普通表达质量仍有独立缺口。

[基线](../../.tmp/core-fidelity-20260908/english-extractor-baseline-run.json) · [提醒候选](../../.tmp/core-fidelity-20260908/english-extractor-candidate-run.json) · [结构化候选](../../.tmp/core-fidelity-20260908/english-extractor-structured-run.json)

## 测试环境恢复

旧运行 `b28f8bed-4bc5-47d0-a8a6-9f78b72f07d8` 留下 8 个未使用额度。核对目标开发库、会话不存在、无后续生成和该额度为最后一笔账后，通过既有 billingAdjustment 归还，保留反向账本分录；没有删除账。

关系记忆投影事件 `a5b56a7c-e0a4-4322-8ef3-c7fba5ad4ba2` 曾重试 24 次，最近错误为 prepare 400；旧 Chat 日志显示 igrep 子进程 exit_nonzero，尚不能据此确定底层原因。当前同任务 prepare 返回 200。仅以 CAS 提前该 pending 任务的 nextRunAt，保留事件、attempt、lease/claim 和 worker 权威；原 worker 第 25 次执行已 delivered。随后本次两轮投影及会话删除后的重建也完成。这证明恢复，**不证明历史 igrep 错误根因已修复**。

[旧额度归还](../../.tmp/core-fidelity-20260908/unused-grant-return.json) · [定向重试记录](../../.tmp/core-fidelity-20260908/memory-requeue.json)

## 当前边界

本轮完成了撤下候选后的英文完整链路复验、真实视觉检查、两个候选的否决和测试数据清理。正式场景遵从缺陷未修复，事项保持 in_progress。后续候选必须保留全部相关用户约束、正确处理用户更新和角色提议，并在完整生成链路中通过视觉检查；本报告不将任何候选的单例成功外推为完成。
