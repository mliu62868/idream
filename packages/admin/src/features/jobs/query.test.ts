import { describe, expect, it } from "vitest";
import { buildGenerationJobQuery, parseGenerationJobQuery } from "./query";

describe("Generation Jobs URL query", () => {
  it("round trips every visible control into the exact v2 API query", () => {
    const query = {
      search: "timeout",
      mode: "image" as const,
      legacyStatus: "failed",
      provider: "provider-alpha",
      sourceType: "creative_run",
      userId: "user-1",
      characterId: "character-1",
      sort: "cost_desc" as const,
      limit: 25,
      cursor: "opaque-cursor",
    };
    const encoded = buildGenerationJobQuery(query);
    expect(encoded).toBe("search=timeout&mode=image&legacyStatus=failed&provider=provider-alpha&sourceType=creative_run&userId=user-1&characterId=character-1&sort=cost_desc&limit=25&cursor=opaque-cursor");
    expect(parseGenerationJobQuery(new URLSearchParams(encoded))).toEqual(query);
  });

  it("fails closed to supported defaults for stale URL state", () => {
    expect(parseGenerationJobQuery(new URLSearchParams("mode=audio&sort=random&limit=999&clientRows=50"))).toEqual({
      search: "",
      mode: "image",
      legacyStatus: "",
      provider: "",
      sourceType: "",
      userId: "",
      characterId: "",
      sort: "created_desc",
      limit: 25,
      cursor: undefined,
    });
  });
});
