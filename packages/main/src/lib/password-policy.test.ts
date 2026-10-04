import { describe, expect, it } from "vitest";
import { newPasswordProblem } from "./password-policy";

describe("new password policy (NIST 800-63B style)", () => {
  it("rejects short, common, repetitive and email-equal passwords", () => {
    expect(newPasswordProblem("short7!")).toMatch(/at least 8/);
    expect(newPasswordProblem("password")).toMatch(/too common/);
    expect(newPasswordProblem("12345678")).toMatch(/too common/);
    expect(newPasswordProblem("Password123")).toMatch(/too common/);
    expect(newPasswordProblem("zzzzzzzzzz")).toMatch(/too common/);
    expect(newPasswordProblem("Rowan@Example.com", "rowan@example.com")).toMatch(/email/);
    expect(newPasswordProblem("rowan.gardener", "Rowan.Gardener@example.com")).toMatch(/email/);
    expect(newPasswordProblem("x".repeat(1025))).toMatch(/1024/);
  });

  it("accepts long passphrases without composition rules", () => {
    expect(newPasswordProblem("correct horse battery staple")).toBeNull();
    expect(newPasswordProblem("balconygardener", "rowan@example.com")).toBeNull();
  });
});
