import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

// Next's `source` patterns are path-to-regexp; the negative lookahead is the only
// part that can silently stop matching, so exercise it as a RegExp.
const rules = async () => (await nextConfig.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;

describe("main security headers", () => {
  it("denies framing everywhere except the Admin-only internal preview", async () => {
    const list = await rules();
    const deny = list.find(rule => rule.headers.some(h => h.key === "X-Frame-Options"))!;
    expect(deny.headers).toEqual([{ key: "X-Frame-Options", value: "DENY" }]);
    const pattern = new RegExp(`^${deny.source}$`);
    expect(pattern.test("/characters/lola")).toBe(true);
    expect(pattern.test("/internal-preview/characters/token")).toBe(false);
    const preview = list.find(rule => rule.source === "/internal-preview/:path*")!;
    expect(preview.headers[0]).toMatchObject({ key: "Content-Security-Policy" });
    expect(preview.headers[0]!.value).toMatch(/^frame-ancestors /);
  });
});
