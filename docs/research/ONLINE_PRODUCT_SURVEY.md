# Ourdream Online Product Survey

Target: `https://ourdream.ai/`

Survey date: 2026-06-13

Tooling:

- Chrome extension browser automation session: `ourdream-product-docs`
- Sitemap fetch: `curl https://ourdream.ai/sitemap.xml`
- Robots fetch: `curl https://ourdream.ai/robots.txt`
- Local build verification: `npm run build`
- Detailed notes: `docs/research/CHROME_PRODUCT_EXPLORATION.md`

## Verification Summary

- `https://ourdream.ai/sitemap.xml` is reachable with 142 entries and currently reports sitemap entries last modified at `2026-06-13T06:03:58.659Z`.
- `robots.txt` allows `/` and disallows `/api`, `/chat/`, `/c/`, and `/signup/1`.
- The local clone builds successfully with Next.js `16.2.1`, generating `/`, `_not-found`, and 164 static dynamic paths under `/[...slug]`.
- Chrome route sweep completed 149 URLs: all 142 sitemap URLs plus `/terms`, `/helpdesk`, `/feed`, `/community`, `/profile`, `/login`, and `/signup`.
- Direct Chrome navigation to `sitemap.xml` was blocked by the active browser environment with `ERR_BLOCKED_BY_CLIENT`; the route list was fetched with `curl`, while page and interaction inspection used Chrome.

## Sampled Routes

| Path | HTTP | Online title | Key visible backend surfaces |
| --- | ---: | --- | --- |
| `/` | 200 | `ourdream.ai | Unlimited AI Roleplay Platform` | Age gate, Explore search, sort, gender/style/age filters, category chips, character cards, promo, FAQ, footer |
| `/create` | 200 | `Create Your Perfect AI Companion | ourdream.ai` | Multi-step creator wizard: gender/style, appearance, hair, body, name, tag manager, preview generation, final create CTA |
| `/generate` | 200 | `NSFW AI Image and Video Generator | ourdream.ai` | Image/Video modes, mode presets, character selector, background/pose/outfit preset dialogs, premium custom prompt, advanced settings, Images/Videos/Liked gallery, filter/manage actions |
| `/custom` | 200 | `Manage Your Dream AI Characters | ourdream.ai` | Recent, Characters, Group Chats, Packs, Presets, Created tabs, search |
| `/upgrade` | 200 | `Upgrade Your ourdream.ai Subscription` | Subscription purchase surface |
| `/terms` | 200 | `Terms & Policies | ourdream.ai` | Terms index, policy links, support contact |
| `/helpdesk` | 200 | `Help Desk | ourdream.ai` | Support/Bugs/Features/Changelog tabs; Bugs/Features/Changelog are premium-gated |
| `/feed` | 200 | `AI Porn Gif | ourdream.ai` | Feed cards with Chat, Remix, Like, More options; More menu exposes Share and Report |
| `/community` | 200 | `Community Leaderboard | ourdream.ai` | Banner carousel, Dreamers/Characters/Collections tabs, Featured/Top leaderboard, release/gender/style filters |
| `/comparison` | 200 | `Compare AI Girlfriend Platforms | ourdream.ai` | Comparison page, auth CTAs, shared app navigation |
| `/resources-hub` | 200 | `The Hub | ourdream.ai` | Category hub, auth CTAs, shared app navigation |
| `/profile` | 200 | `Go To Your Ourdream Profile` | Logged-in account settings, dreamcoin balance, subscription, redeem code, referral program, preferences/notifications, language, legal, account management |
| `/login` | 200 | `Log in to ourdream.ai` | Google and email login choices, Terms agreement |
| `/signup` | 200 | `Sign up to ourdream.ai` | Google and email signup choices, free dreamcoin offer, Terms agreement |

## Important Deltas Versus Current Clone

- The current local clone routes `/feed` and `/community` through a profile-like static template, but the online pages expose richer backend surfaces:
  - `/feed`: content feed cards with Chat, Remix, Like, Share, and Report.
  - `/community`: banner carousel, Dreamers leaderboard, Featured/Top sections, profile metrics, and release/gender/style filters.
- The online DOM includes the age gate controls (`I'm over 18`, `Terms`, `Leave site`) together with page content. The production backend/front-end implementation should treat age confirmation as a real access-control state, not just as a cosmetic overlay.
- `/create` is a wizard, not a single flat form. It separates initial gender/style, appearance choices, naming, optional advanced details, tags, preview generation, and final creation.
- `/generate` exposes Image/Video modes, built-in/user/community preset scopes, premium prompt/model gates, Images/Videos/Liked gallery states, Filter, and Manage actions. These map directly to generation jobs, preset ownership, media asset type, user ownership, and liked state.
- `/custom` exposes user library tabs that should be backed by separate query scopes: recent sessions, characters, group chats, packs, presets, and created items.
- `/profile` in an authenticated Chrome session exposes dreamcoin balance, subscription, redeem code, referral rewards, preferences/notifications, language, legal, account management, and sign-out.
- `/terms` has a broader policy index than the local static route should eventually represent, including prohibited content, moderation, screening, complaints, underage, AML/anti-fraud, and trafficking policies.
- `safety.ourdream.ai` adds the operational policy source: age verification, moderation layers, appeals, reporting, safety tools, privacy summary, and contact paths.
- The sitemap gained five guide URLs since the earlier route doc: `/guides/character-cards`, `/guides/character-hub-ai`, `/guides/janitor-ai-images-first-message`, `/guides/character-card-creator`, and `/guides/sillytavern-setup-guide`.

## Backend-Relevant Controls Observed

| Surface | Controls | Backend implication |
| --- | --- | --- |
| Age gate | `I'm over 18`, Terms link, Leave site | Store age-gate acceptance, block adult routes before confirmation, provide legal fallback links |
| Explore | Search input, Popular/Month sort label, For You/Popular/Newest/Following menu, gender/style/age filters, category chips | Character search index, filter facets, sort state, pagination cursor |
| Character cards | Character click targets, likes, chats, creator handle | Character detail route, stats counters, creator relation, authenticated chat start |
| Create | Multi-step wizard, tag manager, preview generation, final create CTA | Draft persistence, preview job, validation, character creation, moderation queue |
| Generate | Image/Video, presets, character selector, background/pose/outfit, premium custom prompt, advanced settings, Images/Videos/Liked, Filter, Manage | Generation jobs, preset service, media asset gallery, liked state, ownership, moderation and quota checks |
| My AI | Recent, Characters, Group Chats, Packs, Presets, Created, search | User library service and tab-specific queries |
| Feed | Chat, Remix, Like, Share, Report | Feed cursor, recommendation state, interaction counters, remix flow, reports |
| Community | Banner carousel, Dreamers/Characters/Collections, Release/Gender/Style filters | Leaderboards, creator profiles, public character index, collection index |
| Upgrade | Monthly/yearly Premium and Deluxe plan cards, dreamcoin/media/voice quotas | Checkout, entitlement sync, dreamcoin ledger |
| Profile | Balance, subscription, redeem code, referral, preferences, language, account management | Account settings, referral rewards, localization, billing/account APIs |
| Terms/Safety | Policy links, reporting, complaints, age verification, moderation layers, appeals | Trust and safety workflow, reports, appeals, takedowns, compliance logs |

## Build Baseline

`npm run build` completed successfully on 2026-06-13:

- Framework: Next.js `16.2.1`
- Static root route: `/`
- Static catch-all route: `/[...slug]`
- Generated static pages: `168`
