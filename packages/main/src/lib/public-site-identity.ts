type PublicSiteIdentityEnvironment = {
  NEXT_PUBLIC_SITE_AFFILIATE_URL?: string;
  NEXT_PUBLIC_SITE_DISCORD_URL?: string;
  NEXT_PUBLIC_SITE_HELP_CENTER_URL?: string;
  NEXT_PUBLIC_SITE_LEGAL_NAME?: string;
  NEXT_PUBLIC_SITE_REDDIT_URL?: string;
  NEXT_PUBLIC_SITE_SUPPORT_EMAIL?: string;
  NEXT_PUBLIC_SITE_X_URL?: string;
};

export type PublicSiteIdentity = {
  affiliateUrl: string | null;
  brandName: "ourdream.ai";
  discordUrl: string | null;
  helpCenterUrl: string | null;
  legalName: string | null;
  redditUrl: string | null;
  supportEmail: string | null;
  xUrl: string | null;
};

export function publicSiteIdentity(
  source: PublicSiteIdentityEnvironment = {
    NEXT_PUBLIC_SITE_AFFILIATE_URL:
      process.env.NEXT_PUBLIC_SITE_AFFILIATE_URL,
    NEXT_PUBLIC_SITE_DISCORD_URL: process.env.NEXT_PUBLIC_SITE_DISCORD_URL,
    NEXT_PUBLIC_SITE_HELP_CENTER_URL:
      process.env.NEXT_PUBLIC_SITE_HELP_CENTER_URL,
    NEXT_PUBLIC_SITE_LEGAL_NAME: process.env.NEXT_PUBLIC_SITE_LEGAL_NAME,
    NEXT_PUBLIC_SITE_REDDIT_URL: process.env.NEXT_PUBLIC_SITE_REDDIT_URL,
    NEXT_PUBLIC_SITE_SUPPORT_EMAIL:
      process.env.NEXT_PUBLIC_SITE_SUPPORT_EMAIL,
    NEXT_PUBLIC_SITE_X_URL: process.env.NEXT_PUBLIC_SITE_X_URL,
  },
): PublicSiteIdentity {
  return {
    affiliateUrl: httpsUrl(source.NEXT_PUBLIC_SITE_AFFILIATE_URL),
    brandName: "ourdream.ai",
    discordUrl: httpsUrl(source.NEXT_PUBLIC_SITE_DISCORD_URL),
    helpCenterUrl: httpsUrl(source.NEXT_PUBLIC_SITE_HELP_CENTER_URL),
    legalName: nonBlank(source.NEXT_PUBLIC_SITE_LEGAL_NAME, 160),
    redditUrl: httpsUrl(source.NEXT_PUBLIC_SITE_REDDIT_URL),
    supportEmail: email(source.NEXT_PUBLIC_SITE_SUPPORT_EMAIL),
    xUrl: httpsUrl(source.NEXT_PUBLIC_SITE_X_URL),
  };
}

function httpsUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function email(value: string | undefined) {
  const normalized = nonBlank(value, 254);
  if (!normalized) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function nonBlank(value: string | undefined, maximum: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}
