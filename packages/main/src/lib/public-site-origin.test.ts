import { describe, expect, it } from "vitest";
import { publicSiteOrigin } from "./public-site-origin";

describe("publicSiteOrigin", () => {
  it("uses the configured main origin without preserving a path", () => {
    expect(
      publicSiteOrigin({
        MAIN_WEB_URL: "https://www.idream.dev/some/path",
        BETTER_AUTH_URL: "https://auth.example.com",
      }).href,
    ).toBe("https://www.idream.dev/");
  });

  it("uses the auth origin or a local development default", () => {
    expect(
      publicSiteOrigin({
        MAIN_WEB_URL: "not a url",
        BETTER_AUTH_URL: "http://127.0.0.1:3000/api/auth",
      }).href,
    ).toBe("http://127.0.0.1:3000/");
    expect(
      publicSiteOrigin({
        MAIN_WEB_URL: undefined,
        BETTER_AUTH_URL: undefined,
      }).href,
    ).toBe("http://localhost:3000/");
  });

  it("never emits an HTTP or loopback SEO origin in production", () => {
    expect(
      publicSiteOrigin({
        APP_ENV: "production",
        MAIN_WEB_URL: "http://main.example.com",
        BETTER_AUTH_URL: "https://auth.idream.dev",
      }).href,
    ).toBe("https://auth.idream.dev/");
  });

  it.each([
    {},
    { MAIN_WEB_URL: "http://localhost:3000", BETTER_AUTH_URL: "http://127.0.0.1:3000" },
    { MAIN_WEB_URL: "not a URL", BETTER_AUTH_URL: "https://auth.internal" },
    { MAIN_WEB_URL: "https://user:password@main.idream.dev", BETTER_AUTH_URL: "ftp://main.idream.dev" },
  ])("rejects missing or unusable production configuration: %j", (origins) => {
    expect(() => publicSiteOrigin({ APP_ENV: "production", ...origins }))
      .toThrow("Public site origin is not configured");
  });
});
