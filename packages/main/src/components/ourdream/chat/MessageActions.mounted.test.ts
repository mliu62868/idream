// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActions } from "./MessageActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(deleteConfirm: boolean, onCancelDelete = vi.fn()) {
  await act(async () => {
    root.render(createElement(MessageActions, {
      isUser: true, pending: false, onReport: () => {}, onDelete: () => {}, deleteConfirm, onCancelDelete,
    }));
  });
  return onCancelDelete;
}

const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

describe("MessageActions", () => {
  it("collapsing an armed delete disarms it instead of doing nothing", async () => {
    const onCancelDelete = await render(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle().click());
    expect(onCancelDelete).toHaveBeenCalledTimes(1);
  });

  it("Escape also backs out of an armed delete", async () => {
    const onCancelDelete = await render(true);
    await act(async () => {
      toggle().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancelDelete).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the panel when nothing is armed", async () => {
    const onCancelDelete = await render(false);
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(onCancelDelete).not.toHaveBeenCalled();
  });
});
