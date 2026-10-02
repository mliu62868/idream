// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresetsNewPage } from "./PresetsNewPage";
import { PresetsSection } from "./PresetsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

describe("new preset input recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
  beforeEach(async () => {
    window.history.replaceState(null, "", "/admin/generation/presets/new");
    push.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    fetchMock = vi.fn(async () => Response.json({ ok: true, data: { preset: { id: "preset-created" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<PresetsNewPage canWrite />));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const field = (label: string) => [...container.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
  const createButton = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "Create preset")!;
  async function fill() {
    await changeInput(field("Label"), "My new preset");
    await changeInput(field("Controls (JSON)"), '{"prompt":"My new setting"}');
  }

  it("keeps new preset input across permission revocation while hiding creation controls", async () => {
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "new" }} />));
    await fill();
    await act(async () => root.render(<PresetsSection canWrite={false} view={{ kind: "new" }} />));
    expect(container.textContent).toContain("unavailable — ask an admin owner to grant it.");
    expect(container.querySelector("input,textarea")).toBeNull();
    expect(createButton()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "new" }} />));
    expect(field("Label").value).toBe("My new preset");
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My new setting"}');
    await act(async () => createButton().click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ label: "My new preset", controls: { prompt: "My new setting" } });
  });

  it("retains a denied in-flight preset creation after permission is restored", async () => {
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "new" }} />));
    await fill();
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => createButton().click());
    await act(async () => root.render(<PresetsSection canWrite={false} view={{ kind: "new" }} />));
    await act(async () => finishWrite(Response.json({ ok: false, error: { code: "forbidden", message: "Preset create permission revoked" } }, { status: 403 })));
    expect(createButton()).toBeUndefined();
    expect(push).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "new" }} />));
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My new setting"}');
    expect(container.textContent).toContain("Preset create permission revoked");
    expect(createButton().disabled).toBe(false);
  });

  it("allows a clean Back link and preserves changed controls when leaving is cancelled", async () => {
    const back = container.querySelector<HTMLAnchorElement>('a[href="/admin/generation/presets"]')!;
    const navigate = vi.fn((event: MouseEvent) => event.preventDefault()); back.addEventListener("click", navigate);
    await act(async () => back.click());
    expect(navigate).toHaveBeenCalledTimes(1);
    await fill();
    await act(async () => back.click());
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Cancel")!.click());
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My new setting"}');
    const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("freezes the submitted controls until creation completes and then navigates without a discard warning", async () => {
    await fill();
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => createButton().click());
    expect(field("Label").closest("fieldset")?.disabled).toBe(true);
    expect(field("Controls (JSON)").closest("fieldset")?.disabled).toBe(true);
    const pendingReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(pendingReload);
    expect(pendingReload.defaultPrevented).toBe(true);
    expect(push).not.toHaveBeenCalled();
    await act(async () => finishWrite(Response.json({ ok: true, data: { preset: { id: "preset-created" } } })));
    expect(push).toHaveBeenCalledWith("/admin/generation/presets/preset-created");
    const savedReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(savedReload);
    expect(savedReload.defaultPrevented).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ label: "My new preset", controls: { prompt: "My new setting" } });
  });

  it("keeps failed creation controls editable and sends the corrected input on retry", async () => {
    await fill();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "unavailable", message: "Preset create unavailable" } }, { status: 503 }));
    await act(async () => createButton().click());
    expect(container.textContent).toContain("Preset create unavailable");
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My new setting"}');
    expect(Boolean(field("Controls (JSON)").closest("fieldset")?.disabled)).toBe(false);
    expect(createButton().disabled).toBe(false);
    expect(push).not.toHaveBeenCalled();
    await changeInput(field("Label"), "My corrected preset");
    await act(async () => createButton().click());
    expect(push).toHaveBeenCalledWith("/admin/generation/presets/preset-created");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ label: "My corrected preset", controls: { prompt: "My new setting" } });
  });
});

async function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
