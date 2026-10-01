import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../next.config";

// Next's `source` patterns are path-to-regexp; the negative lookahead is the only
// part that can silently stop matching, so exercise it as a RegExp.
const rules = async () => (await nextConfig.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;

describe("main security headers", () => {
  it("permits the same-origin microphone only on Chat documents", async () => {
    const list = await rules();
    const effectivePolicy = (pathname: string) => list.filter(rule => getPathMatch(rule.source)(pathname)).flatMap(rule => rule.headers).filter(header => header.key === "Permissions-Policy").at(-1)?.value;
    expect(effectivePolicy("/chat/session-123")).toBe("camera=(), microphone=(self), geolocation=()");
    expect(effectivePolicy("/chat/groups/group-123")).toBe("camera=(), microphone=(self), geolocation=()");
    for (const path of ["/", "/characters/lola", "/profile", "/internal-preview/characters/token"]) {
      expect(effectivePolicy(path)).toBe("camera=(), microphone=(), geolocation=()");
    }
  });
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
