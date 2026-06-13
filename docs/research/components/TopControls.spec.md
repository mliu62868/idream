# TopControls Specification

## Overview
- **Target file:** `src/components/ourdream/TopControls.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`, `docs/design-references/ourdream-mobile-390.png`
- **Interaction model:** static visual controls; original controls are click-driven

## DOM Structure
- Sticky top nav with logo/menu area and auth actions.
- Desktop control row: sort pill, search field, filter pills.
- Mobile: promo banner first, compact sort pill and categories.
- Category chip row below filters.

## Computed Styles
### Topbar Wrapper
- width: `1220px`
- height: `56px`
- position: `sticky`
- zIndex: `40`
- transition: `transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)`

### Topbar
- backgroundColor: `rgba(13, 13, 13, 0.6)`
- width: `1220px`
- height: `56px`

### Filter Pills
- fontSize: `12px`
- fontWeight: `500`
- fontFamily: `neue-haas-grotesk-text, sans-serif`
- lineHeight: `16px`
- color: `rgb(255, 255, 255)`
- backgroundColor: `rgb(53, 53, 54)`
- height: `36px`
- padding: `0px 12px 0px 16px`
- borderRadius: `9999px`
- gap: `8px`

### Category Chips
- active chip backgroundColor: `rgb(46, 46, 46)`
- inactive chip color: `rgb(170, 170, 170)`
- padding: `12px`
- height: `36px`
- borderRadius: `9999px`

## States & Behaviors
- Search placeholder: `Try 'Busty blonde' or 'Petite asian'`.
- Active category is `All`.
- Buttons transition color/background/border/fill/stroke over `0.15s cubic-bezier(0.4, 0, 0.2, 1)`.

## Assets
- Mobile/desktop promo banner: `public/images/ourdream/pride-banner-female.webp`

## Text Content
Login, Join Free, Popular - Month, Female, Any Style, Any Age, All, Group Chats, MILF, Teen, Asian, Latina, Blonde, Busty, Submissive, Dominant, BDSM, Romantic, Slow Burn, Athletic, Caring.

## Responsive Behavior
- Desktop: sidebar offset leaves topbar at `x: 220`.
- Mobile: sidebar hidden, header full width, promo banner visible, horizontal controls scroll.
