import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = [
  readFileSync(new URL("./AdminConsoleClient.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./AnnouncementsView.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/audit/AuditWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/audit/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/pricing/PricingWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/pricing/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/billing/BillingWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/billing/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/config/GenerationConfigWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/config/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/dead-letter/DeadLetterWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/dead-letter/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/access/AccessWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/access/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/moderation/ModerationWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/moderation/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/support/SupportWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/support/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/promo/PromoWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/promo/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/approvals/ApprovalsWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/approvals/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/chat-ops/ChatOpsWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/chat-ops/query.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/content-merchandising/ContentMerchandisingWorkspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../../features/content-merchandising/query.ts", import.meta.url), "utf8"),
].join("\n");

describe("remaining canonical admin list surfaces", () => {
  it("persists every compatibility list cursor in URL state and restores browser history", () => {
    for (const cursor of [
      "ledgerCursor",
      "subscriptionCursor",
      "pricingCursor",
      "deadCursor",
      "accessCursor",
      "reportCursor",
      "mediaCursor",
      "appealCursor",
      "auditCursor",
      "contentCursor",
      "promoCursor",
      "referralCursor",
      "approvalCursor",
      "profileCursor",
      "flagCursor",
      "chatSessionCursor",
      "chatUsageCursor",
      "chatEventCursor",
      "announcementCursor",
    ]) {
      expect(source, cursor).toContain(cursor);
    }
    expect(source).toContain('window.history.pushState(null, ""');
    expect(source).toContain('window.addEventListener("popstate"');
  });

  it("sends search and filters to server endpoints instead of filtering loaded rows", () => {
    expect(source).not.toMatch(/rows\.filter\(/);
    expect(source).not.toMatch(/JSON\.stringify\(row\)/);
    for (const endpoint of [
      "/billing/ledger",
      "/billing/subscriptions",
      "/pricing/rules",
      "/generation/dead-letter",
      "/moderation/queue",
      "/audit-log",
      "/content/characters",
      "/promo/redeem-codes",
      "/promo/referrals",
      "/approvals",
      "/generation/model-profiles",
      "/feature-flags",
      "/chat/sessions",
      "/chat/usage",
      "/chat/moderation-events",
      "/announcements",
    ]) {
      expect(source, endpoint).toContain(endpoint);
    }
  });

  it("distinguishes filtered emptiness from a genuinely empty authority", () => {
    expect(source).toContain("No ledger entries match these filters");
    expect(source).toContain("No audit events exist yet");
    expect(source).toContain("No dead-letter jobs match these filters");
    expect(source).toContain("No chat sessions exist yet");
    expect(source).toContain("No approval requests are pending");
  });
});
