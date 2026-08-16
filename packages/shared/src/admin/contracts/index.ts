export * from "./common";
export * from "./access";
export * from "./billing";
// Character contracts are split by subdomain — the seam the test files already used.
// contract-registry resolves by SYMBOL NAME on this barrel, so the split is invisible
// to every caller.
export * from "./characters-common";
export * from "./characters-create";
export * from "./characters-visual-workspace";
export * from "./characters-qualification";
export * from "./characters-asset-studio";
export * from "./characters-release";
export * from "./characters-performance";
export * from "./characters-media-operations";
export * from "./creative";
export * from "./assets";
export * from "./incidents";
export * from "./cases";
export * from "./customers";
export * from "./metrics";
export * from "./experiments";
export * from "./reconciliation";
export * from "./today";
export * from "./bootstrap";
export * from "./collaboration";
export * from "./jobs";
export * from "./grant-bundles";
export * from "./search";
export * from "./chat-operations";
// ---- trust: migrated from v1 ----
export * from "./moderation";
export * from "./compliance";
export * from "./approvals";
export * from "./risk";
export * from "./support";
export * from "./audit-log";
export * from "./feature-flags";
// ---- money: migrated from v1 ----
export * from "./pricing";
export * from "./promo";
// ---- platform: migrated from v1 ----
export * from "./cms";
export * from "./announcements";
export * from "./overviews";
export * from "./generation-ops";
