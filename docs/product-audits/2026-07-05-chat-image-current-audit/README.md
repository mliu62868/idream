# Chat Image Current Audit

Date: 2026-07-05

Scope: current signed-up user flow for character-detail Chat image generation attachments, More-like-this variation, Generate handoff, dreamcoin spend, persistence evidence, and cleanup.

## Result

Pass after fix. Chrome reproduced one real product bug: a completed chat image attachment with an unusable white/blank preview rendered as a successful image in Chat, while Generate/Gallery already showed `Preview unavailable`. Chat now uses the same bad-preview fallback behavior, keeps `More like this` and `Open in Generate`, and does not show an empty successful preview.

## Chrome Path

- Started from `/signup?next=/characters/melissa-burke`.
- Signed up `chrome-chat-image-1783270000000@test.local`.
- Returned to Melissa Burke, opened Chat, and created session `sess_858ab1ed8e0e4e629afbfdf5bd0993f1`.
- Sent `Please make an image from this chat moment 1783270000000`.
- Verified the Chat attachment first entered `Generating image`.
- Verified completion persisted the attachment, cost 5 dreamcoins, and exposed More-like-this plus Open in Generate.
- Clicked `More like this`; a `media_variation` job queued and the user-visible status said `Variation queued. It will appear in Generate and Gallery.` with polite live status semantics.
- Clicked `Open in Generate`; landed on `/generate?characterId=melissa-burke`, the character selector stayed on Melissa, Active Jobs showed both completed jobs, Gallery showed both media cards as `Preview unavailable`, and balance was 240.
- Reloaded Chat after the fix and verified `Image unavailable` / `Preview unavailable` fallback in the chat attachment, with actions still available.

Browser warning/error logs were `[]` after the fix. No horizontal overflow was observed in the checked Chat and Generate states.

## Evidence

- `01-signup-character-return.png`: signup form with preserved character-detail return.
- `02-character-after-signup.png`: returned Melissa Burke detail page.
- `03-chat-session-ready.png`: created Chat session with composer ready.
- `04-chat-after-image-request.png`: generating image attachment state.
- `05-chat-image-completed.png`: pre-fix bug evidence, blank completed image rendered as success.
- `06-chat-more-like-this-queued.png`: variation queued status in Chat.
- `07-open-in-generate.png`: Generate handoff, selected character, active jobs, Gallery fallback cards, balance 240.
- `08-chat-image-fallback-after-fix.png`: fixed Chat fallback state.
- `chrome-evidence.json`: Chrome URL, UI state, action, and log evidence.
- `db-evidence-before-cleanup.json`: persisted user, ledger, jobs, media, chat attachment, and event evidence.
- `db-cleanup.json`: disposable user/session/blob/Redis cleanup evidence.

## Persistence Summary

- User: `cmr7pd2yv0000lhl78wbfcoic`, `chrome-chat-image-1783270000000@test.local`.
- Ledger: signup `+250`, chat image spend `-5`, More-like-this spend `-5`, final balance 240.
- Generation jobs: 2 completed jobs, `chat_image` and `media_variation`, both cost 5.
- Media assets: 2.
- Chat session: 1 session, 2 messages, 1 completed image attachment.
- Chat/main eventing: outbox 4, inbox 2.

## Cleanup

The disposable main user, chat session, messages, attachments, blob objects, and Redis prefix were removed. Final cleanup evidence shows `remainingUser=0`, `remainingChatSessions=0`, `remainingChatAttachments=0`, removed blob count `2`, and Redis `finalRemaining=0`. Dev servers on ports 3274 and 3275 were stopped, and the Chrome audit tabs were finalized.

## Verification

```bash
PW_BASE_URL=http://127.0.0.1:3274 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "chat UI opens Generate with character context and renders chat image attachments"
bun run --cwd packages/main lint
bun run --cwd packages/main typecheck
```

All three commands passed.

## Limitation

This was a local current-state audit using the configured local generation path. The provider output itself can still be intentionally minimal in this environment; the product requirement checked here is that Chat, Generate, billing, eventing, persistence, and fallback behavior remain coherent for usable and unusable previews.
