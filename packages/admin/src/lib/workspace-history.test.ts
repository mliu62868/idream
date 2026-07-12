import { describe, expect, it, vi } from "vitest";
import { createWorkspaceHistoryController, observeWorkspacePopState } from "./workspace-history";

type State = { filter: string; cursor: string | null; selectedId: string | null };

describe("workspace history controller", () => {
  it("coalesces drafts while preserving committed navigation entries", () => {
    const initial: State = { filter: "open", cursor: null, selectedId: null };
    const writes: Array<{ state: State; mode: string }> = [];
    const write = (state: State, mode: "push" | "replace") => writes.push({ state, mode });
    const history = createWorkspaceHistoryController(initial);

    history.draft({ ...initial, filter: "ope" }, write);
    history.draft({ ...initial, filter: "open cases" }, write);
    history.navigate({ ...initial, selectedId: "case-7" }, write);
    history.navigate({ filter: "open", cursor: "page-2", selectedId: "case-7" }, write);

    expect(writes).toEqual([
      { state: initial, mode: "push" },
      { state: { ...initial, filter: "ope" }, mode: "replace" },
      { state: { ...initial, filter: "open cases" }, mode: "replace" },
      { state: { ...initial, selectedId: "case-7" }, mode: "replace" },
      { state: { filter: "open", cursor: "page-2", selectedId: "case-7" }, mode: "push" },
    ]);
  });

  it("restores complete state on Back and Forward notifications", () => {
    const target = new EventTarget();
    const restored = vi.fn();
    let current: State = { filter: "mine", cursor: "page-2", selectedId: "case-2" };
    const cleanup = observeWorkspacePopState(target, () => current, restored);

    target.dispatchEvent(new Event("popstate"));
    current = { filter: "overdue", cursor: "page-3", selectedId: "case-9" };
    target.dispatchEvent(new Event("popstate"));
    cleanup();
    target.dispatchEvent(new Event("popstate"));

    expect(restored).toHaveBeenNthCalledWith(1, { filter: "mine", cursor: "page-2", selectedId: "case-2" });
    expect(restored).toHaveBeenNthCalledWith(2, { filter: "overdue", cursor: "page-3", selectedId: "case-9" });
    expect(restored).toHaveBeenCalledTimes(2);
  });
});
