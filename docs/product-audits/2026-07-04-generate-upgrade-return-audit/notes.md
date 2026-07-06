# Generate Upgrade Return Audit

Date: 2026-07-04

## Scope

Chrome audit of the logged-in low-balance Generate -> Upgrade -> return-to-Generate revenue loop using `/generate?characterId=lola-moonstruck`.

## Finding

Before the fix, a logged-in user with 0 dreamcoins saw `Get coins` link to bare `/upgrade`. After demo Premium activation, `Start generating` linked to bare `/generate`, so the user lost the selected Lola context and returned to the default Melissa generator.

## Fix Verified

- Generate low-balance and Premium-control upgrade links now carry `returnTo=/generate?characterId=lola-moonstruck`.
- Upgrade sanitizes `returnTo` through the existing internal auth redirect allowlist and falls back to `/generate` for invalid values.
- Anonymous checkout signup intent preserves non-default `returnTo`.
- Upgrade success `Start generating` returns to the original Generate query.
- Generate form controls now expose stable `id`/`name` attributes; clean Chrome reload showed `missingIdAndName: []`.

## Chrome Evidence

- `screenshots/01-low-balance-before.png`: pre-fix low-balance link dropped query context.
- `screenshots/02-upgrade-after-get-coins-before.png`: pre-fix naked `/upgrade`.
- `screenshots/03-upgrade-success-before.png`: pre-fix success CTA linked to `/generate`.
- `screenshots/04-returned-generate-before.png`: pre-fix returned to Melissa.
- `screenshots/05-low-balance-after.png`: fixed low-balance link keeps Lola `returnTo`.
- `screenshots/06-upgrade-success-after.png`: fixed success CTA points to Lola Generate URL.
- `screenshots/07-returned-generate-after.png`: fixed final return keeps Lola selected, 1,500 coins, unlocked prompts, and enabled Generate.

Chrome console after clean dev-server restart: no `error`, `warn`, or `issue` messages.

## Regression Coverage

```bash
PW_BASE_URL=http://127.0.0.1:3128 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "generator UI blocks insufficient-balance|upgrade signup redirect returns|upgrade UI activates Premium"
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
```

Result: focused E2E 3/3 passed; lint passed; typecheck passed.
