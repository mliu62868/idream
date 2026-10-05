import { describe, expect, it } from "vitest";
import {
  authHrefForTarget,
  authNextTargetFromPath,
  safeInternalAuthRedirect,
} from "./authRedirect";

const origin = "https://app.example";

describe("auth redirect helpers", () => {
  it("returns a signed-in reader to the gated changelog", () => {
    expect(safeInternalAuthRedirect("/changelog", "https://idream.test")).toBe("/changelog");
  });
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
    expect(safeInternalAuthRedirect("/coins?returnTo=%2Fgenerate", origin)).toBe("/coins?returnTo=%2Fgenerate");
    expect(safeInternalAuthRedirect("/comics/fixture", origin)).toBe("/comics/fixture");
    expect(safeInternalAuthRedirect("/creator-studio", origin)).toBe("/creator-studio");
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

  it("carries the safe original task through an authentication page", () => {
    const target = "/create?draftResume=guest-intent&step=identity#voice";
    expect(authNextTargetFromPath("/login", `ref=DREAM-ABC&next=${encodeURIComponent(target)}`)).toBe(target);
    expect(authNextTargetFromPath("/signup", `next=${encodeURIComponent(target)}`)).toBe(target);
    for (const next of ["https://evil.example/profile", "//evil.example/profile", "/\\evil.example/profile", "/login?next=%2Fprofile", "/api/v1/me"]) {
      expect(authNextTargetFromPath("/login", `next=${encodeURIComponent(next)}`)).toBeNull();
    }
  });

  it("encodes an explicitly carried invite without injecting another return target", () => {
    const target = "/create?draftResume=guest-intent#voice";
    const href = authHrefForTarget("/signup", target, " DREAM-ABC&next=//evil.example ");
    const parsed = new URL(href, origin);
    expect(parsed.pathname).toBe("/signup");
    expect(parsed.searchParams.getAll("next")).toEqual([target]);
    expect(parsed.searchParams.getAll("ref")).toEqual(["DREAM-ABC&next=//evil.example"]);
    expect(authHrefForTarget("/login", null, " DREAM-ABC ")).toBe("/login?ref=DREAM-ABC");
    expect(authHrefForTarget("/signup", null, " ")).toBe("/signup");
  });
});
