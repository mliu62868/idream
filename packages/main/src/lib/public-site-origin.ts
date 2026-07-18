const DEFAULT_PUBLIC_SITE_ORIGIN = "https://ourdream.ai";

type PublicSiteEnvironment = {
  APP_ENV?: string;
  BETTER_AUTH_URL?: string;
  MAIN_WEB_URL?: string;
};

export function publicSiteOrigin(
  source: PublicSiteEnvironment = {
    APP_ENV: process.env.APP_ENV,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    MAIN_WEB_URL: process.env.MAIN_WEB_URL,
  },
): URL {
  for (const candidate of [
    source.MAIN_WEB_URL,
    source.BETTER_AUTH_URL,
    DEFAULT_PUBLIC_SITE_ORIGIN,
  ]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (source.APP_ENV === "production" && !isPublicHttpsOrigin(url)) {
        continue;
      }
      return new URL(url.origin);
    } catch {
      continue;
    }
  }

  return new URL(DEFAULT_PUBLIC_SITE_ORIGIN);
}

function isPublicHttpsOrigin(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    url.protocol === "https:" &&
    !new Set(["localhost", "127.0.0.1", "::1"]).has(hostname)
  );
}
