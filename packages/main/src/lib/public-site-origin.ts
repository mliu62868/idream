const DEVELOPMENT_SITE_ORIGIN = "http://localhost:3000";

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
  ]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (source.APP_ENV === "production" && !isPublicHttpsUrl(url)) {
        continue;
      }
      return new URL(url.origin);
    } catch {
      continue;
    }
  }

  // SEO must never invent a production host or publish a competitor canonical.
  if (source.APP_ENV === "production") {
    throw new Error("Public site origin is not configured: set MAIN_WEB_URL or BETTER_AUTH_URL to a public HTTPS origin in production");
  }
  return new URL(DEVELOPMENT_SITE_ORIGIN);
}

export function isPublicHttpsUrl(value: string | URL | null | undefined) {
  if (!value) return false;
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    return false;
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  const isIpLiteral =
    hostname.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname);
  const isPrivateDnsName = [
    ".internal",
    ".invalid",
    ".local",
    ".localhost",
    ".onion",
    ".test",
    ".home.arpa",
    ".example",
    ".example.com",
    ".example.net",
    ".example.org",
  ].some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));

  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    hostname.includes(".") &&
    !isIpLiteral &&
    !isPrivateDnsName
  );
}
