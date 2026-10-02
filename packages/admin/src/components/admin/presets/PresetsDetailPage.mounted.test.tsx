// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresetsDetailPage } from "./PresetsDetailPage";
import { PresetsSection } from "./PresetsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

describe("preset edits under pending and failed writes", () => {
  let container: HTMLDivElement;
  let root: Root;
  let preset: { id: string; scope: string; type: string; category: string; label: string; controls: Record<string, unknown>; visibility: string; status: string };
  let fetchMock: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/generation/presets/preset-pending");
    preset = { id: "preset-pending", scope: "built_in", type: "background", category: "interior", label: "Original preset", controls: { prompt: "Original setting" }, visibility: "public", status: "active" };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") Object.assign(preset, JSON.parse(String(init.body)));
      return Response.json({ ok: true, data: { preset } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  const field = (label: string) => [...container.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
  const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

  async function edit() {
    await act(async () => root.render(<PresetsDetailPage canWrite id={preset.id} />));
    await waitFor(() => button("Edit preset") !== undefined);
    await act(async () => button("Edit preset")!.click());
  }

  it.each([true, false])("recovers an initial network failure with only a read (canWrite=%s)", async (canWrite) => {
    fetchMock.mockRejectedValueOnce(new TypeError("Preset network unavailable"));
    await act(async () => root.render(<PresetsDetailPage canWrite={canWrite} id={preset.id} />));
    await waitFor(() => container.textContent?.includes("Preset network unavailable") === true);
    expect(container.textContent).not.toContain("Preset not found.");
    expect(container.textContent).toContain("Could not load preset.");
    expect(button("Retry")).toBeDefined();
    await act(async () => button("Retry")!.click());
    await waitFor(() => container.textContent?.includes(preset.label) === true);
    expect(fetchMock.mock.calls.map(([path, init]) => [String(path), init?.method])).toEqual([
      [`/api/v2/admin/generation/presets/${preset.id}`, "GET"],
      [`/api/v2/admin/generation/presets/${preset.id}`, "GET"],
    ]);
    expect(button("Retry")).toBeUndefined();
    expect(Boolean(button("Edit preset"))).toBe(canWrite);
  });

  it("keeps a real 404 distinct from a failed preset read", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "not_found", message: "Preset missing" } }, { status: 404 }));
    await act(async () => root.render(<PresetsDetailPage canWrite id={preset.id} />));
    await waitFor(() => container.textContent?.includes("Preset missing") === true);
    expect(container.textContent).toContain("Preset not found.");
    expect(container.textContent).not.toContain("Could not load preset.");
    expect(button("Retry")).toBeUndefined();
    expect(container.querySelector('a[href="/admin/generation/presets"]')).not.toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("guards changed preset controls on Back, preserves them after cancellation and treats a reverted edit as clean", async () => {
    await edit();
    const back = container.querySelector<HTMLAnchorElement>('a[href="/admin/generation/presets"]')!;
    const navigate = vi.fn((event: MouseEvent) => event.preventDefault()); back.addEventListener("click", navigate);
    await act(async () => back.click());
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const originalControls = field("Controls (JSON)").value;
    await changeInput(field("Controls (JSON)"), '{"prompt":"My pending controls"}');
    const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    await act(async () => back.click());
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Cancel")!.click());
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My pending controls"}');
    await changeInput(field("Controls (JSON)"), originalControls);
    await act(async () => back.click());
    expect(navigate).toHaveBeenCalledTimes(2);
    await changeInput(field("Label"), "My cancelled preset");
    await act(async () => button("Cancel")!.click());
    const cleanReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(cleanReload);
    expect(cleanReload.defaultPrevented).toBe(false);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("keeps the same preset input through rerenders and starts another preset with its own controls", async () => {
    const other = { ...preset, id: "preset-other", label: "Another preset", controls: { prompt: "Another setting" } };
    fetchMock.mockImplementation(async input => Response.json({ ok: true, data: { preset: String(input).includes(other.id) ? other : preset } }));
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "detail", id: preset.id }} />));
    await waitFor(() => button("Edit preset") !== undefined);
    await act(async () => button("Edit preset")!.click());
    await changeInput(field("Controls (JSON)"), '{"prompt":"My unsaved first preset controls"}');
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "detail", id: preset.id }} />));
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My unsaved first preset controls"}');
    await act(async () => root.render(<PresetsSection canWrite view={{ kind: "detail", id: other.id }} />));
    await waitFor(() => container.textContent?.includes(other.label) === true);
    expect(button("Save changes")).toBeUndefined();
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => button("Edit preset")!.click());
    expect(JSON.parse(field("Controls (JSON)").value)).toEqual(other.controls);
    expect(writes()).toHaveLength(0);
  });

  it("freezes the label and controls until the pending preset save settles", async () => {
    await edit();
    await changeInput(field("Label"), "My pending preset");
    await changeInput(field("Controls (JSON)"), JSON.stringify({ prompt: "A calm setting" }));
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => button("Save changes")!.click());
    expect(field("Label").closest("fieldset")?.disabled).toBe(true);
    expect(field("Controls (JSON)").closest("fieldset")?.disabled).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);
    expect(button("Save changes")!.disabled).toBe(true);
    expect(writes()).toHaveLength(1);
    const payload = JSON.parse(String(writes()[0][1]?.body));
    expect(payload).toMatchObject({ label: "My pending preset", controls: { prompt: "A calm setting" } });
    Object.assign(preset, payload);
    await act(async () => finishWrite(Response.json({ ok: true, data: { preset } })));
    await waitFor(() => container.textContent?.includes("Saved. My pending preset") === true);
    expect(container.querySelector("input,textarea")).toBeNull();
    expect(container.textContent).toContain("A calm setting");
  });

  it("retains a failed preset input and saves the deliberate correction on retry", async () => {
    await edit();
    await changeInput(field("Label"), "My failed preset");
    await changeInput(field("Controls (JSON)"), JSON.stringify({ prompt: "A pending setting" }));
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "unavailable", message: "Preset write unavailable" } }, { status: 503 }));
    await act(async () => button("Save changes")!.click());
    await waitFor(() => container.textContent?.includes("Preset write unavailable") === true);
    expect(field("Label").value).toBe("My failed preset");
    expect(JSON.parse(field("Controls (JSON)").value)).toEqual({ prompt: "A pending setting" });
    expect(Boolean(field("Label").closest("fieldset")?.disabled)).toBe(false);
    expect(button("Save changes")!.disabled).toBe(false);
    expect(container.textContent).not.toContain("Saved. My failed preset");
    await changeInput(field("Label"), "My corrected preset");
    await act(async () => button("Save changes")!.click());
    await waitFor(() => container.textContent?.includes("Saved. My corrected preset") === true);
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1][1]?.body))).toMatchObject({ label: "My corrected preset", controls: { prompt: "A pending setting" } });
  });

  it("retains a confirmed preset edit after a failed readback and retries only the authority read", async () => {
    let committed = false;
    let failRead = true;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === "PATCH") {
        committed = true;
        Object.assign(preset, JSON.parse(String(init.body)));
        return Response.json({ ok: true, data: { preset } });
      }
      if (committed && failRead) return Response.json({ ok: false, error: { code: "unavailable", message: "Latest preset read unavailable" } }, { status: 503 });
      return Response.json({ ok: true, data: { preset } });
    });
    await edit();
    await changeInput(field("Label"), "My confirmed preset");
    await changeInput(field("Controls (JSON)"), '{"prompt":"My confirmed setting"}');
    await act(async () => button("Save changes")!.click());
    await waitFor(() => container.textContent?.includes("Latest preset read unavailable") === true);
    expect(container.textContent).not.toContain("now shows the edited values");
    expect(field("Label").value).toBe("My confirmed preset");
    expect(field("Controls (JSON)").value).toBe('{"prompt":"My confirmed setting"}');
    expect(field("Controls (JSON)").closest("fieldset")?.disabled).toBe(true);
    expect(button("Save changes")!.disabled).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);
    expect(container.textContent).toContain("Changes were saved, but the latest details could not be loaded.");
    await act(async () => button("Save changes")!.click());
    expect(writes()).toHaveLength(1);
    await act(async () => root.render(<PresetsDetailPage canWrite={false} id={preset.id} />));
    for (const label of ["Save changes", "Edit preset", "Archive preset", "Restore"]) expect(button(label)).toBeUndefined();
    preset.label = "Latest authority preset"; preset.controls = { prompt: "Latest authority setting" }; failRead = false;
    await act(async () => button("Retry")!.click());
    await waitFor(() => container.textContent?.includes("Latest authority setting") === true);
    expect(container.textContent).toContain(preset.label);
    expect(container.querySelector("textarea")).toBeNull();
    expect(writes()).toHaveLength(1);
    await act(async () => root.render(<PresetsDetailPage canWrite id={preset.id} />));
    await act(async () => button("Edit preset")!.click());
    expect(JSON.parse(field("Controls (JSON)").value)).toEqual(preset.controls);
  });

  it("blocks stale preset actions after a confirmed archive whose readback failed", async () => {
    let committed = false;
    let failRead = true;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === "PATCH") {
        committed = true;
        Object.assign(preset, JSON.parse(String(init.body)));
        return Response.json({ ok: true, data: { preset } });
      }
      if (committed && failRead) return Response.json({ ok: false, error: { code: "unavailable", message: "Archived preset read unavailable" } }, { status: 503 });
      return Response.json({ ok: true, data: { preset } });
    });
    await act(async () => root.render(<PresetsDetailPage canWrite id={preset.id} />));
    await waitFor(() => button("Archive preset") !== undefined);
    await act(async () => button("Archive preset")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await changeInput(dialog.querySelector<HTMLInputElement>("input")!, preset.label);
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "Archive preset")!.click());
    await waitFor(() => container.textContent?.includes("Archived preset read unavailable") === true);
    expect(button("Edit preset")!.disabled).toBe(true);
    expect(button("Archive preset")!.disabled).toBe(true);
    expect(container.textContent).not.toContain("is no longer offered to users");
    await act(async () => button("Archive preset")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
    failRead = false;
    await act(async () => button("Retry")!.click());
    await waitFor(() => button("Restore") !== undefined);
    expect(button("Restore")!.disabled).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("removes write controls after permission revocation without submitting the retained draft again", async () => {
    await edit();
    await changeInput(field("Label"), "My permission-sensitive preset");
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => button("Save changes")!.click());
    await act(async () => root.render(<PresetsDetailPage canWrite={false} id={preset.id} />));
    await act(async () => finishWrite(Response.json({ ok: false, error: { code: "forbidden", message: "Missing admin permission" } }, { status: 403 })));
    for (const label of ["Edit preset", "Save changes", "Archive preset", "Restore"]) expect(button(label)).toBeUndefined();
    expect(writes()).toHaveLength(1);
    await act(async () => root.render(<PresetsDetailPage canWrite id={preset.id} />));
    expect(field("Label").value).toBe("My permission-sensitive preset");
    expect(button("Save changes")!.disabled).toBe(false);
  });
});

async function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  throw new Error("Condition did not become true");
}
