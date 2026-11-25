// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RecoveryCodeCard } from "./AccountRecovery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("checks the current viewer before exposing a recovery credential and hides it across tab account changes", async () => {
  let viewer = "owner-a";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { user: { id: viewer } } })));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RecoveryCodeCard, { code: "private-owner-a-code", ownerId: "owner-a" })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("private-owner-a-code");
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(container.textContent).not.toContain("private-owner-a-code");
    viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).not.toContain("private-owner-a-code");
    expect(container.textContent).toContain("Account changed");
    expect(container.querySelector('a[href="/profile"]')?.textContent).toBe("Open Profile");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it.each(["unavailable", "offline"])("retries account verification in place after a temporary %s response", async (failure) => {
  const readViewer = vi.fn()
    .mockImplementationOnce(async () => {
      if (failure === "offline") throw new TypeError("Network unavailable");
      return Response.json({ ok: false }, { status: 503 });
    })
    .mockResolvedValueOnce(Response.json({ ok: true, data: { user: { id: "owner-a" } } }));
  vi.stubGlobal("fetch", readViewer);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onContinue = vi.fn();
  try {
    await act(async () => root.render(createElement(RecoveryCodeCard, { code: "private-owner-a-code", ownerId: "owner-a", onContinue })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.querySelector('[data-testid="account-recovery-code"]')).toBeNull();
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Continue without code")).toBe(true);
    await act(async () => retry!.click());
    expect(container.querySelector('[data-testid="account-recovery-code"]')?.textContent).toBe("private-owner-a-code");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue")!.click());
    expect(onContinue).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
