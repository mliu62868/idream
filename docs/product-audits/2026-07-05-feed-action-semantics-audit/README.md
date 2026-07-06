# Feed Action Semantics Audit

Date: 2026-07-05

Scope: Chrome verification for Feed card action semantics.

## Finding

Before the fix, every Feed card action button exposed `aria-pressed="false"`. That was correct for the Like toggle, but incorrect for one-shot actions such as Chat, Remix, Share, and Report. Assistive technology could present those actions as inactive toggle buttons instead of ordinary commands.

## Fix

`FeedWorkspace` now separates visual active state from pressed-state semantics:

- Like keeps `aria-pressed="false"` / `true` because it is a toggle.
- Chat, Remix, Share, and Report omit `aria-pressed` because they are commands.

The existing Feed E2E now guards both behaviors.

## Evidence

- `01-current-feed-actions-toggle-semantics.png`: pre-fix Feed card action state.
- `current-chrome-evidence.json`: pre-fix DOM evidence showing all five action buttons with `ariaPressed="false"`.
- `02-fixed-feed-actions-button-semantics.png`: post-fix Feed card action state.
- `fixed-chrome-evidence.json`: post-fix DOM evidence showing only Like retains `ariaPressed="false"`.
- `fixed-console-logs.json`: post-fix Chrome warning/error log capture, `[]`.
