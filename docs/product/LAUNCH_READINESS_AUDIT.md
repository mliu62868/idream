# iDream 上线可用性审计

更新日期：2026-06-25

## 结论

当前状态：**DONE_WITH_CONCERNS，不能判定为可公开上线运营**。

本地产品主流程、构建、E2E、Chrome smoke、图片 pipeline、web surface、产品生成配置已经通过验证。上线阻断集中在真实生产外部依赖尚未配置或尚未用真实 provider probe 证明可用：chat、moderation、payment、blob、age verification、Sentry。

## 已验证通过

| 范围 | 证据 |
| --- | --- |
| 全量 E2E | `PW_BASE_URL=http://127.0.0.1:3000 PW_ADMIN_BASE_URL=http://127.0.0.1:3001 bun run --filter @idream/main test:e2e`，36/36 passed |
| 全量测试 | `bun run test` passed |
| 类型、lint、构建 | `bun run check` passed |
| 运行进程 | `pm2 restart main-web admin-web` 后 main/admin/chat/gen/sdcpp-image 在线 |
| Chrome smoke | Chrome 访问 `/generate`、`/community`、`/upgrade`、`/admin`，无 console error、无 Next error shell；community 当前是正常空状态 |
| Web surface probe | `.tmp/launch-web-surface-probe.json`，`ok=true`，首页、`/generate`、age-gated API、admin protected state、admin API 401 都通过 |
| 图片 pipeline | `.tmp/launch-image-probe.json`，`ok=true`，`provider=pipeline`，`pipelineUrl=http://127.0.0.1:8091`，`model=pornmaster-zimage-turbo` |
| 产品生成配置 | `.tmp/launch-product-config-probe.json`，`ok=true`，active image model/template/pricing 存在，`video_gen=false` |
| launch direct gate | `bun run check:launch:direct -- --launch-env-file .tmp/launch-probe-only.env --json` 当前 `28 pass / 29 fail / 0 warn` |

## 图片服务链路

产品服务不直接加载 `.safetensors`，也不直接调用 sd.cpp。稳定边界是 OpenAI-compatible Pipeline API：

```text
main-web / packages/gen
  -> GEN_IMAGE_PROVIDER=pipeline
  -> PIPELINE_API_URL
  -> local/internal pipeline gateway
  -> sd.cpp runner
  -> ~/Downloads/pornmasterZImage_turboV35Bf16.safetensors
```

当前本地 `sdcpp-image` 进程把 `stable-diffusion.cpp` 包装成 OpenAI-compatible image API，使用模型 alias `pornmaster-zimage-turbo`。这符合产品边界：线上仍然只暴露 `PIPELINE_API_URL`、`PIPELINE_API_TOKEN` 和模型 alias，不把 runner 或模型文件路径写进产品服务。

## 当前上线阻断

### Providers

必须把生产 provider 从 mock 切到真实实现：

- `CHAT_PROVIDER=pipeline`
- `VOICE_PROVIDER=pipeline`
- `MODERATION_PROVIDER=safety-gateway`
- `PAYMENT_PROVIDER=btcpay`
- `BLOB_PROVIDER=r2` 或 `s3`
- `AGE_VERIFICATION_PROVIDER=gocam`

### Chat

当前失败项：

- `chat-bff-signing-secret`
- `chat-database-url`
- `chat-fs-root`
- `chat-model-provider`
- `chat-moderation-provider`
- `chat-moderation-service-url`
- `chat-moderation-api-key`

需要配置：

- `CHAT_BFF_SIGNING_SECRET`，main-web 和 packages/chat 完全一致
- `CHAT_DATABASE_URL`，Postgres 用户必须是 `chat_service`
- `CHAT_FS_ROOT`，绝对路径且挂载 durable storage
- `CHAT_MODEL_PROVIDER=pipeline` 或 `openai`
- `CHAT_MODERATION_PROVIDER=safety-gateway`
- `CHAT_MODERATION_SERVICE_URL` / `CHAT_MODERATION_API_KEY`

### Safety

当前失败项：

- `moderation-service-url`
- `moderation-api-key`

需要配置真实 safety gateway：

- `MODERATION_SERVICE_URL`
- `MODERATION_API_KEY`

然后运行：

```bash
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
```

### Billing

当前失败项：

- `payment-api-key`
- `payment-btcpay-base-url`
- `payment-btcpay-store-id`
- `payment-webhook-secret`

需要配置 BTCPay Greenfield：

- `BTCPAY_BASE_URL`
- `BTCPAY_STORE_ID`
- `BTCPAY_API_KEY`
- `BTCPAY_WEBHOOK_SECRET`

然后运行：

```bash
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
```

### Compliance

当前失败项：

- `age-verification-service-url`
- `age-verification-api-key`
- `age-verification-webhook-secret`
- `age-verification-link-back-url`
- `age-verification-callback-url`

需要配置 Go.cam gateway：

- `AGE_VERIFY_SERVICE_URL`
- `AGE_VERIFY_API_KEY`
- `AGE_VERIFY_WEBHOOK_SECRET`
- `AGE_VERIFY_LINK_BACK_URL`
- `AGE_VERIFY_CALLBACK_URL`

`AGE_VERIFY_LINK_BACK_URL` 和 `AGE_VERIFY_CALLBACK_URL` 必须是公网 HTTPS，不能是 localhost 或 placeholder。

然后运行：

```bash
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
```

### Storage

当前失败项：

- `blob-bucket`
- `blob-endpoint`
- `blob-access-key`
- `blob-secret-key`

需要配置 R2/S3 私有对象存储：

- `BLOB_ENDPOINT`
- `BLOB_BUCKET`
- `BLOB_REGION`
- `BLOB_ACCESS_KEY_ID`
- `BLOB_SECRET_ACCESS_KEY`

然后运行：

```bash
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
```

### Observability

当前失败项：

- `sentry-dsn`

需要配置：

- `SENTRY_DSN`

## 上线前执行顺序

1. 从 `packages/main/.env.production.example`、`packages/chat/.env.production.example`、`packages/gen/.env.production.example` 建立 secret manager 配置。
2. 部署或接入真实 pipeline、chat、safety gateway、BTCPay、Go.cam gateway、R2/S3、Sentry。
3. 运行所有 probe：

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
```

4. 运行最终 gate：

```bash
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

只有该命令 `PASS`，并且 Chrome 真实用户流程仍无 console/runtime 错误，才能把状态改为可上线运营。
