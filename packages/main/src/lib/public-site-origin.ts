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
      if (source.APP_ENV === "production" && !isPublicHttpsUrl(url)) {
        continue;
      }
      return new URL(url.origin);
    } catch {
      continue;
    }
  }

  return new URL(DEFAULT_PUBLIC_SITE_ORIGIN);
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
