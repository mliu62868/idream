// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { useUnsavedChanges } from "./useUnsavedChanges";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Editor({ name, onSwitch }: { name: string; onSwitch: () => void }) {
  const [text, setText] = useState("");
  const { confirmDiscard, guard } = useUnsavedChanges(Boolean(text));
  return <>
    <input aria-label={name} value={text} onChange={(event) => setText(event.target.value)} />
    <button onClick={() => confirmDiscard(onSwitch)}>Switch {name}</button>
    {guard}
  </>;
}

describe("unsaved editor protection", () => {
  let root: Root;
  let container: HTMLDivElement;
  let link: HTMLAnchorElement;
  let navigation: ReturnType<typeof vi.fn<(event: MouseEvent) => void>>;
  let originalHistoryNavigation: PropertyDescriptor | undefined;
  const onSwitch = vi.fn();
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/ops/recipes/one");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    link = document.createElement("a");
    link.href = "/admin/ops/recipes";
    link.textContent = "Back";
    document.body.append(link);
    navigation = vi.fn((event: MouseEvent) => event.preventDefault());
    link.addEventListener("click", navigation);
    onSwitch.mockReset();
    originalHistoryNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    link.remove();
    if (originalHistoryNavigation) Object.defineProperty(window, "navigation", originalHistoryNavigation);
    else Reflect.deleteProperty(window, "navigation");
    vi.restoreAllMocks();
  });
  async function mount(two = false, locale: "en" | "zh" = "en") {
    await act(async () => root.render(<AdminI18nProvider locale={locale}>
      <Editor name="First" onSwitch={onSwitch} />
      {two ? <Editor name="Second" onSwitch={onSwitch} /> : null}
    </AdminI18nProvider>));
  }
  async function change(name: string, text: string) {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function dialogButton(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === label)!;
  }

  it("lets a clean or reverted editor leave without a prompt", async () => {
    await mount();
    await act(async () => link.click());
    expect(navigation).toHaveBeenCalledTimes(1);
    await change("First", "Draft");
    await change("First", "");
    await act(async () => link.click());
    expect(navigation).toHaveBeenCalledTimes(2);
    const reload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps input when leaving is cancelled and replays the chosen link only after approval", async () => {
    await mount();
    await change("First", "Keep my draft");
    const reload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    await act(async () => link.click());
    expect(navigation).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Your unsaved changes will be lost.");
    await act(async () => dialogButton("Cancel").click());
    expect(container.querySelector("input")?.value).toBe("Keep my draft");
    expect(navigation).not.toHaveBeenCalled();
    await act(async () => link.click());
    await act(async () => dialogButton("Discard changes").click());
    expect(navigation).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("confirms once when two editors share the page", async () => {
    await mount(true);
    await change("First", "First draft");
    await change("Second", "Second draft");
    await act(async () => link.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () => dialogButton("Discard changes").click());
    expect(navigation).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("protects an internal target switch with the same translated dialog", async () => {
    await mount(false, "zh");
    await change("First", "新内容");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Switch First")!.click());
    expect(onSwitch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("放弃未保存的修改？");
    await act(async () => dialogButton("取消").click());
    expect(container.querySelector("input")?.value).toBe("新内容");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Switch First")!.click());
    await act(async () => dialogButton("放弃修改").click());
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("allows same-document links and opening another tab without discarding the editor", async () => {
    await mount();
    await change("First", "Keep my draft");
    link.href = `${window.location.pathname}#body`;
    await act(async () => link.click());
    link.href = "/admin/ops/recipes";
    link.target = "_blank";
    await act(async () => link.click());
    link.target = "";
    await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })));
    expect(navigation).toHaveBeenCalledTimes(3);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("input")?.value).toBe("Keep my draft");
  });

  function historyNavigation() {
    const target = new EventTarget();
    const traverseTo = vi.fn((key: string) => {
      const replay = traversal(key);
      target.dispatchEvent(replay);
      expect(replay.defaultPrevented).toBe(false);
      return { committed: Promise.resolve(), finished: Promise.resolve() };
    });
    Object.defineProperty(window, "navigation", { configurable: true, value: Object.assign(target, { traverseTo }) });
    return { target, traverseTo };
  }

  function traversal(key = "previous-entry", url = "http://localhost:3000/admin/ops/recipes", cancelable = true, navigationType = "traverse") {
    return Object.assign(new Event("navigate", { cancelable }), { destination: { key, url }, navigationType });
  }

  it("protects native history traversal, keeps input on cancel, and approves exactly one replay for every dirty editor", async () => {
    const history = historyNavigation();
    await mount(true);
    await change("First", "First unsaved draft");
    await change("Second", "Second unsaved draft");
    const back = traversal();
    await act(async () => { history.target.dispatchEvent(back); });
    expect(back.defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () => dialogButton("Cancel").click());
    expect(history.traverseTo).not.toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="First"]')).toHaveProperty("value", "First unsaved draft");
    expect(container.querySelector('input[aria-label="Second"]')).toHaveProperty("value", "Second unsaved draft");
    await act(async () => { history.target.dispatchEvent(traversal()); });
    await act(async () => dialogButton("Discard changes").click());
    expect(history.traverseTo).toHaveBeenCalledExactlyOnceWith("previous-entry");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("leaves clean history, fragment changes, and uncancelable navigations under browser control", async () => {
    const history = historyNavigation();
    await mount();
    const clean = traversal();
    history.target.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await change("First", "Draft");
    for (const event of [
      traversal("fragment", `${window.location.href}#body`),
      traversal("outside", "https://example.com/admin"),
      traversal("uncancelable", "http://localhost:3000/admin/ops/recipes", false),
      traversal("query-update", "http://localhost:3000/admin/ops/recipes", true, "replace"),
    ]) {
      history.target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
