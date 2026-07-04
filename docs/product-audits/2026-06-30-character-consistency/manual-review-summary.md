# Character Consistency Manual Review

Date: 2026-06-30

Scope: local/internal beta image consistency smoke for a demo character using the Redcraft ComfyUI candidate profile.

Source artifacts at review time:

- `.tmp/redcraft-consistency-review/manifest.json`
- `.tmp/redcraft-consistency-review/manual-review.json`
- `.tmp/redcraft-consistency-review/contact-sheet.jpg`
- `.tmp/redcraft-consistency-review/sample-01.png` through `sample-20.png`

Result:

- Provider: `pipeline`
- Model: `redcraft-krea2-comfyui`
- Character: `Redcraft Consistency Candidate`
- Mode: `balanced`
- Seed mode: `locked`
- Orientation: `3:4`
- Samples: 20
- Pass threshold: 80%
- Manual same-character pass count: 17/20
- Consistency rate: 85%
- Verdict: pass for internal beta text-to-image text+seed consistency evidence.

Review notes:

- Failed or borderline samples: 10, 14, and 17.
- Main drift reasons: face shape, eye styling, expression, and softened identity traits.
- Locked seed materially improved text-to-image consistency compared with vary-seed samples.
- Reference-image identity conditioning should remain reserved for reference-capable profiles; the current default text-only profile should continue to rely on identity prompt plus seed.

Evidence limit:

This proves one local/internal beta model profile can pass a 20-sample manual same-character review. It does not prove public production model capacity, stronger face/IP adapter quality, or all future profiles.
