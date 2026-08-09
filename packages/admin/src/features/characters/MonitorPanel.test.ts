import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { characterMonitorWindows } from "./MonitorPanel";

describe("Character release monitor windows", () => {
  it("projects required and persisted monitor windows without duplicates", () => {
    expect(characterMonitorWindows([
      { window: "route_qualification" },
      { window: "24h" },
      { window: "7d" },
      { window: "7d" },
    ])).toEqual([
      "route_qualification",
      "24h",
      "72h",
      "7d",
    ]);
  });

  it("keeps route qualification empty state semantically distinct from pending time windows", () => {
    const source = readFileSync(new URL("./MonitorPanel.tsx", import.meta.url), "utf8");

    expect(source).toContain('window === "route_qualification" ? "not_required" : "pending"');
    // 运营面说人话：空态/入口文案用「image route」，不暴露 route qualification 这个工程词。
    expect(source).toContain("No image route action is currently required.");
    expect(source).toContain("Open image route");
  });
});
