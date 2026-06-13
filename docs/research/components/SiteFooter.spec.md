# SiteFooter Specification

## Overview
- **Target file:** `src/components/ourdream/SiteFooter.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`
- **Interaction model:** static links with hover color transitions

## DOM Structure
- Full-width footer after the app shell.
- Four desktop columns: Learn, Popular, Help, and legal/social.
- Internal links route inside the clone; external links open the original external destinations.

## Computed Styles
- backgroundColor: `rgb(13, 13, 13)`
- content maxWidth: approximately `1120px`
- desktop padding: `64px 20px`
- link fontSize: `14px`
- link lineHeight: `20px`
- link color: `rgb(255, 255, 255)`
- muted headings/legal color: `rgb(114, 113, 112)`

## States & Behaviors
- Hover: links transition from white to muted text.
- Social icons use the same hover color model.

## Assets
- Icons from `lucide-react`.

## Text Content
Learn, Resources Hub, AI Girlfriend Types, Comparisons, Videos, AI Instructions, Popular, AI Girlfriend, AI Boyfriend, AI Anime, Games, Romantasy, our dream ai, Help, Help Centre, Affiliates, Help Desk, Safety, 2026 OURDREAM.AI, USA: Dream Studio USA, Inc., Cyprus: TEKTOPIA LTD (HE 473775)

## Responsive Behavior
- Desktop: four columns.
- Mobile: single stacked column with the same link order.
