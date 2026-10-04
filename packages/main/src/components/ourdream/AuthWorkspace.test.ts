import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthWorkspace, signupReferralBonusCopy, signupReferralCode } from "./AuthWorkspace";

describe("AuthWorkspace hydration authority", () => {
  it.each([
    ["signup", 4],
    ["login", 4],
  ] as const)(
    "keeps the %s form non-interactive until client hydration",
    (mode, disabledControlCount) => {
      const markup = renderToStaticMarkup(
        createElement(AuthWorkspace, { mode }),
      );

      expect(markup).toContain('data-auth-ready="false"');
      expect(markup).toContain('aria-busy="true"');
      expect(markup.match(/ disabled=""/g)).toHaveLength(
        disabledControlCount,
      );
    },
  );
});

describe("signup referral bonus", () => {
  it("reads the invite code the signup request carries and states the invitee amount", () => {
    expect(signupReferralCode("?ref=%20DREAM-ABC%20&next=%2Fchat")).toBe("DREAM-ABC");
    expect(signupReferralCode("?ref=")).toBeUndefined();
    expect(signupReferralCode("")).toBeUndefined();
    expect(signupReferralBonusCopy).toContain("150 bonus dreamcoins");
  });
});
