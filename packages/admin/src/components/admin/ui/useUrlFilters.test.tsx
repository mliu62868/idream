// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUrlFilters } from "./useUrlFilters";

const navigation = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Query = { status: string; cursor: string };

const initial: Query = { status: "", cursor: "" };

function parse(params: URLSearchParams): Query {
  return { status: params.get("status") ?? "", cursor: params.get("cursor") ?? "" };
}

function toUrl(query: Query, location: { pathname: string }) {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  return `${location.pathname}${params.size ? `?${params}` : ""}`;
}

const load = vi.fn<(query: Query, params: URLSearchParams) => void>();

// SPEC: 通过 DOM 驱动 hook，而不是把返回值漏到组件外 —— 后者是渲染期副作用。
function Probe() {
  const { apply, draft, pushUrl, query, setDraft, urlFor } = useUrlFilters<Query>({ initial, parse, toUrl, load });
  return (
    <>
      <output data-testid="query">{query.status || "none"}</output>
      <output data-testid="draft">{draft.status || "none"}</output>
      <button onClick={() => setDraft({ status: "blocked" })} type="button">edit</button>
      <button onClick={() => setDraft({ status: "running" })} type="button">edit another</button>
      <button onClick={() => apply()} type="button">apply</button>
      <button onClick={() => pushUrl(`${urlFor(query)}&row=job-1`)} type="button">open row</button>
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
  act(() => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function read(testid: string) {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent;
}

beforeEach(() => {
  load.mockReset();
  window.history.replaceState(null, "", "/admin/system/audit?status=failed&junk=1");
  navigation.search = window.location.search;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => { root.render(<Probe />); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe("useUrlFilters", () => {
  // SPEC: 挂载时才读地址栏 —— SSR 与首次客户端渲染因此不会不一致。
  it("adopts the shared URL on mount and normalises away stale parameters", () => {
    expect(read("query")).toBe("failed");
    expect(window.location.search).toBe("?status=failed");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual({ status: "failed", cursor: "" });
  });

  it("keeps edits in the draft until they are applied", () => {
    load.mockClear();

    click("edit");
    expect(read("draft")).toBe("blocked");
    expect(read("query")).toBe("failed");
    expect(load).not.toHaveBeenCalled();

    click("apply");
    expect(read("query")).toBe("blocked");
    expect(window.location.search).toBe("?status=blocked");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("restores the filters the browser back button points at", () => {
    click("edit");
    click("apply");
    expect(read("query")).toBe("blocked");

    // happy-dom 的 history.back() 不派发 popstate，手动还原地址栏并触发这次导航。
    window.history.replaceState(null, "", "/admin/system/audit?status=failed");
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });

    expect(read("query")).toBe("failed");
    expect(read("draft")).toBe("failed");
  });

  it("adopts a same-page router navigation without waiting for popstate", () => {
    click("edit");
    load.mockClear();
    window.history.pushState(null, "", "/admin/system/audit");
    navigation.search = window.location.search;
    act(() => root.render(<Probe />));

    expect(read("query")).toBe("none");
    expect(read("draft")).toBe("none");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual(initial);
  });

  it("does not reload or overwrite a draft when the router echoes its own URL write", () => {
    click("edit");
    click("apply");
    const callsAfterApply = load.mock.calls.length;
    navigation.search = window.location.search;
    act(() => root.render(<Probe />));
    expect(load).toHaveBeenCalledTimes(callsAfterApply);
    load.mockClear();
    click("edit another");
    click("open row");
    navigation.search = window.location.search;
    act(() => root.render(<Probe />));

    expect(read("draft")).toBe("running");
    expect(load).not.toHaveBeenCalled();
  });

  it("loads back navigation once when both popstate and the router report it", () => {
    click("edit");
    click("apply");
    navigation.search = window.location.search;
    act(() => root.render(<Probe />));
    load.mockClear();
    window.history.replaceState(null, "", "/admin/system/audit?status=failed");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    navigation.search = window.location.search;
    act(() => root.render(<Probe />));

    expect(read("query")).toBe("failed");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("restores an unapplied draft on back navigation between identical queries", () => {
    click("edit");
    load.mockClear();
    window.history.pushState(null, "", window.location.href);
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));

    expect(read("draft")).toBe("failed");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("writes adjacent URL state without refetching the list", () => {
    load.mockClear();

    click("open row");

    expect(window.location.search).toBe("?status=failed&row=job-1");
    expect(load).not.toHaveBeenCalled();
  });

  it("preserves adjacent history state when normalising, applying filters, and opening a row", () => {
    const state = { workspace: "keep-me", adminListCursorHistory: { cursor: "c1", page: 2, cursors: [""] } };
    window.history.replaceState(state, "", "/admin/system/audit?status=failed&cursor=c1");
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Probe />));
    expect(window.history.state).toEqual(state);
    click("edit");
    click("apply");
    expect(window.history.state).toEqual(state);
    click("open row");
    expect(window.history.state).toEqual(state);
  });
});
