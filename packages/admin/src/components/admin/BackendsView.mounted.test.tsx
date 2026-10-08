// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { BackendsView } from "./BackendsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("reloads backend health once per shell refresh and removes the listener after unmount", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true, data: {
    items: [{ id: "fixture-backend", kind: "comfyui", health: { ok: true, latencyMs: 12 } }],
  } }));
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<BackendsView />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    expect(container.textContent).toContain("fixture-backend");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
  window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
