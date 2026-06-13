# Ourdream.ai Behaviors

Target: `https://ourdream.ai/`

Inspection date: 2026-06-13

## Global
- App shell is a dark, fixed-sidebar dashboard.
- Body background computed at `rgb(13, 13, 13)`.
- Primary shell font computed as `geist, ui-sans-serif, system-ui`; controls and card copy use `neue-haas-grotesk-text, sans-serif`.
- Root class includes `dark`; no light theme was observed.
- Desktop body scroll height: `4267px` at `1440x1000`.
- Mobile body scroll height: `6870px` at `390x844`.
- No scroll snap or smooth-scroll library was observed.
- Follow-up Chrome check at `1291x803` showed the current target homepage at approximately `2456px` scroll height including SEO FAQ and footer; clone should use natural page height rather than fixed oversized min-heights.

## Age Gate
- In a normal browser session the first visible state is an age gate.
- The gate is static HTML and appears before app content when `data-content-gate-pending` is set.
- The accept button writes `AdultContentAcceptedOD=true` to local storage and removes the gate.
- Browser safety note: the gate was not clicked during extraction.

## Desktop Layout
- Left sidebar is sticky at top with `width: 220px`, `height: 1000px`, `z-index: 30`.
- Sidebar panel background is `rgb(18, 18, 18)`, border radius `0 24px 24px 0`, padding `8px 0 16px`.
- Top nav is sticky with `height: 56px`, `z-index: 40`, and background `rgba(13, 13, 13, 0.6)` with backdrop blur.
- Content grid starts around `x: 280`, `y: 192`, width `1100px`.
- Grid uses 5 columns at desktop: `210.391px 210.406px 210.391px 210.406px 210.391px`; gap `12px`.

## Mobile Layout
- Sidebar is hidden.
- Header becomes a compact mobile rail with a menu icon.
- Promo banner is visible at top and spans the viewport width.
- Character grid starts around `x: 8`, `y: 243`, width `374px`.
- Mobile grid uses 2 columns: `183px 183px`; gap `8px`.
- Bottom navigation is fixed visually at the viewport bottom with Explore, Chat, Create, and Generate actions.

## Interactions
- Character cards have `cursor: pointer` and transition `transform 0.2s cubic-bezier(0, 0, 0.2, 1)`.
- Card hover behavior: slight visual lift/scale and image overlay fade were observed in markup via paired image layers with `opacity: 0` and `transition: all 0.2s ease-out`.
- Pill controls and filter chips use hover/click color transitions: `color/background/border/fill/stroke 0.15s cubic-bezier(0.4, 0, 0.2, 1)`.
- Promo toast has a dismiss affordance; for clone scope it is rendered static.
- Filters/search are visual-only in this clone; no backend state or auth flows are implemented.
- Public sitemap routes are rendered as static visual templates. Controls on generator, creator, profile, pricing, and article pages are non-persistent demo states.
- Footer/internal links navigate to cloned local pages; external Help, Safety, Discord, Reddit, and X links retain original external destinations.
