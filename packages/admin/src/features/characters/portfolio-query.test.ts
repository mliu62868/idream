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
});
