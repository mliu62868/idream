# iDream 当前功能覆盖审计

更新日期：2026-06-25

## 结论

这份文档是当前代码态的功能覆盖表，覆盖的是“用户能否完整使用”和“有没有测试证据”。它补充并修正 `ProductFeatureMap.md` 里 2026-06-13 的旧状态描述。

当前状态：**本地产品闭环通过，公开上线仍被真实生产依赖阻断**。

## 对标站当前公开信号

2026-06-25 重新查看 `https://ourdream.ai/`，公开入口仍以这些用户任务为主：

- 年龄确认。
- Explore 角色流、筛选和热门角色卡。
- Create、Chat、Generate、My AI、Feed、Community、Help Desk、Safety、Upgrade。
- Learn / Popular / Help footer 入口。
- AI companion、roleplay、chat、image/video generation、voice、memory、subscription 相关文案。

我们当前产品入口与这些一级任务基本对齐；差距不在入口数量，而在生产外部服务尚未接真实 provider。

## 当前已可用流程

| 用户/运营流程 | 当前状态 | 证据 |
| --- | --- | --- |
| 年龄门禁 | 可用；未确认前不渲染主内容，不触发受保护 API；本地接受状态可恢复 API cookie | `packages/main/src/e2e/flows.e2e.ts`：age gate flows |
| 注册和 session | 可用；注册后创建 authenticated session，并发放 250 dreamcoins | `flows.e2e.ts`：signup flow |
| Explore | 可用；搜索、分页、排序、gender filter、tag filter、移动端导航状态被验证 | `packages/main/src/e2e/ui-workflows.e2e.ts`：`explore UI syncs filters to URL and paginates results` |
| 角色详情 | 可用；角色卡进入 `/characters/:id`，Chat action 渲染 | `flows.e2e.ts`：explore grid -> character detail |
| Create -> My AI | 可用；提交角色，保存到 My AI created tab | `ui-workflows.e2e.ts`：`create UI submits a character and shows it in My AI created tab` |
| Chat | 可用；从角色详情开会话，发送消息，assistant 回复，刷新后历史仍在 | `ui-workflows.e2e.ts`：chat UI flow；`flows.e2e.ts`：chat API flow |
| Chat report | 可用；用户消息可举报并写入 `ContentReport` | `ui-workflows.e2e.ts`：chat message report |
| Generate image | 可用；生成排队、worker drain、完成、媒体进入 gallery，`/user-content` 返回真实图片 bytes | `ui-workflows.e2e.ts`：image generation UI；`flows.e2e.ts`：generation API |
| Generate video | 条件可用；`video_gen` flag + entitlement 打开后可排队并展示 video asset；默认 launch gate 要求 video 保持关闭或接真实 provider | `ui-workflows.e2e.ts`：video generation UI；`launch-readiness.ts`：video provider gate |
| 生成配置失败状态 | 可用；配置加载失败时显示错误，不展示假 0 balance，Generate 禁用 | `ui-workflows.e2e.ts`：generator config failure |
| Gallery report | 可用；生成媒体可举报并写入 `ContentReport` | `ui-workflows.e2e.ts`：generated media report |
| Upgrade | 本地闭环可用；Premium monthly 激活、dreamcoins 发放、profile 回显、prompt/negative prompt controls 解锁 | `ui-workflows.e2e.ts`：upgrade UI flow |
| Billing API | 本地/mock provider 闭环可用；真实上线要求 BTCPay provider 和 live probe | `flows.e2e.ts`：billing flow；`LAUNCH_READINESS_AUDIT.md` |
| Moderation/report queue | 可用；角色 report 后 admin moderation queue 可查 | `flows.e2e.ts`：moderation flow |
| Community | 可用；有公开 dreamer 数据时显示 dreamer card，并可举报 user profile；无数据时显示空状态 | `ui-workflows.e2e.ts`：community dreamers/report；Chrome smoke：community empty-state |
| Profile | 可用；余额、display name、preferences、redeem code、referral、language、billing link、media tab、media report/download/delete | `ui-workflows.e2e.ts`：profile flow |
| Account management | 可用；sign out all sessions，delete confirmation gate，delete 后返回 login | `ui-workflows.e2e.ts`：account management flow |
| Public routes | 可用；核心公开页无 404、无 broken images、无 launch-prohibited clone copy、无 console/page errors | `packages/main/src/e2e/public-routes.e2e.ts` |
| Admin web | 可用；dashboard、generation jobs/config、moderation、users、billing、audit log；users filter；无 console/page errors | `packages/main/src/e2e/admin-web.e2e.ts` |
| Admin API | 可用；dashboard、model profiles、audit log 响应 | `flows.e2e.ts`：admin control-plane API |
| Web surface protection | 可用；home、generate、age-gated API 403、admin protected state、admin API 401 | `.tmp/launch-web-surface-probe.json` |

## 当前已验证但非公开上线口径

| 范围 | 为什么不能直接当线上完成 |
| --- | --- |
| 图片生成 | 本地已经通过 pipeline + `sdcpp-image` + `pornmaster-zimage-turbo` probe；公开上线还需要生产 Pipeline URL/token、模型服务容量和 live probe |
| Chat/voice | 本地/mock 或 pipeline shape 已验证；公开上线必须配置非 mock provider、chat service DB role、durable storage、BFF shared secret、model gateway live probe |
| Payment | 本地 mock checkout 可验证权益闭环；公开上线必须配置 BTCPay Greenfield credentials、webhook secret、provider live probe |
| Age verification | 本地 age gate 可用；公开上线必须配置 Go.cam gateway、public HTTPS return/callback URL、webhook signature secret、provider live probe |
| Blob storage | 本地 blob 可验证 `/user-content`；公开上线必须配置 R2/S3 bucket/endpoint/access keys，并跑 write/sign/read/delete probe |
| Safety gateway | 本地/reporting/moderation queue 可用；公开上线必须配置真实 safety gateway URL/key 并跑 benign moderation live probe |
| Sentry | 代码 gate 已要求；公开上线必须配置 `SENTRY_DSN` |

## 与旧 ProductFeatureMap 的差异

`ProductFeatureMap.md` 仍有一些 2026-06-13 的旧缺口描述，例如 Create、Generate、Upgrade、Profile、Community、Admin 等流程标成“未实现”。以当前代码态为准，这些流程已经有功能实现和 E2E 覆盖。

仍然未达到公开上线的不是这些本地产品流程，而是：

1. 真实生产 provider 从 mock 切换。
2. 生产 secrets 和公网回调 URL 配置。
3. 对每个真实 provider 跑 live probe。
4. `bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env` 全绿。

## 不应误判为缺失的点

- `sd.cpp` 不应直接出现在 main-web 或 gen worker 产品配置里；它只能作为 Pipeline gateway 后面的 runner。
- `Video Beta` 默认禁用是正确状态；`video_gen=false` 时上线 gate 不要求真实 video provider。
- Community 在没有公开 dreamer 数据时显示空状态是正常状态；有数据时 E2E 覆盖 dreamer card 和 profile report。
- 本地 mock checkout 只证明权益/ledger/UI 闭环，不代表真实支付可上线。

## 下一步上线动作

按 `LAUNCH_READINESS_AUDIT.md` 补齐生产 env 后，必须重新执行：

```bash
bun run launch:probe:image:local
bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

通过后再跑完整 E2E 和 Chrome smoke，才能改成可公开上线运营状态。
