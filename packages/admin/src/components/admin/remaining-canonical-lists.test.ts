import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  announcementListPath,
  announcementQueryFromSearch,
  announcementWorkspaceUrl,
} from "./announcements-query";
import {
  buildCompatibilityListUrl,
  readCompatibilityListQuery,
} from "@/features/compatibility-lists/query";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  billingLedgerPath,
  billingQueryFromSearch,
  billingSubscriptionsPath,
} from "@/features/billing/query";
import { pricingListPath, pricingQueryFromSearch } from "@/features/pricing/query";
import {
  deadLetterListPath,
  deadLetterQueryFromSearch,
} from "@/features/dead-letter/query";
import { accessListPath, accessQueryFromSearch } from "@/features/access/query";
import {
  moderationQueryFromSearch,
  moderationQueuePath,
} from "@/features/moderation/query";
import { auditListPath, auditQueryFromSearch } from "@/features/audit/query";
import { contentListPath, contentQueryFromSearch } from "@/features/content-merchandising/query";
import { promoListPath, promoQueryFromSearch } from "@/features/promo/query";
import { approvalListPath, approvalQueryFromSearch } from "@/features/approvals/query";
import {
  featureFlagsPath,
  generationConfigQueryFromSearch,
  generationProfilesPath,
} from "@/features/config/query";
import { chatOpsPath, chatOpsQueryFromSearch } from "@/features/chat-ops/query";

const FEATURES_DIR = fileURLToPath(new URL("../../features/", import.meta.url));

function allFeatureSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const feature of readdirSync(FEATURES_DIR)) {
    const dir = join(FEATURES_DIR, feature);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name.includes(".test.")) continue;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      files.push({
        path: `${feature}/${name}`,
        text: readFileSync(join(dir, name), "utf8"),
      });
    }
  }
  return files;
}

describe("remaining canonical admin list surfaces", () => {
  it("round-trips compatibility cursor state through browser URLs", () => {
    const url = buildCompatibilityListUrl(
      "/admin/billing",
      "?unrelated=kept&ledgerCursor=old",
      { ledgerCursor: "next", billingSearch: "alice" },
    );
    expect(url).toBe(
      "/admin/billing?unrelated=kept&ledgerCursor=next&billingSearch=alice",
    );
    expect(readCompatibilityListQuery(
      new URLSearchParams(url.split("?")[1]),
      ["ledgerCursor", "billingSearch"],
    )).toEqual({ ledgerCursor: "next", billingSearch: "alice" });

    expect(announcementWorkspaceUrl(
      "/admin/announcements",
      "?announcementCursor=old&announcementLevel=promo",
      { announcementSearch: "launch" },
      true,
    )).toBe(
      "/admin/announcements?announcementLevel=promo&announcementSearch=launch",
    );
  });

  it("sends every named cursor and filter to its canonical server endpoint", () => {
    const billing = billingQueryFromSearch(
      "?billingSearch=alice&ledgerReason=bonus&subscriptionStatus=active&ledgerCursor=L&subscriptionCursor=S",
    );
    expect(billingLedgerPath(billing)).toBe(
      "/api/v2/admin/billing/ledger?search=alice&reason=bonus&cursor=L&limit=25",
    );
    expect(billingSubscriptionsPath(billing)).toBe(
      "/api/v2/admin/billing/subscriptions?search=alice&status=active&cursor=S&limit=25",
    );

    expect(pricingListPath(pricingQueryFromSearch(
      "?pricingSearch=portrait&pricingMode=image&pricingStatus=active&pricingCursor=P",
    ))).toBe(
      "/api/v2/admin/pricing/rules?search=portrait&mode=image&status=active&cursor=P&limit=25",
    );
    expect(deadLetterListPath(deadLetterQueryFromSearch(
      "?deadSearch=timeout&deadMode=image&deadStatus=failed&deadError=provider&deadCursor=D",
    ))).toBe(
      "/api/v2/admin/generation/dead-letter?search=timeout&mode=image&status=failed&errorCode=provider&cursor=D&limit=25",
    );
    expect(accessListPath(accessQueryFromSearch(
      "?accessSearch=kim&accessRole=admin&accessStatus=active&accessDataClass=internal&accessCursor=A",
    ))).toBe(
      "/api/v2/admin/users?q=kim&role=admin&status=active&dataClass=internal&cursor=A&limit=25",
    );

    const moderation = moderationQueryFromSearch(
      "?moderationSearch=asset&moderationStatus=open&moderationTargetType=media&reportCursor=R&mediaCursor=M&appealCursor=AP",
    );
    expect(moderationQueuePath(moderation, "reports")).toBe(
      "/api/v2/admin/moderation/queue?scope=reports&limit=25&search=asset&status=open&targetType=media&reportCursor=R",
    );
    expect(moderationQueuePath(moderation, "media")).toBe(
      "/api/v2/admin/moderation/queue?scope=media&limit=25&search=asset&status=open&targetType=media&mediaCursor=M",
    );
    expect(moderationQueuePath(moderation, "appeals")).toBe(
      "/api/v2/admin/moderation/queue?scope=appeals&limit=25&search=asset&status=open&targetType=media&appealCursor=AP",
    );

    expect(auditListPath(auditQueryFromSearch(
      "?auditSearch=publish&auditAction=release&auditActor=operator&auditTargetType=character&auditCursor=AU",
    ))).toBe(
      "/api/v2/admin/audit-log?search=publish&action=release&actorId=operator&targetType=character&cursor=AU&limit=25",
    );
    expect(contentListPath(contentQueryFromSearch(
      "?contentSearch=alex&contentStatus=approved&contentVisibility=public&contentCursor=C",
    ))).toBe(
      "/api/v2/admin/content/characters?limit=25&search=alex&status=approved&visibility=public&cursor=C",
    );

    const promo = promoQueryFromSearch(
      "?promoSearch=summer&promoStatus=active&referralStatus=paid&promoCursor=PC&referralCursor=PR",
    );
    expect(promoListPath(promo, "codes")).toBe(
      "/api/v2/admin/promo/redeem-codes?limit=25&search=summer&status=active&cursor=PC",
    );
    expect(promoListPath(promo, "referrals")).toBe(
      "/api/v2/admin/promo/referrals?limit=25&search=summer&status=paid&cursor=PR",
    );
    expect(approvalListPath(approvalQueryFromSearch(
      "?approvalSearch=release&approvalStatus=pending&approvalCursor=AV",
    ))).toBe(
      "/api/v2/admin/approvals?limit=25&search=release&status=pending&cursor=AV",
    );

    const config = generationConfigQueryFromSearch(
      "?configSearch=qwen&profileMode=image&profileStatus=active&flagEnabled=true&profileCursor=GP&flagCursor=GF",
    );
    expect(generationProfilesPath(config)).toBe(
      "/api/v2/admin/generation/model-profiles?search=qwen&mode=image&status=active&cursor=GP&limit=25",
    );
    expect(featureFlagsPath(config)).toBe(
      "/api/v2/admin/feature-flags?search=qwen&enabled=true&cursor=GF&limit=25",
    );

    const chat = chatOpsQueryFromSearch(
      "?chatUserId=user&chatCharacterId=character&chatSessionStatus=active&chatEventStatus=open&chatEventLayer=policy&chatPolicyCode=P1&chatTargetId=T1&chatLimit=25&chatSessionCursor=CS&chatUsageCursor=CU&chatEventCursor=CE",
    );
    expect(chatOpsPath(chat, "sessions")).toBe(
      "/api/v2/admin/chat/sessions?limit=25&userId=user&characterId=character&status=active&cursor=CS",
    );
    expect(chatOpsPath(chat, "usage")).toBe(
      "/api/v2/admin/chat/usage?limit=25&userId=user&cursor=CU",
    );
    expect(chatOpsPath(chat, "events")).toBe(
      "/api/v2/admin/chat/moderation-events?limit=25&status=open&layer=policy&policyCode=P1&targetId=T1&cursor=CE",
    );

    expect(announcementListPath(announcementQueryFromSearch(
      "?announcementSearch=launch&announcementLevel=promo&announcementActive=true&announcementCursor=AN",
    ))).toBe(
      "/api/v2/admin/announcements?limit=25&search=launch&level=promo&active=true&cursor=AN",
    );
  });

  it("sends search and filters to server endpoints instead of filtering loaded rows", () => {
    const everyFeatureSource = allFeatureSources();
    expect(everyFeatureSource.length).toBeGreaterThanOrEqual(18);
    const offenders = everyFeatureSource.filter(
      (file) => /rows\.filter\(/.test(file.text) || /JSON\.stringify\(row\)/.test(file.text),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("distinguishes filtered emptiness from a genuinely empty authority", () => {
    expect(canonicalListEmptyTitle("ledger", true))
      .toBe("No ledger entries match these filters");
    expect(canonicalListEmptyTitle("audit", false))
      .toBe("No audit events exist yet");
    expect(canonicalListEmptyTitle("dead_letter", true))
      .toBe("No dead-letter jobs match these filters");
    expect(canonicalListEmptyTitle("chat_sessions", false))
      .toBe("No chat sessions exist yet");
    expect(canonicalListEmptyTitle("approvals", false))
      .toBe("No approval requests are pending");
  });
});
