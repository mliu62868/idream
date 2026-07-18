import { describe, expect, it } from "vitest";
import { parseCommunityCampaignAuthoredCopy } from "./community-campaigns";

describe("community campaign authored copy authority", () => {
  it("normalizes complete operator-authored copy", () => {
    expect(parseCommunityCampaignAuthoredCopy({
      eyebrow: "  Featured  ",
      title: "  Summer dreamers  ",
      ctaLabel: "  Open collection  ",
      href: "  /community?collection=summer  ",
    })).toEqual({
      eyebrow: "Featured",
      title: "Summer dreamers",
      ctaLabel: "Open collection",
      href: "/community?collection=summer",
    });
  });

  it("accepts informational copy only when both CTA fields are absent", () => {
    expect(parseCommunityCampaignAuthoredCopy({
      eyebrow: "Featured",
      title: "Summer dreamers",
    })).toEqual({
      eyebrow: "Featured",
      title: "Summer dreamers",
      ctaLabel: null,
      href: null,
    });
    expect(parseCommunityCampaignAuthoredCopy({
      eyebrow: "Featured",
      title: "Summer dreamers",
      ctaLabel: "Open collection",
    })).toBeNull();
    expect(parseCommunityCampaignAuthoredCopy({
      eyebrow: "Featured",
      title: "Summer dreamers",
      href: "/community?collection=summer",
    })).toBeNull();
  });

  it("fails closed without required copy or with an unsafe authored href", () => {
    expect(parseCommunityCampaignAuthoredCopy({
      eyebrow: "Featured",
    })).toBeNull();
    expect(parseCommunityCampaignAuthoredCopy({
      eyebrow: "Featured",
      title: "Summer dreamers",
      href: "javascript:alert(1)",
    })).toBeNull();
  });
});
