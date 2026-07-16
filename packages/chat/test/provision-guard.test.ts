import { describe, expect, it } from "vitest";
import { assertSafeChatTestDatabaseName } from "./provision.mjs";

describe("chat test database provisioning guard", () => {
  it("refuses production-like database names before destructive provisioning", () => {
    expect(() => assertSafeChatTestDatabaseName("idream")).toThrow(
      "Refusing to recreate non-test chat database",
    );
    expect(() => assertSafeChatTestDatabaseName("production")).toThrow(
      "Refusing to recreate non-test chat database",
    );
  });

  it("can require the stronger Playwright marker", () => {
    expect(assertSafeChatTestDatabaseName("idream_chat_test")).toBe(
      "idream_chat_test",
    );
    expect(() => assertSafeChatTestDatabaseName(
      "idream_chat_test",
      { requirePlaywright: true },
    )).toThrow("both test and playwright");
    expect(assertSafeChatTestDatabaseName(
      "idream_test_playwright_3110",
      { requirePlaywright: true },
    )).toBe("idream_test_playwright_3110");
  });
});
