# igrep 模型撤回提议缺少用户授权验证

Status: needs-info
Type: task

正常的回忆请求可被模型抽取成 Forget，官方 igrep 0.1.137 随后删除已有用户事实并持久化撤回标记。原始用户并未要求忘记。当前仅有编译后的官方发行包，未发现本地可维护上游源码；已向用户询问源码或修复版本。0.1.139 的静态检查仍存在同一接受边界，不能把升级当作修复。

## 已完成的证据

- 真实受控失败及逐段根因：[原始事项](../../../.tmp/core-experience-20260906/IGREP_FORGET_FINDING.md)。
- 可重复回归：从仓库根运行 `python3 .tmp/core-quality-20260907/igrep_forget_fault_regression.py`。使用当前官方 CLI、一次性隔离 workspace、仅回环地址的假模型服务，无真实模型或业务库写入。每次输出到独立目录，不覆盖失败。
- 已运行结果：[outcome.json](../../../.tmp/core-quality-20260907/forget-fault-20260907T073703Z-b5c98a11/outcome.json)。先通过官方维护建立 notebook 事实，再注入错误 Forget；原事实文件删除，新增4个retraction，maintain/doctor仍成功。进程退出1准确表达回归失败，不是测试基础设施错误。

## 修复范围与验收

在上游模型 observation 被接受为 Forget/Correction 之前，要求它绑定原始用户事件和明确授权的目标范围。普通否定、回忆请求、助手建议、引用他人的忘记措辞都不能产生撤回权；模型匹配相似目标不能替代用户授权。保护 profile、tombstone和历史对话annotation三处副作用，并保留生命周期锁、cursor、幂等与原子发布。

故障注入仍返回相同错误Forget时不得删除已确认事实或写撤回；明确中英文撤回/纠正仍只影响授权范围。另测“不要忘记”、普通否定、引用与助手来源、跨batch重跑。Main自己的编辑/删除/清除记忆仍必须完成正确重建。

不得通过剥离标记、停用所有维护、改写已安装pyc或新增第二套记忆算法把失败变成通过。获得可维护源码/官方接口后实施上游修复，再用同一回归及最小真实维护→召回样本复验。

## 2026-09-08 UTC 宿主侧来源保护

上游修复仍是 needs-info；宿主 containment 可以独立实施，不以等待源码阻塞 Main 来源保护。既有 candidate builder 验证官方 dialogue 对应完整有效 Main 输入；任何坏撤回覆盖导致整份候选派生存储被丢弃，再由官方 ingest 从已固定来源新建索引一次。它不从坏文件中移除标记，不修改 pyc，也不替代上游记忆语义。源索引可用而摘要被拒绝的状态及副作用范围单独记录。

跟踪[来源保护报告](../../../docs/product-audits/2026-09-08-core-authority.md)。上游回归仍保持红色；builder containment 的绿回归不能关闭此事项，也不能声称 Dream profile Delete/Update 已获语义授权。
