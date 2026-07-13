# Admin First-Principles Remediation: Next.js 16 Implementation Evidence

This note records the framework constraints applied while implementing
`ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md` section 16.7.

- Admin Route Handler `GET` reads are treated as uncached by default. No
  authentication, authorization, or operational read relies on stale cache state.
- App Router `params` and `searchParams` are Promises and are awaited before use.
- The interactive admin shell is a Client Component that remains server-rendered;
  it does not use `ssr: false`.
- Canonical physical routes share one server bootstrap renderer so authorization,
  deep-link restoration, and initial data loading have one authority path.
- `proxy.ts` is the Next.js 16 replacement for Middleware, but it is not treated as
  an authorization authority; protected operations authenticate in their handlers.
- Production-mode Playwright verification uses a completed build before starting
  the server, avoiding development-only route behavior.
- Canonical routes provide route-level loading, error, not-found, and metadata
  behavior instead of depending on a catch-all-only shell.

These constraints were checked against the repository-local Next.js 16 guides in
`node_modules/next/dist/docs/` before implementation.
