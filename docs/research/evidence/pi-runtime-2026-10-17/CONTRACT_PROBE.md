# Pi 1.3.0 补充契约探针

`contract-probe.mjs` 使用官方 MemoryStorage 和 fauxProvider，仅运行合成文本，不调用真实模型或网络，不读取用户记忆。

在仓库之外创建临时目录，复制本目录的 `package.json`、`package-lock.json`、`contract-probe.mjs`，在该目录执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
bun contract-probe.mjs
```

本次使用与前一轮相同的隔离依赖目录，Bun 1.4.2、全部 Pi 包 1.3.0，退出 0；输出保存在 `contract-result.json`。依赖安装会联网；探针本身不联网。本结果不证明项目声明的 Bun 1.4.0 或真实 provider 已通过兼容验证。

断言的行为：

- 压缩后八条原始 entry 的正文、来源 metadata 与 ID 不变，最旧原文退出 active context 但仍能通过 entries 读取。
- `beforeCompact` 普通异常被报告后跳过，默认摘要器仍会派发一次 faux 请求。
- 在宿主标记致命错误、并在 Models 请求边界拒绝后，没有 faux provider 派发，也没有压缩 entry；任务以 `faulted` 结束。这里的 `faulted` 是抛出执行异常的框架终态，与 task 自己提交的 `failed` 不同。

这证明一个最小失败阻断方式可行，不证明最终 iDream adapter 的所有路径已覆盖。实施仍须测试自动/overflow 压缩、工具后续请求、取消和 Main 终态 fence。faux provider 派发次数只是控制流计数，不是实际模型费用。
