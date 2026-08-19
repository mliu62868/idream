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
- `POST /v1/workspaces/rebuild` replaces one relationship from strict canonical Chat
  messages. Deep readiness proves this path with a disposable empty rebuild and always
  purges the probe relationship afterward.
- `POST /v1/workspaces/import-legacy-memory` records one strict, checksummed relationship
  through public `igrep mem record`, then requires `maintain --rebuild` and
  `doctor --strict` plus every operator recall-parity probe through public
  `igrep mem-api memory-search` before atomic promotion.

Normal memory is copied into an isolated attempt workspace. It is promoted atomically only
after Chat accepts the terminal candidate and public `igrep memory-status` proves both
dialogue ingest and profile maintenance. Rejection, cancellation, deadline, shutdown, or
an unverifiable/failed maintenance pass deletes the attempt instead. Private turns disable
all igrep search, memory, ingest, and wake surfaces and delete their temporary directory.
Shadow turns use a third, disjoint root. They may exercise igrep search, ingest, and wake
inside that disposable workspace for comparison. Chat rejects every shadow terminal,
and the sidecar workspace refuses promotion, so shadow state can never replace canonical
relationship memory.

## One-off legacy memory import

The operator command is deliberately single-relationship and defaults to dry-run:

```bash
bun run --cwd packages/chat memory:import-legacy -- --user-id USER_ID --character-id CHARACTER_ID --probe-file /secure/probes.json
bun run --cwd packages/chat memory:import-legacy -- --user-id USER_ID --character-id CHARACTER_ID --probe-file /secure/probes.json --apply
```

The operator-owned probe file is strict JSON. `legacyExpected` is a literal,
case-insensitive fragment that the old recall authority is known to return:

```json
{
  "version": 1,
  "probes": [
    {
      "id": "tea-preference",
      "query": "What tea does the user prefer?",
      "legacyExpected": "jasmine tea"
    }
  ]
}
```

Dry-run needs neither `DSH_AGENT_TOKEN` nor a reachable sidecar. It reports total legacy
entries, every exclusion class, the exact eligible entries, and their checksum. Apply also
reports the sidecar result and the durable external marker. The marker becomes
`status=cutover_ready` only after every probe passes and stores checksums, counts,
opaque probe ids, hit counts, and completion time—not queries, expected text, or
recalled context. Repeating the same import checksum, igrep version, and probe-set
checksum is a no-op. Chat also atomically merges a cleanup-required fact into the
anchor assistant `Message` and selected `MessageVersion`, so rollback cannot make a
later privacy cleanup intent look unnecessary. Before the sidecar request, Chat commits
that fact as `state=import_pending`; only a verified sidecar response advances it to
`state=cutover_ready`. A timeout, process exit, or final database failure therefore leaves
a conservative cleanup requirement instead of losing the fact that promotion may have
happened. The external marker is bound to the exact promoted workspace version, so any
later edit/delete rebuild invalidates the old parity evidence and forces revalidation.

Apply is a bounded one-off operator operation: it holds Chat's exclusive per-user authority
lock while it validates canonical turns and waits for the sidecar. That prevents an
edit/delete projection from invalidating source evidence before promotion, while
the sidecar hard-aborts at 300s, Chat aborts its request after
`DSH_AGENT_DEADLINE_MS + 30s`, and `DSH_AGENT_DEADLINE_MS + 45s` bounds the interactive
transaction. Run it during a quiet maintenance window. The marker is stored under the canonical root's hashed `_meta/`
namespace, outside the candidate workspace; relationship/user purge removes it.

## Verification

```bash
bun run test
bun run typecheck
```
