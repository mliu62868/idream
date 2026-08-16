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

  it("navigates from the keyboard without swallowing the row's own controls", () => {
    render(<DataTable caption="Ledger" headers={["ID", "Action"]} rows={linkedRows} />);

    const row = container.querySelector("tbody tr") as HTMLElement;
    expect(row.getAttribute("tabindex")).toBe("0");
    act(() => { row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
    expect(routerPush).toHaveBeenCalledTimes(1);

    const action = container.querySelector("tbody button") as HTMLElement;
    act(() => { action.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(routerPush).toHaveBeenCalledTimes(1);
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
