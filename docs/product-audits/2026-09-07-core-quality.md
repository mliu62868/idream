# 场景连续性与记忆撤回实施报告 · 2026-09-07

状态：图片上下文与长会话预算工程修复完成，最终候选完整 readiness 和签名产品探针通过，受控数据已清理。上游记忆撤回授权缺陷未修复。既有 WIP 保留，没有提交、推送或公开发布。

## 工程修复

强制图片调用原来只传 system、最后 state 和当前请求，丢弃已经准备的历史及召回。因此“在我们当前场景里发图”会失去仅存在于历史的天气与物件位置。现在仍保留一个当前工具动作，把先前文本按来源与 user/assistant 角色作为引用数据交付，不重放旧工具协议。native 与 JSON 兼容两路一致；完整请求超预算仍在 provider 前明确拒绝。首个候选采用执行策略6；预算增量后为7，各自使用对应 composition 证据。

新场景/召回用例在旧实现两路真实失败，修复后通过；超限用例确认没有 provider 请求。Chat 26 文件 220 项测试、typecheck、根目录 check 与最终 Chat build 通过。没有更改 Scene 提取规则、角色 Soul、Main 权威、模型或生成配方。

## 记忆撤回的确定性红回归

原版 igrep 0.1.137 在隔离目录通过正式 ingest/maintain 先建立已知事实，然后对正常用户输入注入错误 Forget 提议。实际删除 profile 并写入 4 条撤回注释，maintain success、doctor ok/warnings=[]、pending=0；fault 阶段没有 Dream 调用。6 次 HTTP 全到临时 127.0.0.1:54457 假模型，没有真实模型消费、业务记忆修改或安装包修改。脚本退出 1 是缺陷复现，harness error 单独分类。

证据：`.tmp/core-quality-20260907/forget-fault-20260907T073703Z-b5c98a11/outcome.json`、完整 mock 请求/响应、commands 与 network。可失败脚本 `igrep_forget_fault_regression.py` 和 `IGREP_BOUNDARY_OPTIONS.md` 保留；本地事项 `.scratch/core-quality-20260907/issues/01-igrep-retraction-authority.md` 状态 needs-info。

当前依赖分发只有编译文件；核对的官方最新 0.1.139 wheel 未提供可信授权边界。已请求可维护源码或已修复版本。未升级未证实修复的依赖，也未通过过滤撤回标记、改写安装包或另造记忆算法掩盖问题。上游修复仍必须验证真实中英文撤回、纠正、否定、引用、助手提议、跨 batch 范围与 Main 删除重建。

## 内容评阅更正与限制

水彩 Mira 的雨天书店可能是画作题材，结合 glaze reflections 不能直接推定人物身处书店。已在旧报告追加更正，原始对话和产物不变。摄影师上下文丢失有独立确定性证据，不依赖这一歧义。文本中的精确事实、用户动作归属、虚构时间，以及严格局部编辑仍未完成质量修复；上下文不丢失也不保证模型必然遵从。

## 本轮正式运行

首个候选 `idream-worktree-fe322a739443b3de827f0799e585e8b427f2f2eb66bd6a48be3d4a5a6a8a730b` 经正常 PM2 wrapper drain/restart/readiness/resume，完整 Chat readiness 和签名 Main 产品探针通过。normal/private composition、记忆隔离、Main ACK、真实模型与精确探针删除均有独立证据。Chat 是 oMLX `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit`，DSH `0.1.1-rc.2`，igrep `0.1.137`。

摄影师 Mira（28岁）冻结 Soul/Release/视觉引用，在受控 audit 账号下先建立“雨夜、闭合蓝色笔记本平放木窗台、白杯左侧、没有拿在手里”。第二条请求仅要求当前场景及原来物件位置，未重复天气、时间或位置。Main 冻结历史包含首轮原文；实际工具方向保留上述事实，原键重播不新增 Turn 或 Job。2 条 Turn 及图片共有 42 项自动检查通过，其中 5 项是方向文本的词法证据，不等于视觉评分。

| 项目 | 实际记录 |
| --- | --- |
| Scene Turn / provider request | `5c9a8864-a484-48fd-a322-6b38887eb9da` / `chatcmpl-15bc9948` |
| Image Turn / provider request | `90df7853-41e0-4d9c-aaf4-f0e2b2bb540b` / `chatcmpl-7b3202cb` |
| GenerationJob / attempt | `cmtqxyeej000b9vl7q66l3423` / `cmtqxyef6000h9vl7mzhkx9qq`，attempt 1 |
| provider / workflow | ComfyUI / `qwen-image-edit-img2img` v2，角色引用驱动的新图，没有上一张图片的 sourceImageAssetId |
| profile | `chat-image-edit` v2；沿用既有报价与路由，其名称不代表本请求是修改上一张图 |
| provider request | `b67f5900-91a9-4b9c-b13e-547c14d61811` |
| 交付媒体 | `media_z517dvdlyc9mtqy0m7o`，832×1024 PNG |
| Main 交付 / provider 执行 | 103.436 秒 / 101.618 秒（含装载）；锁等待 0.786 毫秒 |
| 账本 | 唯一 8 审计币补额、唯一 -8 生成扣费、余额回到 0；provider 法币成本未知 |

直接比较交付 PNG 与冻结参考：人物五官、肩长棕发、雀斑和青色上衣基本一致；雨滴、蓝色闭合笔记本在木窗台左侧、白杯及非手持状态清楚。**夜晚未批准**：窗外更像亮蓝黄昏，工具方向虽然有 rainy night，同时加入了 blue-grey evening。这个样本证明上下文与物件位置保留，不能签发全部图文质量通过。

390px 浏览器整页刷新后会话与 experience 均 200，图片完整解码；文档宽度390、图片832×1024、无 pageerror。浏览器实际媒体 GET 的 SHA-256 与 Main 鉴权下载一致。截图为 `output/playwright/core-experience-20260906/scene-20260907-mobile.png`，该文件是本轮新拍，目录名沿用已有忽略规则。

本轮新会话通过 Main DELETE 清理，GET404、记忆重建 idle；2条Turn/1附件移除，2条永久日额度事实保留。图片Job、1资产、1Gen用量及账本全部保留。另核对签名探针两会话均删除，临时鉴权Session均清理。浏览器鉴权脚本曾因相对输出路径失败；按精确id/创建时间恢复同一已创建Session，没有重复创建，最终精确删除。独立只读对账 `final-audit.json` 为16检查通过，余额0，无范围内未完成Job或记忆副作用。上一轮143项账本报告保留为历史，未把本轮消费混入。

## 长会话预算复查

独立只读 review 用真实 free 档 6,000 token 上限和三对较长历史复现：PreparedTurn 估算5,902而新wire实际6,117，导致到达provider前拒绝。该故障不在短场景样本中出现。现在准备与适配器共用纯请求格式，完整 messages/tools 的 JSON 字符估算取原生与 JSON 兼容较大值，超限沿既有最旧完整 exchange 规则裁剪，最终 hard guard 保留。没有抬高 free 档6,000上限，也不在传输层静默丢弃历史。source.kind=tool 即使只有纯文本，仍不能被图片步骤当作对话证据；普通请求保留原行为。执行策略版本7。

新增集成回归实际经过 compile→adapter：原生与JSON两路先红后绿；另覆盖 native=5,997 可过而JSON超6,000的重试边界，以及固定上下文超过真实上限时拒绝。最后224项Chat测试通过。13组旧/新完整HTTP body逐字节相同，覆盖短生成/编辑、历史召回、工具协议、纯文本工具来源与普通对话；零网络请求，详见 `budget-regression/body-equivalence.json`。这证明格式搬移未改变受测输入，并不伪造旧模型wire记录或把fe322媒体重贴新source。

最终候选为 `idream-worktree-e63c22f0f256ee1d1a8f64067c97b07a5575435ba2af5222453e514ac6191b69`。最后224项Chat测试及根目录check通过（5任务成功）；正常wrapper重启后8个核心服务同源，完整readiness通过，最终签名产品探针33.374秒通过，其两会话及记忆重建清理成功。最终只读对账16项通过，包含本轮Scene和两次签名探针的5个精确会话，余额0，临时鉴权0，范围内待处理/失败记忆副作用0。后端、模型、角色配置和短图片请求没有因此变化，不重复消费相同短样本。

最终媒体与移动端证据属于fe322；预算增量属于e63c，使用长会话回归、13组正文对照和新的正式Chat探针验收。末尾报告更新只改变文档，执行代码哈希与进程核对另存 `final-handoff.json`，不将工作树完整hash差异藏掉。

## 证据入口

- [真实场景、Main冻结、DSH与唯一生成记录](/Users/kk/code/idream/.tmp/core-quality-20260907/scene-validation.json)
- [直接视觉审阅](/Users/kk/code/idream/.tmp/core-quality-20260907/visual-review.json) · [手机截图](/Users/kk/code/idream/output/playwright/core-experience-20260906/scene-20260907-mobile.png) · [浏览器与下载字节核对](/Users/kk/code/idream/.tmp/core-quality-20260907/browser-evidence.json)
- [最终readiness](/Users/kk/code/idream/.tmp/core-quality-20260907/chat-full-readiness-final.json) · [最终签名探针](/Users/kk/code/idream/.tmp/core-quality-20260907/signed-chat-probe-final.json) · [最终只读对账](/Users/kk/code/idream/.tmp/core-quality-20260907/final-handoff-audit.json)
- [上游撤回边界与红回归](/Users/kk/code/idream/.tmp/core-quality-20260907/IGREP_BOUNDARY_OPTIONS.md) · [待源码事项](/Users/kk/code/idream/.scratch/core-quality-20260907/issues/01-igrep-retraction-authority.md)
- [下一步场景与事实遵从](/Users/kk/code/idream/.scratch/core-quality-20260907/issues/02-scene-fidelity.md)
