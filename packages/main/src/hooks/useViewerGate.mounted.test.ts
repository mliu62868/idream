// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateViewerAuthority } from "@/components/ourdream/viewer-auth";
import { useViewerGate, type ViewerGate } from "./useViewerGate";
import { useViewerResource } from "./useViewerResource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let viewer: string;
let reads: Array<string | null>;

beforeEach(() => {
  invalidateViewerAuthority();
  viewer = "owner-a";
  reads = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/v1/me") return Response.json({ ok: true, data: { user: { id: viewer } } });
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
});
