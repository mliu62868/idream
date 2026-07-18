import { describe, expect, it } from "vitest";
import { publicSiteIdentity } from "./public-site-identity";

describe("public site identity", () => {
  it("does not invent legal entities or third-party channels", () => {
    expect(publicSiteIdentity({})).toEqual({
      affiliateUrl: null,
      brandName: "ourdream.ai",
      discordUrl: null,
      helpCenterUrl: null,
      legalName: null,
      redditUrl: null,
      supportEmail: null,
      xUrl: null,
    });
  });

  it("accepts only explicit HTTPS links and a valid support email", () => {
    expect(
      publicSiteIdentity({
        NEXT_PUBLIC_SITE_DISCORD_URL: "https://discord.example/invite",
        NEXT_PUBLIC_SITE_LEGAL_NAME: "Configured Operator LLC",
        NEXT_PUBLIC_SITE_REDDIT_URL: "http://insecure.example/community",
        NEXT_PUBLIC_SITE_SUPPORT_EMAIL: "Support@Example.com",
      }),
    ).toMatchObject({
      discordUrl: "https://discord.example/invite",
      legalName: "Configured Operator LLC",
      redditUrl: null,
      supportEmail: "support@example.com",
    });
  });
});
