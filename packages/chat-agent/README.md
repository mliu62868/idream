# Chat Agent sidecar

Minimal programmatic DeepSeek Harness companion runtime for Chat. The programmatic
composition manifest and digest are the execution truth: it loads only the turn services
and official igrep plugin, with no shell, filesystem, subagent, goal, or scheduler service.
The installer profile may materialize `dsh-base`; its dump is provenance evidence, not
proof that the engine loaded those services.

## Runtime setup

Node must satisfy `^22.19.0 || >=24.0.0`. The host system owns installation and upgrades
of the latest `igrep-tme` release. Verify that `igrep` is available, create the pinned DSH
profile, and copy one example environment file to `.env` in this package:

```bash
igrep --version
bun run dsh-companion:setup
bun run dsh-companion:check
cp .env.example .env
bun run start
```

Use the bootstrap report's `installedPluginPath` for `DSH_IGREP_PLUGIN_URL` and
`statePath` for `DSH_BOOTSTRAP_STATE_PATH`. The root
bootstrap is required because it pins the DSH CLI/plugin identity, materializes plugin
peers, and writes
the audited normal/private capability overlays; a bare `igrep setup` is insufficient.

`dotenv` reads `packages/chat-agent/.env` when PM2 starts this package with the package as
its working directory. `DSH_IGREP_PLUGIN_URL` must be the absolute `index.mjs` path under
the installed profile's `node_modules/@igrep/dsh-plugin`. Readiness keeps DSH
`0.1.0-rc.7` / commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` and plugin `0.1.0`
pinned, but accepts any release-form igrep version supplied by the host. It records that
actual version and still rejects normalized capability, profile digest, lifecycle, bridge,
or isolation drift. Immutable cutover proofs retain the igrep version that created them.

Set `IGREP_LLM_URL`, `IGREP_LLM_MODEL`, and `IGREP_LLM_API_KEY` explicitly for
igrep profile maintenance. Startup rejects missing, blank, or non-HTTP(S) values and
binds all official igrep plugin and CLI children to the validated values, so a local
`~/.igreprc` cannot silently select another maintenance model. These settings are
separate from the DSH turn provider below and are never returned by readiness or logged.

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
- `POST /v1/workspaces/rebuild/prepare` accepts strict `application/x-ndjson` `start`,
  `message_start`, bounded `content_chunk`, `message_complete`, and `complete` frames.
  Its required fence binds one durable Chat mutation claim and authority version. The
  sidecar validates and spools each session incrementally into a request-owned `0700`
  directory with `0600` files, ingests sessions sequentially, and creates a private
  candidate without changing canonical memory. There is no aggregate body,
  message-count, or single-message cap.
- `POST /v1/workspaces/rebuild/promote` atomically promotes only the exact prepared
  fence. Per-relationship authority versions are monotonic, so an old candidate cannot
  overwrite a newer projection. `POST /v1/workspaces/rebuild/discard` removes an
  unpromoted candidate. A truncated/disconnected prepare is removed automatically.
  There is deliberately no one-shot HTTP rebuild route that can bypass this protocol.

Normal memory is copied into an isolated attempt workspace. It is promoted atomically only
after Chat accepts the terminal candidate and public `igrep memory-status` proves both
dialogue ingest and profile maintenance. Rejection, cancellation, deadline, shutdown, or
an unverifiable/failed maintenance pass deletes the attempt instead. Private turns disable
all igrep search, memory, ingest, and wake surfaces and delete their temporary directory.

## Verification

```bash
bun run test
bun run typecheck
```
