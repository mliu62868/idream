# Ourdream Chrome Product Exploration

Target: `https://ourdream.ai/`

Date: 2026-06-13

Tooling:

- Chrome extension browser automation against the live site.
- Sitemap route list from `curl https://ourdream.ai/sitemap.xml` because Chrome blocked direct `sitemap.xml` navigation with `ERR_BLOCKED_BY_CLIENT`.
- Scope: 142 sitemap URLs plus `/terms`, `/helpdesk`, `/feed`, `/community`, `/profile`, `/login`, and `/signup`.

## Exploration Notes

- Chrome route sweep completed 149 public URLs. Initial timeouts on video category pages were retried successfully and mapped to the same video-category template.
- Exploration stayed read-only. Age-confirmation controls were recorded but not clicked.
- Profile was visible in the active Chrome session. Account identifiers were intentionally excluded from this document.
- Adult roleplay and generation pages were documented at the product-surface level only; explicit scenario/body copy is not reproduced here.

## Product Surface Map

| Surface | Chrome-observed controls | Product implication |
| --- | --- | --- |
| Global shell | Sidebar: Create, Explore, Chat, Generate, My AI, Feed, Community, Help Desk, Safety Center, Discord, More, Profile, Upgrade; notification button; footer company/legal/social links | Shared app shell, active-route state, external-link handling, account and upgrade entry points |
| Explore `/` | Promo card, search, sort button, gender/style/age filters, category chips, clickable character cards, stats, creator handles, Vivid badges, FAQ/footer | Character catalog, search index, filter facets, ranking, card click target, stats counters, promotion campaign |
| Create `/create` | Wizard: Gender, Style, appearance/race, hair, body, name, optional advanced details, tag manager, Appearance/Personality sections, preview image generation, final `Bring Your AI To Life` CTA | Draft persistence, wizard state, tag taxonomy, preview job, final create/submit workflow, moderation |
| Generate `/generate` | Image/Video modes, Mode Presets, character selector, background/pose/outfit preset dialogs, premium custom prompt, advanced settings, Images/Videos/Liked gallery, Filter, Manage, Like, disabled generate until character selection | Generation jobs, preset libraries, premium gates, media gallery, liked state, bulk selection, entitlement and quota checks |
| My AI `/custom` | Search, Recent, Characters, Group Chats, Packs, Presets, Created tabs, empty state with Create CTA | User library service with tab-specific scopes and empty/loading states |
| Feed `/feed` | Content cards with Chat, Remix, Like, More options; More menu exposes Share and Report | Recommendation/feed cursor, chat launch, remix-to-create/generate flow, likes, sharing, reports |
| Community `/community` | Banner carousel, Dreamers/Characters/Collections tabs, Featured block, Top leaderboard, Release/Gender/Style filters | Creator/character/collection leaderboards, carousel campaigns, ranking windows, public profile metrics |
| Upgrade `/upgrade` | Monthly/Yearly billing tabs, Premium and Deluxe plan cards, Subscribe CTA, benefits and dreamcoin quotas | Plan catalog, checkout, subscription state, entitlements, dreamcoin ledger |
| Login/Signup | Continue with Google, Continue with email, Terms agreement, signup free-dreamcoin offer | Auth providers, email auth flow, age/terms attestation, signup bonus ledger |
| Profile `/profile` | Account settings, dreamcoin balance, subscription, redeem code, referral program, preferences/notifications, language, support/legal/account management, sign out | Account settings, referral/reward ledger, profile routes, localization, account deletion/support flows |
| Help Desk `/helpdesk` | Support, Bugs, Features, Changelog tabs; Discord/FAQ links; Premium gate for Bugs/Features/Changelog | Support hub, product feedback/voting, premium-gated roadmap/changelog access |
| Terms `/terms` | Policy index: terms, privacy, refund, prohibited content, removal, moderation, screening, complaint, 2257 exemption, underage, AML/anti-fraud, trafficking | Legal/policy routing, trust links, compliance surface |
| Safety Center | Policies, moderation, reporting, safety tools, privacy, contact docs on `safety.ourdream.ai` | Trust & Safety policy source, reporting categories, moderation layers, appeal and contact flows |
| SEO hubs | Resources hub, type index, videos index, games, romantasy, comparison, guides, generator pages, affiliate | Long-tail acquisition, topic hubs, comparison pages, content operations |

## Explore Details

Observed controls:

- Sort label: `Popular · Month`; open menu exposes `For You`, `Popular`, `Newest`, `Following`.
- Gender filter: `Any Gender`, `Female`, `Male`, `Trans`.
- Style filter: `Any Style`, `Realistic`, `Anime`.
- Age filter: `Any Age`, `Teen`, `Young Adult`, `Adult`, `Mature`.
- Category chips include group chat, romance, fantasy/species, style/body, relationship-dynamic, and roleplay themes.
- Character cards are pointer-clickable DOM cards rather than stable anchor links in the observed view. They expose name/age, scenario summary, likes, chat counts, creator handle, image, and occasional Vivid badge.

Backend impact:

- Card click should resolve through a stable character id to either a detail page or chat-start route.
- Filters need URL/state serialization because Chrome showed UI state but not stable `href` contracts.
- The age facet must be policy-aware: labels such as `Teen` must be treated as 18+ young adult semantics only.

## Create Details

Chrome observed `/create` as a multi-step wizard:

1. Initial choice: `Female`, `Male`, `Trans`; `Realistic`, `Anime`; optional `Design with AI`; `Begin`.
2. Appearance/race options: human and fantasy categories, plus `Custom`.
3. Hair options: style and color choices, plus `Custom`.
4. Body options: body type and body-feature choices.
5. Name step with generated default name and `Advanced Details (optional)`.
6. Final creation screen: tag manager, `Appearance`, `Personality`, preview generation state, and `Bring Your AI To Life`.

Backend impact:

- Treat the creator as a draft wizard, not a single static form.
- Persist partial selections before final submit.
- Preview image generation can start before final character creation, so preview jobs should be separable from character records.
- Public or shared output needs moderation before publication; private drafts still need input moderation before chat/generation use.

## Generate Details

Observed generator controls:

- Modes: `Image`, `Video`.
- Mode Presets dialog: `Presets` and `Image Edit`.
- Character selector dialog: search, filters, `Freeplay`, and public characters.
- Background preset dialog: categories such as `All`, `My Presets`, `Community`, environment categories, `Custom`, and `Create a Preset`.
- Pose preset dialog appears in Image mode only and groups pose presets by broad categories such as solo/group/body-focus/suggestive/action categories.
- Outfit preset dialog includes `All`, `My Presets`, `Community`, clothing-category tabs, `Custom`, and `Create a Preset`.
- Custom Prompt opens an upgrade modal for non-entitled users.
- Advanced Settings include style/model choice, premium/experimental model options, premium negative prompt, orientation ratios, and number-of-images choices from `2` through `256`.
- Gallery has `Images`, `Videos`, `Liked`, `Filter`, `Manage`, per-asset `Like`, and manage mode with select-all behavior.
- Generate CTA remains disabled with `Select a character first` until a character is selected.

Backend impact:

- Generation payload must support mode, character id, prompt, presets, custom preset ids, model/style, orientation, count, and premium-only negative prompt.
- Video mode has a different control schema from image mode.
- Presets need ownership/source scope: built-in, user-owned, and community.
- Entitlement checks must be server-side; the client premium modal is only UX.

## Feed And Community Details

Feed:

- Repeating feed item cards expose Chat, Remix, Like, and More options.
- More options menu includes Share and Report.
- Feed should support cursor/recommendation state and a report path for every item.

Community:

- Top banner carousel has previous/next controls and dot navigation.
- Tabs are Dreamers, Characters, and Collections. Dreamers list was fully visible; Characters/Collections tabs existed but list content was not reliably readable in the Chrome session.
- Dreamers view includes Featured and Top sections, profile links, role/status badges, follower counts, character/content counts, and interaction counts.
- Filters: Release (`Last 30 Days`, `All Time`), Gender (`Any`, `Female`, `Male`, `Trans`), Style (`Any`, `Realistic`, `Anime`).

Backend impact:

- Community should be modeled as leaderboard queries by entity type, release window, gender, and style.
- Feed item actions require auth-aware optimistic UI plus server-side like/share/report tracking.

## Subscription Details

Observed plans:

| Plan | Monthly | Yearly view | Observed benefits |
| --- | ---: | ---: | --- |
| Premium | `$19.99/mo` | `$9.99/mo`, billed `$119.88` yearly, bonus coins | 1,000 dreamcoins/month, 200 images, 20 minutes voice calls, 10 videos, unlimited messages, unlimited audio messages, image/video generation, voice calls, publish characters |
| Deluxe | `$59.99/mo` | `$29.99/mo`, yearly bonus coins | Premium chat models, 3x chat memory, 5,000 dreamcoins/month, 1,000 images, 100 minutes voice calls, 50 videos, unlimited messages/audio, image/video generation |

The Premium custom prompt gate in Generate reused the same upgrade modal and plan catalog.

## Safety And Policy Details

Safety Center pages observed:

- Prohibited content: minors/underage, real people, existing IP, non-consent/removal of agency, family/incest, bestiality, extreme/gore/violence categories, extremist/self-harm/eating disorder/hate/religious/political/illegal/evasion categories.
- Age verification: standard signup, identity-verification triggers, Go.cam flow, jurisdictional requirements, stored verification information, re-verification, suspected underage reporting.
- Moderation: input, output, metadata/behavior, human review, community reports, appeals.
- Rejection reasons: underage persona cues, real person likeness, existing IP, non-consent framing, family relationship, minimum-field failures, flagged profile image, non-English hidden content, duplicate bad-faith resubmissions.
- Reporting: in-product report, email reporting, suspected minors, own likeness, DMCA/copyright, moderator decision, security issues, regulator escalation.
- Account safety tools: mute tags, delete chat message, report problem, account controls, wellbeing resources.
- Privacy: data collected/not collected, chat visibility, media visibility, third parties, rights, children, changes.

Backend impact:

- Safety events need policy codes, moderation layers, appeal paths, and separate report categories.
- Age gate acceptance is not enough for all jurisdictions; identity verification provider state should be modeled separately.
- Feed, media, character, user profile, chat message, and moderator decision should all be reportable target types.
