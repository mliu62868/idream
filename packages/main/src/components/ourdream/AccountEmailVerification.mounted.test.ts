// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountEmailVerification, EmailPasswordRecovery } from "./AccountEmailVerification";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const now = new Date("2026-09-10T01:00:00Z").getTime();
const challenge = (id = "challenge-one") => ({ challengeId: id, expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date(Date.now() + 60_000).toISOString() });
const ok = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
const account = { userId: "owner-a", email: "controlled@customer.invalid", verified: false, available: true };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
function input(label: string) {
  const match = [...container.querySelectorAll("label")].find((element) => element.textContent === label)?.querySelector("input");
  if (!match) throw new Error(`Missing input: ${label}`);
  return match;
}
async function fill(label: string, value: string) {
  await act(async () => {
    const element = input(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) { await act(async () => button(label).click()); }
async function submit(label: string) {
  await act(async () => input(label).closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("email verification and recovery UI", () => {
  it("shows unavailable delivery without claiming a code was sent or disabling saved recovery", async () => {
    const fetcher = vi.fn<Fetcher>(async () => ok({ ...account, available: false }));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(AccountEmailVerification, { ownerId: "owner-a" })));
    expect(container.textContent).toContain("Email delivery is temporarily unavailable");
    expect(container.textContent).toContain("saved recovery code remains usable");
    expect(button("Send verification code").disabled).toBe(true);
    expect(container.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not display another account's email or allow verification after an owner mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ ...account, userId: "owner-b", email: "other@customer.invalid" })));
    await act(async () => root.render(createElement(AccountEmailVerification, { ownerId: "owner-a" })));
    expect(container.textContent).toContain("Your account changed");
    expect(container.textContent).not.toContain("other@customer.invalid");
    expect(container.querySelector("button")).toBeNull();
  });

  it("enforces resend cooldown, clears the old code on resend, and stops confirming an expired challenge", async () => {
    let sends = 0;
    const fetcher = vi.fn<Fetcher>(async (_url, init) => init?.method === "POST" ? ok(challenge(`challenge-${++sends}`), 202) : ok(account));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(AccountEmailVerification, { ownerId: "owner-a" })));
    await click("Send verification code");
    expect(button("Resend in 60s").disabled).toBe(true);
    await fill("Email verification code", "12345678");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await click("Resend email code");
    expect(input("Email verification code").value).toBe("");
    expect(sends).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(container.textContent).toContain("This code has expired");
    expect(button("Verify email").disabled).toBe(true);
    expect(input("Email verification code").disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("binds confirmation to the owner and exact challenge, then displays authoritative verified state", async () => {
    const fetcher = vi.fn<Fetcher>(async (url, init) => {
      if (!init?.method) return ok(account);
      return String(url).endsWith("/confirm") ? ok({ userId: "owner-a", verified: true }) : ok(challenge(), 202);
    });
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(AccountEmailVerification, { ownerId: "owner-a" })));
    await click("Send verification code"); await fill("Email verification code", "12345678"); await submit("Email verification code");
    expect(container.textContent).toContain("Your email is verified");
    const confirmation = fetcher.mock.calls.find(([url]) => String(url).endsWith("/confirm"))!;
    expect(JSON.parse(String(confirmation[1]?.body))).toEqual({ expectedUserId: "owner-a", challengeId: "challenge-one", code: "12345678" });
    expect(container.querySelector('input[autocomplete="one-time-code"]')).toBeNull();
  });

  it("recovers by email, shows the rotated code only for the confirmed owner, and waits for saving before return", async () => {
    const complete = vi.fn();
    const fetcher = vi.fn<Fetcher>(async (url) => {
      if (String(url) === "/api/v1/me") return ok({ user: { id: "owner-a" } });
      if (String(url).endsWith("/confirm")) return ok({ recovered: true, userId: "owner-a", recoveryCode: "replacement-private-code" });
      return ok(challenge(), 202);
    });
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(EmailPasswordRecovery, { onBack: vi.fn(), onComplete: complete })));
    await fill("Email", account.email); await submit("Email");
    expect(container.textContent).toContain("does not confirm that one exists");
    await fill("Email verification code", "87654321"); await fill("New password", "New-private-password!"); await submit("New password");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toContain("replacement-private-code");
    expect(button("Continue").disabled).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("Continue");
    expect(complete).toHaveBeenCalledOnce();
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1][1]?.body))).toEqual({ email: account.email, challengeId: "challenge-one", code: "87654321", password: "New-private-password!" });
  });

  it("explains an uncertain reset without replaying it or navigating automatically", async () => {
    const complete = vi.fn();
    const fetcher = vi.fn<Fetcher>(async (url) => {
      if (String(url).endsWith("/confirm")) throw new TypeError("Connection lost");
      return ok(challenge(), 202);
    });
    vi.stubGlobal("fetch", fetcher);
    await act(async () => root.render(createElement(EmailPasswordRecovery, { onBack: vi.fn(), onComplete: complete })));
    await fill("Email", account.email); await submit("Email");
    await fill("Email verification code", "87654321"); await fill("New password", "New-private-password!"); await submit("New password");
    expect(container.textContent).toContain("Try logging in with your new password first");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/confirm"))).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
