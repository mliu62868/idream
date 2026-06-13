# Ourdream.ai Page Topology

## Page Order
1. Age gate overlay, only when first-visit storage state requires it.
2. Root app shell.
3. Desktop sidebar, sticky and full-height.
4. Main content column.
5. Sticky top navigation with mobile menu/logo and auth actions.
6. Promo banner and discovery controls.
7. Category tabs.
8. Character grid with a promo card inserted into the flow.
9. Loading-more row.
10. Homepage SEO H1, metrics, FAQ, and Join Now CTA.
11. Full-width footer with Learn, Popular, Help, and legal/social columns.
12. Desktop promo toast at bottom right.
13. Mobile bottom navigation.
14. Catch-all static routes for all public sitemap URLs and linked utility pages.

## Layers
- Sidebar: sticky, `z-index: 30`.
- Top navigation: sticky, `z-index: 40`.
- Promo toast: fixed above content on desktop.
- Mobile bottom navigation: fixed at bottom.
- Age gate: fixed full-viewport overlay above the app content in the original site.
- Footer: full-width page flow below the sidebar/content shell.

## Components
- `OurdreamClone`: page assembly and responsive shell.
- `AppSidebar`: desktop navigation and upgrade footer.
- `TopControls`: sticky top bar, promo banner, search, filters, and category chips.
- `CharacterGrid`: grid wrapper, cards, promo insertion, loading state.
- `CharacterCard`: image card with scrim, title, metadata, and vivid badge.
- `PromoToast`: desktop bottom-right pride-sale card.
- `MobileBottomNav`: fixed mobile navigation.
- `AgeGate`: documented original overlay state.
- `HomeSeoSections`: homepage SEO H1, metric cards, FAQ cards, and CTA.
- `SiteFooter`: public footer link groups and social links.
- `OurdreamRoutePage`: shared shell plus route templates for sitemap coverage.

## Interaction Model By Section
- Age gate: click-driven on original site; documented but not used to bypass target.
- App shell: static.
- Sidebar: static navigation; hover background changes.
- Top controls: visual static controls; original dropdowns/search are click-driven.
- Category chips: click-driven active tab styling in original; clone renders default state.
- Character grid: hover-driven card movement/overlay.
- Promo toast: click-driven close in original; clone renders static.
- Mobile bottom navigation: static visual navigation.
- Footer: static link navigation with hover color transition.
- Catch-all routes: static templates; creator/generator/profile controls are visual-only.

## Public Route Coverage
- Sitemap discovery date: 2026-06-13.
- Public sitemap count: 142 URLs.
- Additional linked utility routes covered: `/terms`, `/helpdesk`, `/feed`, `/community`, `/profile`, `/login`, `/signup`.
- Safety Center mirror routes covered: 16 local `/safety/*` paths.
- Newly discovered sitemap guides on 2026-06-13: `/guides/character-cards`, `/guides/character-hub-ai`, `/guides/janitor-ai-images-first-message`, `/guides/character-card-creator`, `/guides/sillytavern-setup-guide`.
- Route templates: marketing, create, generator, library, article, comparison, profile, terms, upgrade.
- Disallowed by robots and intentionally not cloned as real backend routes: `/api`, `/chat/` subpaths, `/c/`, `/signup/1`.
