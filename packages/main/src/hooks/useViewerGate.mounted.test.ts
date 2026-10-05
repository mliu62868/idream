// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateViewerAuthority, VIEWER_AUTH_CHANGE_STORAGE_KEY } from "@/components/ourdream/viewer-auth";
import { useViewerGate, type ViewerGate } from "./useViewerGate";
import { useViewerResource } from "./useViewerResource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let viewer: string | null;
let reads: Array<string | null>;

beforeEach(() => {
  invalidateViewerAuthority();
  viewer = "owner-a";
  reads = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/v1/me") return Response.json({ ok: true, data: { user: viewer ? { id: viewer } : null } });
    const scope = new Headers(init?.headers).get("x-idream-viewer-scope");
    reads.push(scope);
    return Response.json({ owner: scope });
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

// The shape that stalled /chat/groups: the gate lives in the parent, and the
// child reads in a plain mount effect. Child effects run before the parent's.
function Reader({ viewer: gate }: { viewer: ViewerGate }) {
  const resource = useViewerResource({
    request: () => ({ path: "/api/v1/private" }),
    parse: (raw) => (raw as { owner: string | null }).owner,
    fallbackError: "Could not load",
    initialData: null as string | null,
    gate: gate.gate,
  });
  const refresh = resource.refresh;
  useEffect(() => { void refresh(); }, [refresh, gate.revalidation]);
  return createElement("p", null, resource.data ?? "empty");
}

function Page() {
  const gate = useViewerGate();
  return gate.identity?.kind === "user" ? createElement(Reader, { viewer: gate }) : null;
}

function PublicPage() {
  const gate = useViewerGate({ require: "any" });
  return createElement("div", null,
    createElement(Reader, { viewer: gate }),
    gate.error && createElement("p", { role: "alert" }, gate.error),
    gate.error && createElement("button", { onClick: () => void gate.revalidate() }, "Retry"),
  );
}

describe("useViewerGate", () => {
  it("admits a child's mount-time read in the same commit that first confirms the viewer", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    expect(reads).toEqual(["user:owner-a"]);
    expect(container.textContent).toBe("user:owner-a");
  });

  it("re-issues a child's read under the new owner when focus confirms an account change", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(reads.at(-1)).toBe("user:owner-b");
    expect(container.textContent).toBe("user:owner-b");
  });

  it("revokes signed-in data on another tab's logout broadcast and restores only the newly signed-in owner", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    expect(container.textContent).toBe("user:owner-a");
    viewer = null;
    await broadcastAuthChange();
    await settle();
    expect(container.textContent).toBe("");
    viewer = "owner-b";
    await broadcastAuthChange();
    await settle();
    expect(reads.at(-1)).toBe("user:owner-b");
    expect(container.textContent).toBe("user:owner-b");
  });

  it("ignores unrelated storage and session-storage auth keys", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    const checks = vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me").length;
    viewer = "owner-b";
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "changed", storageArea: window.localStorage })));
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: VIEWER_AUTH_CHANGE_STORAGE_KEY, newValue: "changed", storageArea: window.sessionStorage })));
    await settle();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(checks);
    expect(container.textContent).toBe("user:owner-a");
  });

  it("rechecks a broadcast independently of an older account read and abandons its late identity", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const oldCheck = Promise.withResolvers<Response>();
    let pendingOldCheck = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/me" && pendingOldCheck) {
        pendingOldCheck = false;
        return oldCheck.promise;
      }
      return originalFetch(input, init);
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    viewer = "owner-b";
    await broadcastAuthChange();
    await settle();
    expect(container.textContent).toBe("user:owner-b");
    await act(async () => oldCheck.resolve(Response.json({ ok: true, data: { user: { id: "owner-a" } } })));
    await settle();
    expect(container.textContent).toBe("user:owner-b");
    expect(reads.at(-1)).toBe("user:owner-b");
  });
});

describe("auth broadcast privacy while confirmation is unavailable", () => {
  it("withdraws the old private projection before a delayed logout check completes", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    expect(container.textContent).toBe("user:owner-a");
    const original = vi.mocked(fetch).getMockImplementation()!;
    const check = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/me" ? check.promise : original(input, init));
    viewer = null;
    await broadcastAuthChange();
    await settle();
    expect(container.textContent).toBe("");
    await act(async () => check.resolve(Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 })));
    await settle();
    expect(container.textContent).toBe("");
  });

  it("does not retain the old private projection after logout confirmation fails", async () => {
    await act(async () => root.render(createElement(Page)));
    await settle();
    expect(container.textContent).toBe("user:owner-a");
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/me"
      ? Promise.resolve(Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 })) : original(input, init));
    viewer = null;
    await broadcastAuthChange();
    await settle();
    expect(container.textContent).toBe("");
  });

  it("clears a still-mounted public resource immediately and retries only after a new viewer is confirmed", async () => {
    await act(async () => root.render(createElement(PublicPage)));
    await settle();
    expect(container.querySelector("p")?.textContent).toBe("user:owner-a");
    const original = vi.mocked(fetch).getMockImplementation()!;
    const check = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/me" ? check.promise : original(input, init));
    await broadcastAuthChange();
    await settle();
    expect(container.querySelector("p")?.textContent).toBe("empty");
    expect(reads).toEqual(["user:owner-a"]);
    await act(async () => check.resolve(Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 })));
    await settle();
    expect(container.querySelector("p")?.textContent).toBe("empty");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Temporarily unavailable");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
    expect(reads).toEqual(["user:owner-a"]);
    viewer = "owner-b";
    vi.mocked(fetch).mockImplementation(original);
    await act(async () => container.querySelector("button")?.click());
    await settle();
    expect(container.querySelector("p")?.textContent).toBe("user:owner-b");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(reads).toEqual(["user:owner-a", "user:owner-b"]);
  });

  it("preserves a confirmed same-owner resource when an ordinary focus check fails", async () => {
    await act(async () => root.render(createElement(PublicPage)));
    await settle();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/me"
      ? Promise.resolve(Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 })) : original(input, init));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.querySelector("p")?.textContent).toBe("user:owner-a");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(reads).toEqual(["user:owner-a"]);
  });
});

async function broadcastAuthChange() {
  await act(async () => window.dispatchEvent(new StorageEvent("storage", {
    key: VIEWER_AUTH_CHANGE_STORAGE_KEY, newValue: crypto.randomUUID(), storageArea: window.localStorage,
  })));
}
