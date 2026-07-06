# 2026-07-04 Public Surface Current E2E

## Scope

Adversarial PM verification of the current public/first-touch surface after the core-flow proof.

This pass covers:

- Public route smoke for product, content, policy, help, account shell, and catch-all marketing routes.
- Chrome visual/DOM audit of `/`, `/resources-hub`, `/helpdesk`, `/terms`, `/safety/introduction`, and `/profile/account-management`.
- Chrome Help Desk support request submission from the live UI.
- Full isolated Playwright UI workflow regression.
- Full isolated Playwright admin web regression.

## Automated E2E

Commands and results:

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3210 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun --cwd packages/main playwright test src/e2e/public-routes.e2e.ts
# 47 passed (19.5s)
```

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3212 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun --cwd packages/main playwright test src/e2e/ui-workflows.e2e.ts
# 56 passed (1.8m)
```

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3213 PW_ADMIN_BASE_URL=http://127.0.0.1:3005 bun --cwd packages/main playwright test src/e2e/admin-web.e2e.ts
# 25 passed (34.7s)
```

Targeted reruns before the final full suites:

- `ui-workflows.e2e.ts` failed on two broad `Join Free` locators and one non-isolated Image Edit queue timeout. The two locators were scoped to `header`; Image Edit passed under isolated `PW_WEBSERVER=1`.
- `admin-web.e2e.ts` failed on broad `Reason` / `Confirmation` locators after the Support plaintext panel added similarly named controls. Confirmation-dialog locators were narrowed to exact textbox roles, then the support test and full admin suite passed.

## Chrome Evidence

Server:

- Main: `bun run dev -- --port 3211` from `packages/main`.
- Admin was not needed for this Chrome public-surface pass.

Pages:

- `/`
- `/resources-hub`
- `/helpdesk`
- `/terms`
- `/safety/introduction`
- `/profile/account-management`

Chrome DOM checks across the six captured pages:

- `brokenImages=[]`.
- `horizontalOverflow=false`.
- no visible empty links.
- no external links without `target="_blank"`/`rel="noopener noreferrer"` marker in the sampled link set.
- console warnings/errors from `tab.dev.logs({ levels: ["error", "warning"] })` were `[]`.

Home timing note:

- The first full-page capture at `domcontentloaded` still showed `Loading more characters...`.
- A second Chrome poll after 3 seconds showed `characterLinkCount=16`, `loadingTextPresent=false`, and loaded character card images. The settled screenshot is `screenshots/home-after-3s.png`.

Help Desk submission:

- Filled signed-in support subject and details.
- Submit button was disabled before required fields and enabled after fill.
- Final UI showed `Support request SUP-VAUVQYM4DP received.`
- Chrome console warnings/errors remained `[]`.

Screenshots:

- `screenshots/home.png` - early home capture before dynamic character cards settled.
- `screenshots/home-after-3s.png` - settled home with character cards.
- `screenshots/resources-hub.png` - resource hub grid and footer.
- `screenshots/helpdesk.png` - help desk support/appeal/roadmap UI.
- `screenshots/helpdesk-support-submitted.png` - submitted support request with reference.
- `screenshots/terms.png` - policy index and account/support links.
- `screenshots/safety-introduction.png` - safety center nav and content.
- `screenshots/profile-account-management.png` - authenticated account management shell.

## Limitations

- Chrome used the current local profile, which was already authenticated as a disposable audit user. Anonymous first-visit and signup-return behavior is covered by Playwright and earlier Chrome audits, not by these public-surface screenshots.
- This remains local/internal beta evidence. It does not remove the separate production-provider launch blockers for real payment, blob storage, age verification provider, production secrets, Sentry, or live production probes.
