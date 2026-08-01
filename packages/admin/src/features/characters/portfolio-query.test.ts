import { describe, expect, it } from "vitest";
import {
  characterPortfolioQuery,
  parseCharacterPortfolioUrl,
} from "./portfolio-query";

describe("Character Portfolio URL authority", () => {
  it("restores supported filters and cursor from a shareable canonical URL", () => {
    expect(parseCharacterPortfolioUrl(
      "?search=aurora%20sky&phase=launch_ready&servingState=paused&readiness=blocked&cursor=opaque",
    )).toEqual({
      search: "aurora sky",
      phase: "launch_ready",
      servingState: "paused",
      readiness: "blocked",
      cursor: "opaque",
    });
  });

  it("drops unknown finite states and keeps browser URLs free of transport defaults", () => {
    const restored = parseCharacterPortfolioUrl(
      "?search=needle&phase=unknown&servingState=broken&readiness=maybe",
    );
    expect(restored).toEqual({ search: "needle" });
    expect(characterPortfolioQuery(restored)).toBe("search=needle");
    expect(characterPortfolioQuery(restored, true)).toBe(
      "limit=25&sort=project_id_asc&search=needle",
    );
  });

  // SPEC: 「需要处理」要能分享和刷新——它是运营每天的入口，必须活在 URL 里而不是组件 state 里。
  it("round-trips the needs-attention entry point through the URL", () => {
    expect(parseCharacterPortfolioUrl("?attention=true")).toMatchObject({ attention: true });
    expect(characterPortfolioQuery({ search: "", attention: true })).toBe("attention=true");
    expect(parseCharacterPortfolioUrl("?attention=1").attention).toBeUndefined();
    expect(characterPortfolioQuery({ search: "" })).toBe("");
  });
});
