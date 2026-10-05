// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminV2RequestError } from "../api";
import { AdminI18nProvider, translateAdmin } from "../i18n";
import { StartersDetailPage } from "./StartersDetailPage";
import { StartersSection } from "./StartersSection";
import { STARTERS_LIST, type Starter } from "./starters-api";

const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), apiGet, apiWrite }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const starter: Starter = {
  id: "starter-one", scope: "built_in", name: "Original starter", summary: "Original summary",
  gender: "female", style: "anime", appearance: {}, advancedDetails: {}, tags: [],
  isActive: true, sortOrder: 0, updatedAt: "2026-10-01T00:00:00.000Z",
};
function input(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); }

describe("starter detail version protection", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue({ template: starter });
    apiWrite.mockReset().mockResolvedValue({});
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll("button")].find(node => node.textContent === label)!;
  const field = (label: string) => [...container.querySelectorAll("label")].find(node => node.firstChild?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  async function render(locale: "en" | "zh" = "en") {
    await act(async () => root.render(<AdminI18nProvider locale={locale}><StartersDetailPage id={starter.id} canWrite /></AdminI18nProvider>));
    await settle();
  }
  async function renderSection(id: string) {
    await act(async () => root.render(<AdminI18nProvider locale="en"><StartersSection canAssist={false} canWrite view={{ kind: "detail", id }} /></AdminI18nProvider>));
    await settle();
  }
  async function confirm(label: string, name?: string, locale: "en" | "zh" = "en") {
    await act(async () => {
      input(dialog().querySelector<HTMLInputElement>(`[aria-label="${translateAdmin(locale, "Reason (≥3)")}"]`)!, "Correct starter content");
      if (name) input(dialog().querySelector<HTMLInputElement>(`[aria-label="${translateAdmin(locale, "Type the name to confirm")}"]`)!, name);
    });
    await act(async () => button(label, dialog()).click());
  }

  it("shows the stored gender and style in the operator's language", async () => {
    apiGet.mockResolvedValue({ template: { ...starter, style: "realistic" } });
    await render("zh");
    expect(container.textContent).toContain("女性");
    expect(container.textContent).toContain("写实");
    expect(container.textContent).not.toContain("female");
    expect(container.textContent).not.toContain("realistic");
  });

  it("does not carry one starter's edited draft into another public detail route", async () => {
    const other = { ...starter, id: "starter-two", name: "Second starter", summary: "Second summary", updatedAt: "2026-10-02T00:00:00.000Z" };
    apiGet.mockImplementation(async (path: string) => ({ template: path.endsWith(other.id) ? other : starter }));
    await renderSection(starter.id);
    await act(async () => button("Edit profile").click());
    await act(async () => input(field("Name (≥1)"), "Only starter one's unsaved draft"));

    await renderSection(other.id);

    expect(apiGet).toHaveBeenCalledWith(`${STARTERS_LIST}/${other.id}`);
    expect(container.textContent).toContain(other.name);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain(other.summary);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("keeps the current starter when the previous public detail read arrives late", async () => {
    const other = { ...starter, id: "starter-two", name: "Second starter", summary: "Second summary" };
    let resolvePrevious!: (value: { template: Starter }) => void;
    apiGet.mockImplementation((path: string) => path.endsWith(starter.id)
      ? new Promise<{ template: Starter }>((resolve) => { resolvePrevious = resolve; })
      : Promise.resolve({ template: other }));
    await renderSection(starter.id);
    expect(apiGet).toHaveBeenCalledWith(`${STARTERS_LIST}/${starter.id}`);
    await renderSection(other.id);
    expect(container.textContent).toContain(other.name);

    await act(async () => resolvePrevious({ template: starter }));

    expect(container.textContent).toContain(other.name);
    expect(container.textContent).toContain(other.summary);
    expect(container.textContent).not.toContain("Character not found.");
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("keeps the edited draft and its original version after a conflict and retry", async () => {
    apiWrite.mockRejectedValue(new AdminV2RequestError("Version changed", 409, "conflict", { blocker: "version_mismatch" }));
    await render();
    await act(async () => button("Edit profile").click());
    await act(async () => input(field("Name (≥1)"), "Operator draft"));
    await act(async () => button("Save changes").click());
    await confirm("Save changes");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Someone changed this record");
    expect(field("Name (≥1)").value).toBe("Operator draft");
    expect(apiWrite).toHaveBeenLastCalledWith(`${STARTERS_LIST}/${starter.id}`, "PATCH", expect.objectContaining({ name: "Operator draft", expectedUpdatedAt: starter.updatedAt }));

    await confirm("Save changes");
    expect(apiWrite.mock.calls[1][2]).toEqual(apiWrite.mock.calls[0][2]);
    expect(field("Name (≥1)").value).toBe("Operator draft");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Someone changed this record");
  });

  it("uses the freshly loaded version when editing after a successful save", async () => {
    await render();
    await act(async () => button("Edit profile").click());
    await act(async () => input(field("Name (≥1)"), "Operator draft"));
    await act(async () => button("Save changes").click());
    const saved = { ...starter, name: "Operator draft", updatedAt: "2026-10-01T00:00:00.002Z" };
    apiGet.mockResolvedValue({ template: saved });
    await confirm("Save changes");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Edit profile").click());
    await act(async () => button("Save changes").click());
    await confirm("Save changes");
    expect(apiWrite).toHaveBeenLastCalledWith(`${STARTERS_LIST}/${starter.id}`, "PATCH", expect.objectContaining({ expectedUpdatedAt: saved.updatedAt }));
  });

  it("does not replace the draft version when a language change reloads the current starter", async () => {
    await render();
    await act(async () => button("Edit profile").click());
    await act(async () => input(field("Name (≥1)"), "Operator draft"));
    apiGet.mockResolvedValue({ template: { ...starter, name: "Someone else's changes", updatedAt: "2026-10-01T00:00:01.000Z" } });
    await render("zh");
    await act(async () => button(translateAdmin("zh", "Save changes")).click());
    await confirm(translateAdmin("zh", "Save changes"), undefined, "zh");
    expect(apiWrite).toHaveBeenLastCalledWith(`${STARTERS_LIST}/${starter.id}`, "PATCH", expect.objectContaining({ name: "Operator draft", expectedUpdatedAt: starter.updatedAt }));
  });

  it.each([true, false])("pins the confirmed name and version for an initially active=%s starter", async (isActive) => {
    apiGet.mockResolvedValue({ template: { ...starter, isActive } });
    await render();
    const action = isActive ? "Offline" : "Publish";
    await act(async () => button(action).click());
    apiGet.mockResolvedValue({ template: { ...starter, name: "Someone else's changes", updatedAt: "2026-10-01T00:00:01.000Z" } });
    await render("zh");
    expect(dialog().textContent).toContain(starter.name);
    expect(dialog().textContent).not.toContain("Someone else's changes");
    await confirm(translateAdmin("zh", action), starter.name, "zh");
    expect(apiWrite).toHaveBeenLastCalledWith(`${STARTERS_LIST}/${starter.id}/active`, "POST", {
      active: !isActive, reason: "Correct starter content", confirmation: starter.id, expectedUpdatedAt: starter.updatedAt,
    });
  });
});
