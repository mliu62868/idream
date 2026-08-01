import { characterPortfolioQuerySchema } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { charactersNeedingAttention } from "./portfolio";

function attention(overrides: {
  live: readonly { characterId: string; currentReleaseId: string | null }[];
  windowClosed?: readonly string[];
  observed?: readonly string[];
}) {
  return charactersNeedingAttention({
    live: overrides.live,
    windowClosedReleaseIds: new Set(overrides.windowClosed ?? []),
    observedReleaseIds: new Set(overrides.observed ?? []),
  });
}

describe("characters needing attention", () => {
  // SPEC: 观察窗口整段走完还是零观测 = 铺位定向或事件上报没通，投放在空转。
  it("catches a live character starved of observations after the window closed", () => {
    expect(attention({
      live: [{ characterId: "alexa", currentReleaseId: "release-1" }],
      windowClosed: ["release-1"],
    })).toEqual(["alexa"]);
  });

  it("leaves a freshly published character alone until its window closes", () => {
    expect(attention({
      live: [{ characterId: "alexa", currentReleaseId: "release-1" }],
    })).toEqual([]);
  });

  it("clears a character once observations start arriving", () => {
    expect(attention({
      live: [{ characterId: "alexa", currentReleaseId: "release-1" }],
      windowClosed: ["release-1"],
      observed: ["release-1"],
    })).toEqual([]);
  });

  // SPEC: 筛子只有保持锐利才有人点。健康角色必须不被捞进来。
  it("keeps healthy live characters out so the filter keeps its meaning", () => {
    expect(attention({
      live: [
        { characterId: "healthy", currentReleaseId: "release-1" },
        { characterId: "starved", currentReleaseId: "release-2" },
      ],
      windowClosed: ["release-1", "release-2"],
      observed: ["release-1"],
    })).toEqual(["starved"]);
  });

  it("never flags a live character that has no current release to measure", () => {
    expect(attention({
      live: [{ characterId: "alexa", currentReleaseId: null }],
      windowClosed: ["release-1"],
    })).toEqual([]);
  });
});

describe("needs-attention query parsing", () => {
  function parse(value: string | boolean | undefined) {
    return characterPortfolioQuerySchema.parse(
      value === undefined ? { limit: 20 } : { limit: 20, attention: value },
    ).attention;
  }

  // SPEC: query string 到达时是字符串。z.coerce.boolean() 会把 "false" 也当真——
  // 一个关不掉的筛子比没有筛子更糟，所以两个字面量都要显式解。
  it("reads the URL string form without turning false into true", () => {
    expect(parse("true")).toBe(true);
    expect(parse("false")).toBe(false);
    expect(parse(true)).toBe(true);
    expect(parse(undefined)).toBeUndefined();
  });

  it("rejects anything that is not an explicit boolean literal", () => {
    expect(() => parse("1")).toThrow();
    expect(() => parse("yes")).toThrow();
  });
});
