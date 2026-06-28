# iDream 上线可用性审计

更新日期：2026-06-27

## 结论

当前状态：**DONE_WITH_CONCERNS，不能判定为可公开上线运营**。按 2026-06-26 范围决策，当前目标收窄为内部演示/受控 beta。

本地产品主流程、构建、E2E、Chrome smoke、图片 pipeline、web surface、产品生成配置已经通过验证。未来公开上线阻断集中在真实生产外部依赖尚未配置或尚未用真实 provider probe 证明可用：chat、moderation、payment、blob、age verification、Sentry。

## 2026-06-26 范围决策

以下集成明确延后，先不作为当前里程碑工作：

- Safety Gateway：`MODERATION_PROVIDER=safety-gateway`、`CHAT_MODERATION_PROVIDER=safety-gateway`。
- Go.cam：`AGE_VERIFICATION_PROVIDER=gocam`。
- BTCPay：`PAYMENT_PROVIDER=btcpay`。
- R2/S3：`BLOB_PROVIDER=r2` 或 `s3`。
- Sentry：`SENTRY_DSN`。

影响：

- 当前不能按公开上线验收，只能按本地/内部演示/受控 beta 验收。
- `check:launch:direct` 不应因为这些集成延后而被降级放行；公开上线 gate 仍然必须保持严格。
- 下面的 provider、safety、billing、compliance、storage、observability 项目保留为未来公开上线前必须恢复的清单。

**视频生成（第一期不上线）**：与上述"延后集成"不同，这是产品功能层面的延期——因视频生成耗时过长排入 V1.1（见 `docs/architecture/12-roadmap.md` 2026-06-27 范围决策）。第一期 `video_gen` 功能位保持 `false`，readiness 检查以"视频禁用"为预期通过（产品配置 probe 见 `video_gen=false`），不计为公开上线阻断项。

## 已验证通过

| 范围 | 证据 |
| --- | --- |
| 全量 E2E | `PW_BASE_URL=http://127.0.0.1:3000 PW_ADMIN_BASE_URL=http://127.0.0.1:3001 bun run --filter @idream/main test:e2e`，36/36 passed |
| 全量测试 | `bun run test` passed |
| 类型、lint、构建 | `bun run check` passed |
| 运行进程 | `pm2 restart main-web admin-web` 后 main/admin/chat/gen/sdcpp-image 在线 |
| Chrome smoke | Chrome 访问 `/generate`、`/community`、`/upgrade`、`/admin`，无 console error、无 Next error shell；community 当前是正常空状态 |
| Web surface probe | `.tmp/launch-web-surface-probe.json`，`ok=true`，首页、`/generate`、age-gated API、admin protected state、admin API 401 都通过 |
| Internal Pipeline probe | `.tmp/internal-pipeline-probes.json`，`ok=true`，web surface、product config、chat service、chat model pipeline、image pipeline 都通过；voice 因未配置 `/audio/speech` gateway 被显式跳过 |
| 图片 pipeline | `.tmp/launch-image-probe.json`，`ok=true`，`provider=pipeline`，`pipelineUrl=http://127.0.0.1:8091`，`model=pornmaster-zimage-turbo` |
| Chat model pipeline | `.tmp/launch-chat-probe.json`，`ok=true`，`provider=pipeline`，`baseUrl=http://127.0.0.1:8061/v1`，`model=Qwen3.5-0.8B-8bit` |
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

## 当前 Pipeline 状态

Pipeline 不在 2026-06-26 延后清单里。当前内部 beta 必须继续跑通：

```bash
bun run launch:probe:pipeline
```

当前本地结果：

- image pipeline 已通：`@idream/gen` 调 `http://127.0.0.1:8091/images/generations`，返回 `generation.completed`，产出 1 个 asset。
- chat pipeline 已通：`@idream/main probe:chat` 以 `CHAT_MODEL_PROVIDER=pipeline` 调 `http://127.0.0.1:8061/v1/chat/completions`。
- chat service BFF 已通：签名请求 200，未签名请求 401。
- voice pipeline adapter 已有，目标模型选 MOSS-TTS v1.5。本地 `sdcpp-image` gateway 不提供 `/audio/speech`，显式 voice probe 返回 HTTP 404，说明 sd.cpp 不是 voice runner。2026-06-27 已用 oMLX 跑通更小的 `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit` smoke path，speaker `serena`，可作为 Apple Silicon 本地验证路径。若 demo 或上线承诺包含 MOSS voice，必须用 SGLang-Omni（共享 GPU 默认）或 MLX（Apple Silicon 本地实验）暴露 MOSS OpenAI-compatible `/v1/audio/speech`，配置 `PIPELINE_VOICE_API_URL`，然后运行 `bun run launch:probe:pipeline -- --include-voice`。

## 未来公开上线阻断

### Providers

未来公开上线前，必须把生产 provider 从 mock 切到真实实现：

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

### Safety（已延后）

当前失败项：

- `moderation-service-url`
- `moderation-api-key`

未来公开上线前需要配置真实 safety gateway：

- `MODERATION_SERVICE_URL`
- `MODERATION_API_KEY`

然后运行：

```bash
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
```

### Billing（已延后）

当前失败项：

- `payment-api-key`
- `payment-btcpay-base-url`
- `payment-btcpay-store-id`
- `payment-webhook-secret`

未来公开上线前需要配置 BTCPay Greenfield：

- `BTCPAY_BASE_URL`
- `BTCPAY_STORE_ID`
- `BTCPAY_API_KEY`
- `BTCPAY_WEBHOOK_SECRET`

然后运行：

```bash
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
```

### Compliance（已延后）

当前失败项：

- `age-verification-service-url`
- `age-verification-api-key`
- `age-verification-webhook-secret`
- `age-verification-link-back-url`
- `age-verification-callback-url`

未来公开上线前需要配置 Go.cam gateway：

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

### Storage（已延后）

当前失败项：

- `blob-bucket`
- `blob-endpoint`
- `blob-access-key`
- `blob-secret-key`

未来公开上线前需要配置 R2/S3 私有对象存储：

- `BLOB_ENDPOINT`
- `BLOB_BUCKET`
- `BLOB_REGION`
- `BLOB_ACCESS_KEY_ID`
- `BLOB_SECRET_ACCESS_KEY`

然后运行：

```bash
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
```

### Observability（已延后）

当前失败项：

- `sentry-dsn`

未来公开上线前需要配置：

- `SENTRY_DSN`

## 未来公开上线前执行顺序

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
