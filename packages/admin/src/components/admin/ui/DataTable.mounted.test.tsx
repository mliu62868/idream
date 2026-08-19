// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));

import { DataTable } from "./DataTable";

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => { root.render(node); });
}

beforeEach(() => {
  routerPush.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

const linkedRows = [{ id: "entry-1", cells: ["entry-1", <button key="act" type="button">Refund</button>], href: "/admin/billing/entry-1" }];

describe("DataTable row navigation", () => {
  // SPEC: 整行点击走 App Router 客户端导航；旧实现 window.location.assign 会整页重载。
  it("pushes the row href through the client router", () => {
    render(<DataTable caption="Ledger" headers={["ID", "Action"]} rows={linkedRows} />);

    const cell = container.querySelector("tbody tr td:first-child") as HTMLElement;
    act(() => { cell.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(routerPush).toHaveBeenCalledWith("/admin/billing/entry-1");
  });

  // SPEC: 键盘与读屏走第一格里的真 <a>；<tr> 不做 Tab 停靠点。
  // INTENT: <tr> 上没有任何 ARIA 能表达"整行可激活"，加 tabIndex 只是造出每行一个无名停靠点。
  it("leaves the keyboard path to the row's real link instead of a nameless tab stop", () => {
    render(<DataTable caption="Ledger" headers={["ID", "Action"]} rows={linkedRows} />);

    const row = container.querySelector("tbody tr") as HTMLElement;
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(container.querySelector("tbody a")?.getAttribute("href")).toBe("/admin/billing/entry-1");
  });

  it("lets the row's own controls act without also navigating", () => {
    render(<DataTable caption="Ledger" headers={["ID", "Action"]} rows={linkedRows} />);

    const action = container.querySelector("tbody button") as HTMLElement;
    act(() => { action.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(routerPush).not.toHaveBeenCalled();
  });
});

describe("DataTable selection", () => {
  it("adds and removes one row, and selects every row on the page at once", () => {
    const onChange = vi.fn();
    const rows = [
      { id: "entry-1", cells: ["entry-1"] },
      { id: "entry-2", cells: ["entry-2"] },
    ];
    render(<DataTable caption="Ledger" headers={["ID"]} rows={rows} selection={{ onChange, selected: ["entry-1"] }} />);

    const [all, first, second] = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(all.checked).toBe(false);
    expect(first.checked).toBe(true);

    act(() => { second.click(); });
    expect(onChange).toHaveBeenLastCalledWith(["entry-1", "entry-2"]);

    act(() => { first.click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);

    act(() => { all.click(); });
    expect(onChange).toHaveBeenLastCalledWith(["entry-1", "entry-2"]);
  });
});
