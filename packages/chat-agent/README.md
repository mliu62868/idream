# Chat Agent sidecar

Minimal programmatic DeepSeek Harness companion runtime for Chat. It composes only the
DSH core services needed for a turn and loads the official igrep plugin from an explicit
profile path; it does not load the DSH base, shell, filesystem, subagent, or goal plugins.

## Runtime setup

Node must satisfy `^22.19.0 || >=24.0.0`. Install `igrep-tme==0.1.132`, create the pinned
DSH profile, and copy one example environment file to `.env` in this package:

```bash
uv tool install 'igrep-tme==0.1.132'
bun run dsh-companion:setup
bun run dsh-companion:check
cp .env.example .env
bun run start
```

Use the bootstrap report's `installedPluginPath` for `DSH_IGREP_PLUGIN_URL` and
`statePath` for `DSH_BOOTSTRAP_STATE_PATH`. The root
bootstrap is required because it pins the DSH CLI, materializes plugin peers, and writes
the audited normal/private capability overlays; a bare `igrep setup` is insufficient.

`dotenv` reads `packages/chat-agent/.env` when PM2 starts this package with the package as
its working directory. `DSH_IGREP_PLUGIN_URL` must be the absolute `index.mjs` path under
the installed profile's `node_modules/@igrep/dsh-plugin`. Readiness rejects any version or
normalized plugin-profile drift from DSH `0.1.0-rc.7` / commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, igrep `0.1.132`, and plugin `0.1.0`.

Chat and this process share `DSH_AGENT_TOKEN`; there is deliberately no second sidecar
token variable. The default listener is `127.0.0.1:3101`, matching Chat's default
`DSH_AGENT_URL=http://127.0.0.1:3101`.

## HTTP boundary

- `GET /healthz` is public liveness only.
- `GET /readyz` and every `/v1/*` route require `Authorization: Bearer $DSH_AGENT_TOKEN`.
- `POST /v1/invocations` accepts one strict `run` frame and streams response NDJSON.
- `POST /v1/invocations/:id/tool-result`, `/commit`, and `/cancel` accept their strict
  companion control frames.
- `POST /v1/workspaces/purge` accepts either `{ "scope":"user", "userId":"..." }` or
  `{ "scope":"relationship", "userId":"...", "characterId":"..." }`.

Normal memory is copied into an isolated attempt workspace. It is promoted atomically only
after Chat accepts the terminal candidate and public `igrep memory-status` proves both
dialogue ingest and profile maintenance. Rejection, cancellation, deadline, shutdown, or
an unverifiable/failed maintenance pass deletes the attempt instead. Private turns disable
all igrep search, memory, ingest, and wake surfaces and delete their temporary directory.
Shadow turns use a third, disjoint root. They may exercise igrep search, ingest, and wake
inside that disposable workspace for comparison. Chat rejects every shadow terminal,
and the sidecar workspace refuses promotion, so shadow state can never replace canonical
relationship memory.

## Verification

```bash
bun run test
bun run typecheck
```
