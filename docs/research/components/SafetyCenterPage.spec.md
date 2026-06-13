# SafetyCenterPage Specification

## Overview
- **Target file:** `src/components/ourdream/SafetyCenterPage.tsx`
- **Screenshots:**
  - `docs/design-references/ourdream/safety-introduction-desktop.png`
  - `docs/design-references/ourdream/safety-introduction-mobile.png`
- **Extraction files:**
  - `docs/research/ourdream-safety-extraction.json`
  - `docs/research/ourdream-safety-components-extra.json`
  - `docs/research/ourdream-safety-mobile-extraction.json`
  - `docs/research/ourdream-safety-docs.json`
- **Interaction model:** mostly static documentation shell; hover-driven nav/card states, anchor links, responsive sidebar collapse. Search and theme buttons are visual-only in this clone.

## DOM Structure
- Full page safety shell with dark background.
- Sticky/fixed top header:
  - Left logo link to `/`.
  - Center search pill.
  - Desktop nav link `ourdream`, pink `Report a problem` button, moon icon.
  - Second row `Trust & Safety` tab with pink underline.
- Main layout:
  - Desktop left fixed docs navigation, width `288px`, starting around `top: 113.6px`, left `32px`.
  - Center content column, width about `688.812px`.
  - Desktop right "On this page" navigation.
  - Footer matching Mintlify docs footer.
- Mobile:
  - Header fixed at top, height about `120px`.
  - Left docs navigation hidden.
  - Content starts after header, width about `350px` inside 20px side padding.
  - Card grid collapses to one column.

## Computed Styles

### Body
- fontFamily: `Inter, -apple-system, "system-ui", "Segoe UI", system-ui, sans-serif`
- fontSize: `16px`
- fontWeight: `400`
- lineHeight: `24px`
- color: `rgb(255, 255, 255)`
- desktop body rect: `1440px x 2658.97px`
- mobile body rect: `390px x 3944.97px`

### Topbar
- desktop rect: `1440px x 112px`
- mobile rect: `390px x 120px`
- position: desktop `sticky`, mobile `fixed`
- zIndex: `30`
- color: `rgb(166, 161, 164)`
- border bottom visible as dark separator in screenshot

### Sidebar
- desktop rect: `x: 32, y: 114, width: 288, height: 1086`
- display: `block` desktop, hidden mobile
- position: `fixed`
- width: `288px`
- active item:
  - color: `rgb(241, 123, 182)`
  - backgroundColor: `rgba(241, 123, 182, 0.1)`
  - padding: `6px 12px 6px 16px`
  - width: `256px`
  - height: `36px`
  - borderRadius: `12px`
- inactive item:
  - color: `rgb(166, 161, 164)`
  - padding: `6px 12px 6px 16px`
  - height: `36px`

### Main Content
- desktop main rect: `x: 32, y: 112, width: 1376, height: 2171`
- desktop content column rect: `x: 363, width: 688.812px`
- mobile main rect: `x: 16, width: 358px`
- mobile content rect: `x: 20, width: 350px`
- prose fontSize: `16px`
- prose lineHeight: `28px`
- prose color: `rgb(166, 161, 164)`

### Page Title
- desktop h1:
  - fontSize: `30px`
  - fontWeight: `700`
  - lineHeight: `36px`
  - letterSpacing: `-0.75px`
  - color: `rgb(230, 225, 228)`
- mobile h1:
  - fontSize: `24px`
  - lineHeight: `32px`
  - letterSpacing: `-0.6px`

### Lead
- fontSize: `18px`
- lineHeight: `28px`
- color: `rgb(166, 161, 164)`
- mobile lead width: `350px`, height `84px`

### Section Headings
- h2 fontSize: `24px`
- fontWeight: `600`
- lineHeight: `31.9999px`
- letterSpacing: `-0.6px`
- color: `rgb(255, 255, 255)`
- margin: `48px 0px 16px`

### Card Group
- desktop grid rect: `x: 363, width: 688.812px, height: 870px`
- desktop gridTemplateColumns: `336.406px 336.406px`
- mobile gridTemplateColumns: `350px`
- gap: `0px 16px`
- card:
  - backgroundColor: `rgb(13, 13, 13)`
  - margin: `8px 0px`
  - desktop width: `336.406px`, height `158px`
  - mobile width: `350px`, height `158px`
  - borderRadius: `16px`
  - border: `1px solid rgba(255, 255, 255, 0.1)`
  - padding inner content: `20px 24px`
  - hover border changes to pink.

### Footer
- desktop rect: `1440px x 376px`
- mobile rect: `390px x 368px`
- border top: dark gray/white 10% separator
- content centered with logo, email, main site link, Mintlify attribution, theme buttons.

## States & Behaviors

### Sidebar hover
- **Trigger:** pointer hover on inactive nav item.
- **State A:** color `rgb(166, 161, 164)`, background transparent.
- **State B:** color light gray, background subtle white/gray 5%.
- **Transition:** original reports `transition: all`.

### Card hover
- **Trigger:** pointer hover.
- **State A:** border `1px solid rgba(255, 255, 255, 0.1)`.
- **State B:** border changes to pink accent (`rgb(241, 123, 182)` in Safety docs shell).
- **Transition:** original reports `transition: all`.

### Anchor links
- **Trigger:** click a left nav item, card, or right table-of-contents item.
- **Behavior:** navigate to corresponding local Safety route or in-page anchor.

### Responsive
- **Desktop 1440px:** three-column docs shell: fixed sidebar, centered prose column, right table of contents.
- **Tablet/mobile below `1024px`:** left sidebar and right TOC hidden, header fixed, content uses full readable width.
- **Mobile 390px:** content width about `350px`; card group becomes one column.

## Content
- Use real Markdown from `https://safety.ourdream.ai/llms.txt` and all linked `.md` pages.
- Introduction page cards:
  - Principles
  - What's allowed
  - Prohibited content
  - Age verification
  - How moderation works
  - Why was my character rejected?
  - Report a problem
  - Your safety tools
  - Wellbeing resources
  - Contact
- Navigation groups:
  - Overview
  - Policies
  - Moderation
  - Reporting
  - Your account
  - Contact

## Assets
- `/images/ourdream/safety/logo-light.svg`
- `/images/ourdream/safety/logo-dark.svg`
- `/images/ourdream/safety/images-defense-in-depth-light.svg`
- `/images/ourdream/safety/images-defense-in-depth-dark.svg`

## Known Scope
- Search modal and theme switching are visual-only.
- Markdown rendering supports the structures present in the downloaded Safety docs: headings, paragraphs, unordered/ordered lists, tables, links, strong/emphasis, Note blocks, images, and CardGroup cards.
