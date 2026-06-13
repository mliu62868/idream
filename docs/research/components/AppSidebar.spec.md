# AppSidebar Specification

## Overview
- **Target file:** `src/components/ourdream/AppSidebar.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`
- **Interaction model:** static with hover states

## DOM Structure
- Sticky sidebar container.
- Rounded dark panel with logo row.
- Primary nav group: Create, Explore, Chat, Generate, My AI, Feed, Community.
- Secondary nav group: Help Desk, Safety Center, Discord, More.
- Footer group: Profile, Upgrade button, legal lines.

## Computed Styles
### Container
- width: `220px`
- height: `1000px`
- display: `flex`
- position: `sticky`
- top: `0px`
- z-index: `30`

### Panel
- backgroundColor: `rgb(18, 18, 18)`
- padding: `8px 0px 16px`
- width: `220px`
- height: `1000px`
- display: `flex`
- flexDirection: `column`
- borderRadius: `0px 24px 24px 0px`
- overflow: `hidden`

### Text
- primary shell font: `geist, ui-sans-serif, system-ui`
- small labels: `12px`, `line-height: 16px`
- active background: `rgb(46, 46, 46)`
- muted text: `rgb(170, 170, 170)`

## States & Behaviors
- Active nav item is Explore.
- Hover nav items use raised surface color around `rgb(46, 46, 46)`.
- Upgrade button uses gradient `linear-gradient(0deg,#ff1cac,#fd5fc2 50%,#ff79d1)`.

## Assets
- Logo: `public/images/ourdream/ourdream-logo.svg`

## Text Content
Create, Explore, Chat, Generate, My AI, Feed, Community, Help Desk, Safety Center, Discord, More, Profile, Upgrade, 2026 OURDREAM.AI, USA: Dream Studio USA, Inc., Cyprus: TEKTOPIA LTD (HE 473775)

## Responsive Behavior
- Desktop: visible at `md` and above.
- Tablet/mobile: hidden; mobile uses top menu icon and bottom nav.
