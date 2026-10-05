// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, href, ...props }: ComponentProps<"a">) => createElement("a", { href: String(href), ...props }, children) }));
import { AuthWorkspace, signupReferralBonusCopy, signupReferralCode } from "./AuthWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("authentication invite round trips", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    requests = vi.fn(async (_path: RequestInfo | URL) => Response.json({ ok: true, data: { user: null, anonymousId: "anonymous-invite" } }));
    vi.stubGlobal("fetch", requests);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
  async function mount(mode: "signup" | "login", href: string) {
    window.history.replaceState(null, "", href);
    await act(async () => root.render(createElement(AuthWorkspace, { key: mode, mode })));
    for (let i = 0; i < 50 && container.querySelector("form")?.getAttribute("data-auth-ready") !== "true"; i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    expect(container.querySelector("form")?.getAttribute("data-auth-ready")).toBe("true");
  }
  function link(label: string) {
    const result = [...container.querySelectorAll("a")].find((entry) => entry.textContent === label);
    expect(result).toBeDefined(); return result!.getAttribute("href")!;
  }
  it.each([
    ["/create?draftResume=guest-intent&step=identity#voice", "/create?draftResume=guest-intent&step=identity#voice"],
    ["https://evil.example/steal", null],
  ])("keeps the invite through Signup/Login/Signup with target %s and never submits", async (next, expectedNext) => {
    await mount("signup", `/signup?ref=DREAM-E-DELUXE&next=${encodeURIComponent(next!)}`);
    expect(container.querySelector('[data-testid="signup-referral-bonus"]')?.textContent).toContain("150 bonus dreamcoins");
    const loginHref = link("Log in");
    const loginQuery = new URL(loginHref, window.location.origin).searchParams;
    expect(loginQuery.get("ref")).toBe("DREAM-E-DELUXE");
    expect(loginQuery.get("next")).toBe(expectedNext);
    await mount("login", loginHref);
    const signupHref = link("Join free");
    const signupQuery = new URL(signupHref, window.location.origin).searchParams;
    expect(signupQuery.get("ref")).toBe("DREAM-E-DELUXE");
    expect(signupQuery.get("next")).toBe(expectedNext);
    await mount("signup", signupHref);
    expect(container.querySelector('[data-testid="signup-referral-bonus"]')?.textContent).toContain("150 bonus dreamcoins");
    expect(requests.mock.calls.every((call) => String(call[0]) === "/api/v1/me")).toBe(true);
  });
});
