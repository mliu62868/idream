import { characterPortfolioQuerySchema } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { characterAttentionCopy, characterAttentionReason } from "./character-attention";

// SPEC: 列表与 Today 读同一份原因。
describe("character attention reason", () => {
  it("prefers the monitor action and stays silent without a fact", () => {
    expect(characterAttentionReason({ monitorActionRequired: true, noTraffic: true })).toBe("release_monitor_action");
    expect(characterAttentionReason({ monitorActionRequired: false, noTraffic: true })).toBe("no_traffic_after_window");
    expect(characterAttentionReason({ monitorActionRequired: false, noTraffic: false })).toBeNull();
    expect(characterAttentionCopy(null)).toBeNull();
  });

  it("only sends operators to placement and event delivery on genuine zero traffic", () => {
    expect(characterAttentionCopy("no_traffic_after_window")?.recommendedAction).toContain("event delivery");
    expect(characterAttentionCopy("release_monitor_action")?.recommendedAction).not.toContain("event delivery");
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
