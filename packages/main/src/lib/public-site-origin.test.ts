import { describe, expect, it } from "vitest";
import { publicSiteOrigin } from "./public-site-origin";

describe("publicSiteOrigin", () => {
  it("uses the configured main origin without preserving a path", () => {
    expect(
      publicSiteOrigin({
        MAIN_WEB_URL: "https://www.ourdream.ai/some/path",
        BETTER_AUTH_URL: "https://auth.example.com",
      }).href,
    ).toBe("https://www.ourdream.ai/");
  });

  it("falls back through the auth origin to the production origin", () => {
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
    ).toBe("https://ourdream.ai/");
  });

  it("never emits an HTTP or loopback SEO origin in production", () => {
    expect(
      publicSiteOrigin({
        APP_ENV: "production",
        MAIN_WEB_URL: "http://main.example.com",
        BETTER_AUTH_URL: "https://auth.ourdream.ai",
      }).href,
    ).toBe("https://auth.ourdream.ai/");
    expect(
      publicSiteOrigin({
        APP_ENV: "production",
        MAIN_WEB_URL: "http://localhost:3000",
        BETTER_AUTH_URL: "http://127.0.0.1:3000",
      }).href,
    ).toBe("https://ourdream.ai/");
  });
});
