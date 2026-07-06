# Profile / My AI IA Audit

Date: 2026-07-04

## Scope

Adversarial information-architecture pass for the overlapping signed-in account surfaces:

- `/custom` as the My AI library destination
- `/profile` as the Profile/account destination
- `/profile#billing` as the signed-out account deep-link entry point
- My AI library tab selected-state semantics

## Finding

The product intentionally shares one workspace implementation across My AI and Profile, but the visible page language did not match the selected destination:

- `/profile` had Profile metadata and Profile sidebar current-state, but the H1 still said `My AI`.
- The signed-out `/profile#billing` card said `Sign in to open My AI`, even though the route and next target were Profile/account oriented.
- Library tab buttons had visual selected states, but did not expose the selected state to assistive technology.

This was not a data or routing bug, but it made the account/profile path feel like the user had landed in the wrong destination.

## Fix

- `ProfileWorkspace` now receives the resolved route path from `OurdreamRoutePage`.
- `/custom*` keeps `My AI` heading and My AI signed-out copy.
- `/profile*` now shows `Profile`, including the signed-out auth card.
- The signed-out Profile card still preserves safe deep-link targets such as `/profile#billing` through login/signup.
- My AI/Profile library section buttons now expose `aria-pressed` for the active tab.

## Chrome Evidence

Chrome verified the flow on `http://127.0.0.1:3148`:

| Step | Route / state | Expected | Observed | Console warnings/errors | Screenshot |
| --- | --- | --- | --- | --- | --- |
| 1 | Signed-in `/custom` | My AI destination | H1 `My AI`, sidebar current `My AI`, `recent` `aria-pressed=true` | `[]` | `screenshots/01-custom-my-ai-heading.png` |
| 2 | Signed-in `/custom`, group chats selected | My AI tab state announced | H1 `My AI`, sidebar current `My AI`, `group chats` `aria-pressed=true` | `[]` | `screenshots/02-custom-group-chats-selected.png` |
| 3 | Signed-in `/profile` | Profile destination | H1 `Profile`, sidebar current `Profile`, title `Profile | ourdream.ai` | `[]` | `screenshots/03-profile-heading.png` |
| 4 | Signed-out `/profile#billing` | Profile auth card with preserved return target | H1 `Profile`, auth heading `Sign in to open Profile`, login `/login?next=%2Fprofile%23billing`, signup `/signup?next=%2Fprofile%23billing` | `[]` | `screenshots/04-profile-signed-out-auth-card.png` |

Chrome DOM health for all captured states:

- `is404=false`
- `brokenImages=[]`
- `<main>` present
- Saved screenshots were visually inspected before accepting the evidence

## Verification

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3146 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "account shell routes expose"
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3147 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "profile prompts anonymous|profile subroutes deep-link|my ai shows deferred"
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
```

All commands passed.
