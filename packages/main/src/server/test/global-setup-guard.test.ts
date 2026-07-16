import { describe, expect, it } from "vitest";
import { dedicatedTestDatabaseUrl } from "./global-setup";

describe("test database reset guard", () => {
  it("accepts dedicated test database names", () => {
    expect(
      dedicatedTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_3110",
      ),
    ).toContain("idream_test_playwright_3110");
  });

  it("refuses a development database even when supplied explicitly", () => {
    expect(() =>
      dedicatedTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5433/idream",
      ),
    ).toThrow(/Refusing to reset non-test database/);
  });

  it("refuses names that merely contain the letters test inside another word", () => {
    expect(() =>
      dedicatedTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5433/idream_contest",
      ),
    ).toThrow(/Refusing to reset non-test database/);
  });
});
