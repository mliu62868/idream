# iDream 上线验收入口

更新日期：2026-09-06

当前状态与证据以 [当前功能覆盖](CURRENT_FUNCTIONAL_COVERAGE.md) 为准；任务顺序见 [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)，运行步骤见 [运维手册](../architecture/10-operations.md)。本页提供验收入口，不保存一个会被新改动自动继承的“已通过”结论。

## 当前契约

- Main PostgreSQL 是产品 Turn、交付、计费、Character/Release/Serving 的权威。Chat 无数据库，只承载内嵌 DSH/igrep 执行与恢复证据；Main durable ACK 后才可发送 SSE `done`。不再配置 `CHAT_DATABASE_URL` 或部署 Chat projector。
- 图片与视频使用 Gen workflow-native backend。实际 profile、workflow 版本、模型和输入规格以冻结请求与运行记录为准。默认 RedGraft 视频已纳入产品链路；H3 新选择停用，质量未获稳定复验。不能沿用 2026-06 的“第一期视频禁用”作为当前验收预期，也不能降低生产配方门禁。
- Pocket 官方目录声音与 Fish 身份声音按实际选择分别验证。试听候选和激活版本是不同操作，不能用一份音频证明所有角色声音合格。
- `MODERATION_PROVIDER=mock` 是既定产品配置，保留基础未成年人拦截和角色 `age ≥ 18`。本页不另设人工日常审核关卡。
- 本地 development 和受控 audit 数据只证明技术链路。公开发布、真实支付、真实用户成熟窗口与经营指标认证分别需要目标环境证据。

## 验收顺序

1. 固定 source revision，核对工作区、实际进程、环境与 listener；运行适合本批改动的测试和构建。新源码不得冒用旧报告。
2. 按运维手册通过 PM2 wrapper 完成 drain、readiness、ownership 检查与必要启停。已有运行库先核查 migration/cutover 实际状态，不重复执行历史迁移。
3. 核查 full readiness 与 signed Chat 探针；走完本批涉及的真实用户、运营、重试恢复、交付、持久化和唯一额度结算链路。
4. 记录 provider/model、profile/workflow 版本、request/attempt/artifact、耗时与费用。历史样本、模拟测试、端口 200、进程 online 都不能代替当前真实验收。
5. 公开生产验收另按目标主机、HTTPS、受保护 Admin、持久化存储、provider 和遥测配置运行完整 gate；不因本地里程碑完成自动签发。

常用入口（先核对各命令参数与当前配置）：

```bash
bun run source:revision
bun run pm2:status
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json
```

四个运行面的遥测证据分别产生：

```bash
bun run launch:probe:sentry:main -- --report .tmp/launch-sentry-main-probe.json
bun run launch:probe:sentry:admin -- --report .tmp/launch-sentry-admin-probe.json
bun run launch:probe:sentry:chat -- --report .tmp/launch-sentry-chat-probe.json
bun run launch:probe:sentry:gen -- --report .tmp/launch-sentry-gen-probe.json
```

目标生产环境最终 gate：

```bash
bun run check:launch -- \
  --launch-env-file .tmp/production-main.env \
  --admin-env-file .tmp/production-admin.env \
  --chat-env-file .tmp/production-chat.env \
  --gen-env-file .tmp/production-gen.env \
  --report .tmp/check-launch.json
```

`PASS` 与同版本真实浏览器、模型、恢复和观察窗证据共同决定发布结论。缺少生产输入或观察窗时，应报告具体未满足项，不能把 unknown 写成成功。

## 历史证据

[2026-07-18 及更早上线审计快照](../product-audits/2026-07-18-launch-readiness-snapshot.md) 原文保留。其独立 Chat DB、旧视频开关、模型、端口、测试数量和命令只描述当时环境，不作为当前操作指南。
