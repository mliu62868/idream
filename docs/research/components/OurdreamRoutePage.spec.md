# OurdreamRoutePage Specification

## Overview
- **Target file:** `src/components/ourdream/OurdreamRoutePage.tsx`
- **Route file:** `src/app/[...slug]/page.tsx`
- **Interaction model:** static multi-template routing with visual-only controls

## DOM Structure
- Shared route shell with desktop sidebar, sticky topbar, page body, footer, and mobile bottom nav.
- Template switch renders one of: marketing, create, generator, library, article, comparison, profile, terms, or upgrade.
- `generateStaticParams` builds all public sitemap paths plus internal linked utility pages.

## Computed Styles
- page background: `rgb(13, 13, 13)`
- topbar height: `56px`
- desktop content padding: `60px`
- card background: `rgb(18, 18, 18)`
- raised surface: `rgb(36, 36, 36)`
- accent gradient: `linear-gradient(0deg,#ff1cac,#fd5fc2 50%,#ff79d1)`
- hero headings: uppercase, black weight, `40px` mobile and up to `68px` desktop

## States & Behaviors
- Sidebar active state is inferred from the current path.
- Forms, filters, generator controls, pricing, and profile tabs are visual-only.
- Internal links navigate to cloned static routes.
- External footer links keep their original target.

## Assets
- Existing local Ourdream card images and pride banner assets in `public/images/ourdream/`.
- Icons from `lucide-react`.

## Text Content
- Public sitemap discovered on 2026-06-13 contained 142 URLs after the latest sweep.
- Clone route data is stored in `src/lib/ourdream-data.ts`.
- Clone route data also includes 7 linked utility routes and 16 Safety Center mirror routes.
- Page titles are exact where inspected and generated from sitemap slugs for long-tail pages.

## Responsive Behavior
- Desktop: sidebar plus 60px content gutters.
- Mobile: sidebar hidden, topbar compact, bottom navigation fixed.
