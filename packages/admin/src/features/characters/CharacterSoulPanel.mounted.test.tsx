// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterSoulPanel } from "./CharacterSoulPanel";
import { characterWorkspaceDetail } from "./character-workspace-fixture";

const operation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation: operation }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data = characterWorkspaceDetail({
  soul: { current: { soul: { name: "Mira", age: 31, gender: "female", characterPromise: "A careful listener", detailsMarkdown: "" } } },
  preview: { draft: { opening: { firstMessage: "Hello." } } },
});

describe("Soul draft retention", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const runCommittedMutation = vi.fn();
  let actor = "";
  let sequence = 0;

  beforeEach(() => {
    sessionStorage.clear();
    actor = `operator-${++sequence}`;
    runCommittedMutation.mockReset();
    operation.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  async function render(actorId = actor, workspace = data) {
    await act(async () => {
      root.render(<CharacterSoulPanel actorId={actorId} data={workspace} canWrite runCommittedMutation={runCommittedMutation} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  function editName() {
    const input = container.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mira draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function leavePanel() { act(() => root.render(null)); }

  it("restores unsaved input after leaving and returning without a write", async () => {
    await render();
    editName();
    leavePanel();
    await render();
    expect(container.querySelector("input")!.value).toBe("Mira draft");
    expect(container.textContent).toContain("Unsaved draft");
    expect(runCommittedMutation).not.toHaveBeenCalled();
  });

  it("does not reuse another operator's draft", async () => {
    await render(); editName(); leavePanel();
    await render("other-operator");
    expect(container.querySelector("input")!.value).toBe("Mira");
  });

  it("updates a clean editor when authority refreshes", async () => {
    await render();
    await render(actor, { ...data, project: { ...data.project, version: data.project.version + 1 } });
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Soul version");
    expect(save?.disabled).toBe(false);
    expect(container.textContent).not.toContain("older version");
  });

  it("does not reuse another character's draft", async () => {
    await render(); editName(); leavePanel();
    await render(actor, { ...data, character: { ...data.character, id: "other-character" } });
    expect(container.querySelector("input")!.value).toBe("Mira");
  });

  it("keeps stale text available but blocks saving against a newer version", async () => {
    await render(); editName(); leavePanel();
    await render(actor, { ...data, project: { ...data.project, version: data.project.version + 1 } });
    expect(container.querySelector("input")!.value).toBe("Mira draft");
    expect(container.textContent).toContain("older version");
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Soul version");
    expect(save?.disabled).toBe(true);
  });
  it("keeps the latest edit across refresh and remount when storage writes fail", async () => {
    await render();
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    editName();
    await render(actor, { ...data });
    expect(container.querySelector("input")!.value).toBe("Mira draft");
    leavePanel();
    await render();
    expect(container.querySelector("input")!.value).toBe("Mira draft");
  });

  it("discards without resurrecting stale storage when removal fails", async () => {
    await render(); editName();
    vi.spyOn(window.sessionStorage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard draft")!;
    await act(async () => discard.click());
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Discard draft") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(container.querySelector("input")!.value).toBe("Mira");
    leavePanel(); await render();
    expect(container.querySelector("input")!.value).toBe("Mira");
    expect(container.textContent).not.toContain("Unsaved draft");
  });

  it("keeps input and confirmation open when a save fails", async () => {
    await render(); editName();
    runCommittedMutation.mockRejectedValueOnce(new Error("Save failed"));
    const create = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Soul version")!;
    await act(async () => create.click());
    const reason = document.querySelector('[role="dialog"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "Update persona");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Create Soul version") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector("input")!.value).toBe("Mira draft");
    expect(container.textContent).toContain("Unsaved draft");
  });

  it("does not resurrect a committed draft if browser storage cannot be cleared", async () => {
    await render(); editName();
    operation.mockResolvedValueOnce({});
    runCommittedMutation.mockImplementationOnce(async ({ commit }) => ({ result: await commit(), refreshed: true }));
    vi.spyOn(window.sessionStorage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    const create = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Soul version")!;
    await act(async () => create.click());
    const reason = document.querySelector('[role="dialog"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "Update persona");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Create Soul version") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(operation).toHaveBeenCalledWith("POST /api/v2/admin/characters/:id/soul/versions", expect.objectContaining({
      ifMatch: data.project.version,
      body: expect.objectContaining({ expectedContentVersionId: data.soul.current.contentVersionId, persona: expect.objectContaining({ name: "Mira draft" }) }),
    }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("Unsaved draft");
    leavePanel(); await render();
    expect(container.textContent).not.toContain("Unsaved draft");
  });

});
