# Repository Character Souls

Reviewed official Character Soul documents live here. One JSON file describes
one explicitly authored character; do not generate missing fields from a common
template.

Required shape:

```json
{
  "documentVersion": 1,
  "characterId": "existing-official-character-id",
  "expectedCurrentContentHash": "optimistic-lock-from-current-content-version",
  "reason": "character-specific review reason",
  "soul": {
    "identity": {},
    "innerLife": {},
    "voice": {},
    "interaction": {},
    "canon": {},
    "dialogue": { "positive": [], "negative": [] }
  },
  "opening": { "firstMessage": "Explicitly authored opening" }
}
```

Run a non-mutating preflight first:

```bash
bun run --filter @idream/main character-soul:import -- --file character-souls/<character>.json
```

Applying creates an immutable Content Version and Character Revision with audit
evidence. It deliberately does not create or publish a Release; behavior QA,
live canary, Release proposal, approval, and Publish remain explicit Admin
operations.

```bash
bun run --filter @idream/main character-soul:import -- \
  --file character-souls/<character>.json \
  --apply --actor-id <admin-id> --request-id <unique-id>
```

Before cutover, run `character-soul:audit`. It fails when the same-cluster read
views are absent or divergent, any serving/current/pinned snapshot cannot load,
or pinned-session drain metrics cannot be inspected.
