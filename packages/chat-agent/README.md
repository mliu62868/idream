# Chat Agent sidecar

`packages/chat-agent` 是 Companion Chat 唯一 DSH/official igrep 执行器。它执行模型、工具和派生记忆，不拥有产品 Turn、Scene、附件、余额、Generation 或结算。

## 运行

运行时为 Bun `1.4.0`；DSH packages 固定 `0.1.1-rc.2`，official igrep plugin 固定 `0.1.0`。每次升级都必须重新通过 composition、HTTP、lifecycle 和 Chat 集成测试。

```bash
igrep --version
bun run dsh-companion:setup
bun run dsh-companion:check
cp .env.example .env
bun run start
```

Bootstrap report 的 `installedPluginPath` 配置为 `DSH_IGREP_PLUGIN_URL`，`statePath` 配置为 `DSH_BOOTSTRAP_STATE_PATH`。chat-agent 只监听 loopback，Chat 与它共享 `DSH_AGENT_TOKEN`。

igrep maintenance model 与 Turn model 分开配置：

- `IGREP_LLM_URL` / `IGREP_LLM_MODEL` / `IGREP_LLM_API_KEY`
- `DSH_PROVIDER_API_KEY` / `DSH_READY_PROVIDER` / `DSH_READY_MODEL` / `DSH_READY_BASE_URL`

这些值不会通过 readiness 返回或写入日志。

## 当前 HTTP 边界

- `GET /healthz`：公开 liveness。
- `GET /readyz`：bearer-authenticated full readiness。
- `POST /v1/invocations`：接收一个 strict run frame，返回 NDJSON events。
- `POST /v1/invocations/:id/tool-result|commit|cancel`：精确控制当前 invocation。
- `POST /v1/workspaces/purge`：账号删除使用 user-scope purge。

Normal memory 在隔离 attempt workspace 中执行，只有 Main 接受 terminal candidate 且 igrep lifecycle 可验证后才原子提交。Private、拒绝、取消、超时、shutdown 或维护失败的 workspace 直接删除。

## 迁移专用兼容面

`workspaces/rebuild/*`、relationship-scope purge 和 memory-cutover proof 只服务于旧 companion-memory cutover；当前 Chat 产品路径没有调用者。生产 cutover 对账完成后，这组 endpoint、schema、workspace 版本管理和测试应整组删除，不能成为长期第二套记忆 authority。

## 验证

```bash
bun run test
bun run typecheck
bun run build
```
