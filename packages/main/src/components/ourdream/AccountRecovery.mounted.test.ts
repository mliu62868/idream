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
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
