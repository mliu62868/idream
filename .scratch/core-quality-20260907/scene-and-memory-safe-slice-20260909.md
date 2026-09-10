# 场景传递安全切片与记忆增长实测

Status: partial — 语义解析/持续 Scene/像素保真未修复；无损预算保护与隐私清理已实现。

## 实际改动

保留原图片工具合同和唯一 Chat route。新图片方向在 Main 接纳处核对完整编译预算：900 字符方向预算包含衣着要求，超限在附件/Job/计费前返回明确错误；最终 Chat assembler 优先保留完整方向与身份模板，仅在空间不足时省略可选传记/摄影修饰，不能容纳完整必需部分或追加 Look/preset 后超过 2000 字符时拒绝。它不能恢复模型早已遗漏的事实，也不宣称通用身份/语义校验。

`moment-direct-v1` 用 `verification: direct_input` 记录真实证据等级，移除固定 `confidence: 1`。产品 Turn 编辑/Session 删除同步清理 Generation Request 的 MomentSpec 私有文本；图片资产生命周期不变。

候选来源绑定与结构化编译原型未达到替换正常入口的资格，已从生产源码撤下，仅保留任务内实验原件；没有隐藏配置、第二模型 route 或长期双轨实现。

验证：`bun run --filter @idream/main test:pure src/server/modules/ourdream/generation-prompt.test.ts` 21/21 通过。新增 Main 集成断言要求超长新图片方向不产生附件、Job 或额度变化；现有编辑/删除测试新增 MomentSpec 清理断言，数据库批次由主任务统一串行执行。旧故障红灯见 [原诊断](./scene-fidelity-repair-design-20260909.md)，不得把当前仍失败的语义两项改成通过。

全量覆盖发现既有身份/场景分离用例使用 18 次重复摄影填充，原输入 951 字符，加入完整衣着约束后超限。已保留全部身份/场景断言，仅把重复填充减为 15 次（807 字符输入、884 字符完整输出）；同时新增纯测试要求原 18 次输入明确拒绝，而不是恢复截断或删除有效断言。未单独运行数据库测试，避免与主任务覆盖批次争用专用库。

## 单 route 模型资格：未通过，不继续消费

模型为当前配置 `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit`，本地 `127.0.0.1:8061/v1`，输出上限 1024，无 Gen/数据库/工具执行；每个实验原件含请求体、用量、响应、请求标识和当时 source revision。

1. 完整 sourced candidate：3 例、4 次模型请求（其中一次正式 adapter 的有界兼容重试），耗时 22.4 / 12.9 / 12.9 秒，均未通过结构/来源/未解决项。实际语义包括虚构 companion 身份、助手 dusk 污染、明确右移后仍取旧左侧。原件：[完整候选](../../.tmp/core-fidelity-20260908/image-moment-evaluation-1788945410104.json)。
2. 紧凑方案一：非角色扮演 JSON 解析，Main 提供 source 整数索引，不要求模型抄 ID/quote。3 次请求均原样回显输入，不产生候选。原件：[JSON 方案](../../.tmp/core-fidelity-20260908/image-moment-compact-evaluation-1788945778158.json)。
3. 紧凑方案二：强制 native semantic tool，同样使用 Main source 索引。首次诊断脚本遗漏正式 adapter 的 `enable_thinking:false`，3 次输出在思考阶段耗尽 1024 tokens；这批不能用于认定语义能力。按正式参数修正同一方案后 3 次输出完整 JSON，但没有 native tool call（脚本报告因此为 rejected；不能误说没有产生 JSON）。人工审阅：原始雨夜左侧基本保留；漂移例仍是 `dusk/night` 和暖黄昏；显式晴天右移被当成 image-only，剧情仍为雨夜左侧且图片同时晴天/夜晚，还有 companion 指向自己的关系。未达成替换资格，不继续增加未见例或像素请求。原件：[不适用的参数批次](../../.tmp/core-fidelity-20260908/image-moment-compact-evaluation-1788945862119.json)、[修正参数批次](../../.tmp/core-fidelity-20260908/image-moment-compact-evaluation-1788945919054.json)。

合计 13 次本地模型请求、零 Gen 消费；没有充值或第三方支付。来源索引范围有效只证明引用了某条记录，不证明解释正确、属性覆盖完整或像素正确。下一步仍需能通过上述真实失败类型与未见例的自托管解析能力，再单独通过像素验证；不能靠拒绝全部请求关闭事项。

## 08：100 / 1000 / 10000 消息增长测量

使用真实 igrep `mem ingest`、同源重播、真实 `AttemptWorkspaceStore.prepare` 和原子 promote。输入是每条 1000 字符的合成文本，单会话；私有临时目录完成后删除。复制对照用同一真实 igrep 文件集，每种方式 3 次。运行于本机暖缓存 APFS；不读取真实用户记忆。

| 消息数 | 实际 igrep 存储 | 首次 ingest | 同源重播 | normal attempt 中位 | promote |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 303,852 B / 4 文件 | 345 ms | 259 ms | 2.25 ms | 1.52 ms |
| 1000 | 3,038,263 B / 4 文件 | 695 ms | 451 ms | 2.03 ms | 0.82 ms |
| 10000 | 30,436,274 B / 4 文件 | 4,837 ms | 2,438 ms | 2.07 ms | 0.85 ms |

同源重播全部 `newEvents:0`、`written:false`，但扫描成本仍随历史增长。显式 COPYFILE_FICLONE 与现有 `cp` 没有实质差异，故不增加 clone 分支或改动 workspace 隔离/原子 promote/删除栅栏。当前证据不支持把 normal attempt 复制当成已测瓶颈。

这不是完整容量或 SLA 证明：未测 PostgreSQL 导出、多会话文件数量增长、维护模型与 embedding、跨平台文件系统或生产并发。应优先测量全历史导出/同源 ingest/维护链路，再决定是否需要增量投影；不能为未测成本提前拆架构。原件：[结果](../../.tmp/core-fidelity-20260908/memory-growth-benchmark.json)、[可复现脚本](../../.tmp/core-fidelity-20260908/memory-growth-benchmark.ts)。
