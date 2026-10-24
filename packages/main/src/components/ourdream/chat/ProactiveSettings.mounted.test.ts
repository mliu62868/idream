// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProactiveSettings } from "./ProactiveSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const savedSettings = { enabled: true, intervalHours: 24, nextAt: "2026-10-24T13:00:00.000Z" };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(sessionId = "session-1", onEnabledChange = vi.fn()) {
  await act(async () => root.render(createElement(ProactiveSettings, { sessionId, onEnabledChange })));
}

async function retry() {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Retry");
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe("Check-in settings authority", () => {
  it.each([
    {},
    { ...savedSettings, enabled: "true" },
    { ...savedSettings, intervalHours: 0 },
    { ...savedSettings, nextAt: "not-a-date" },
  ])("does not turn an invalid successful read into an Off state: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await render();
    expect(container.querySelector('[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("Off: this character only replies to you.");
    expect(container.textContent).toContain("Couldn't load check-in settings.");
  });

  it.each([503, 200])("recovers a failed initial read in place without writing settings (HTTP %s)", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status }))
      .mockResolvedValueOnce(Response.json(savedSettings));
    vi.stubGlobal("fetch", fetchMock);
    await render();
    await retry();
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Check-in frequency"]')?.value).toBe("24");
    expect(container.textContent).not.toContain("Couldn't load");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("recovers an unreadable save receipt by reading the accepted state, without repeating the write", async () => {
    const onEnabledChange = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...savedSettings, enabled: false, nextAt: null }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(savedSettings));
    vi.stubGlobal("fetch", fetchMock);
    await render("session-1", onEnabledChange);
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
    onEnabledChange.mockClear();
    await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    expect.soft(container.textContent).toContain("Couldn't confirm check-in settings.");
    expect.soft(container.querySelector('[type="checkbox"]')).toBeNull();
    expect(onEnabledChange).not.toHaveBeenCalled();
    await retry();
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true);
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("synchronizes the accepted state after closing and reopening an unreadable save", async () => {
    const onEnabledChange = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...savedSettings, enabled: false, nextAt: null }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(savedSettings));
    vi.stubGlobal("fetch", fetchMock);
    await render("session-1", onEnabledChange);
    onEnabledChange.mockClear();
    await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    expect(container.textContent).toContain("Couldn't confirm check-in settings.");
    expect(onEnabledChange).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await render("session-1", onEnabledChange);
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true);
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("clears the old session while loading another and ignores its late save receipt", async () => {
    let finishSave!: (response: Response) => void;
    let finishRead!: (response: Response) => void;
    const onEnabledChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Promise<Response>(resolve => { finishSave = resolve; });
      if (String(input).includes("session-2")) return new Promise<Response>(resolve => { finishRead = resolve; });
      return Promise.resolve(Response.json(savedSettings));
    }));
    await render("session-1", onEnabledChange);
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(true);
    onEnabledChange.mockClear();
    await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    await render("session-2", onEnabledChange);
    expect.soft(container.querySelector('[type="checkbox"]')).toBeNull();
    expect.soft(container.textContent).toContain("Loading check-in settings…");
    await act(async () => finishRead(Response.json({ ...savedSettings, enabled: false, nextAt: null })));
    const toggle = container.querySelector<HTMLInputElement>('[type="checkbox"]')!;
    expect.soft(toggle.checked).toBe(false);
    expect.soft(toggle.disabled).toBe(false);
    await act(async () => finishSave(Response.json(savedSettings)));
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(false);
    expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});
