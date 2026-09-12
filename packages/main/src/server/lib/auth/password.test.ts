import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("account password credentials", () => {
  it("verifies only the matching password", () => {
    const stored = hashPassword("Original-password!");
    expect(verifyPassword("Original-password!", stored)).toBe(true);
    expect(verifyPassword("Changed-password!", stored)).toBe(false);
  });
  it.each([null, "", "broken", "scrypt$short$broken", "scrypt$00$ff"])("rejects malformed stored credentials without throwing: %s", (stored) => {
    expect(verifyPassword("Password!", stored)).toBe(false);
  });
});
