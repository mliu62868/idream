import { describe, expect, it } from "vitest";
import {
  authHrefForTarget,
  authNextTargetFromPath,
  safeInternalAuthRedirect,
} from "./authRedirect";

const origin = "https://app.example";

describe("auth redirect helpers", () => {
  it("preserves account and checkout fragments for safe internal product routes", () => {
    expect(safeInternalAuthRedirect("/profile#billing", origin)).toBe(
      "/profile#billing",
    );
    expect(
      safeInternalAuthRedirect("/upgrade?plan=premium&billing=monthly#plans", origin),
    ).toBe("/upgrade?plan=premium&billing=monthly#plans");
    expect(authNextTargetFromPath("/profile", "", "#billing")).toBe(
      "/profile#billing",
    );
  });

  it("allows first-party product, support, and content routes used by the app shell", () => {
    expect(authNextTargetFromPath("/safety/contact", "")).toBe("/safety/contact");
    expect(authNextTargetFromPath("/resources-hub", "")).toBe("/resources-hub");
    expect(authNextTargetFromPath("/comparison/ai-girlfriend-alternatives", "")).toBe(
      "/comparison/ai-girlfriend-alternatives",
    );
    expect(authHrefForTarget("/signup", "/type/romantic-ai-girlfriend")).toBe(
      "/signup?next=%2Ftype%2Fromantic-ai-girlfriend",
    );
    expect(
      safeInternalAuthRedirect(
        "/age-verification/return?next=%2Fgenerate",
        origin,
      ),
    ).toBe("/age-verification/return?next=%2Fgenerate");
  });

  it("rejects external, protocol-relative, auth-loop, and non-product targets", () => {
    expect(safeInternalAuthRedirect("https://evil.example/profile", origin)).toBe(
      "/",
    );
    expect(safeInternalAuthRedirect("//evil.example/profile", origin)).toBe("/");
    expect(safeInternalAuthRedirect("/login", origin)).toBe("/");
    expect(safeInternalAuthRedirect("/signup?next=%2Fprofile", origin)).toBe("/");
    expect(safeInternalAuthRedirect("/api/v1/me", origin)).toBe("/");
    expect(safeInternalAuthRedirect("/admin", origin)).toBe("/");
  });
});
