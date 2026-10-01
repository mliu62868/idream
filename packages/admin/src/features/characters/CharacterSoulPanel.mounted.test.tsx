// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterSoulPanel } from "./CharacterSoulPanel";
import { characterWorkspaceDetail, withCharacterWorkspaceDetail } from "./character-workspace-fixture";
import { AdminV2RequestError } from "@/lib/admin-v2-api";

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
  function typeInto(label: string, value: string) {
    const field = [...container.querySelectorAll("label")].find((item) => item.firstChild?.textContent === label)!
      .querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function saveButton() {
    return [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
  }
  function committingMutation() {
    operation.mockResolvedValueOnce({});
    runCommittedMutation.mockImplementationOnce(async ({ commit }) => ({ result: await commit(), refreshed: true }));
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

  it("distinguishes a paused published character from a never-published draft", async () => {
    await render();
    expect(container.textContent).toContain("This Character has not been published yet.");
    await render(actor, withCharacterWorkspaceDetail(data, {
      preview: { live: null, changedFields: ["new_release"] },
      journey: { release: { currentReleaseId: "release-2", servingState: "paused" } },
    }));
    expect(container.textContent).toContain("has a published version but is currently offline");
    expect(container.textContent).not.toContain("has not been published yet");
  });

  it("does not reuse another operator's draft", async () => {
    await render(); editName(); leavePanel();
    await render("other-operator");
    expect(container.querySelector("input")!.value).toBe("Mira");
  });

  it("updates a clean editor when authority refreshes", async () => {
    await render();
    await render(actor, { ...data, project: { ...data.project, version: data.project.version + 1 } });
    expect(saveButton().disabled).toBe(true);
    editName();
    expect(saveButton().disabled).toBe(false);
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
    expect(saveButton().disabled).toBe(true);
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

  it("keeps the edited input when a save fails", async () => {
    await render(); editName();
    runCommittedMutation.mockRejectedValueOnce(new Error("Save failed"));
    await act(async () => saveButton().click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("input")!.value).toBe("Mira draft");
    expect(container.textContent).toContain("Unsaved draft");
    expect(container.textContent).toContain("Save failed");
  });

  it.each([
    [{ blocker: "version_mismatch" }, "Someone changed this record before your action landed."],
    [{ blocker: "draft_revision_missing" }, "The authority refused this action: its precondition is not met."],
  ])("uses the authority's conflict reason and preserves the request ID: %j", async (details, headline) => {
    await render(); editName();
    runCommittedMutation.mockRejectedValueOnce(new AdminV2RequestError("Authority reason", 409, "conflict", details, "soul-request-123"));
    await act(async () => saveButton().click());
    expect(container.textContent).toContain(headline);
    expect(container.textContent).toContain("soul-request-123");
    expect(container.textContent).toContain("Authority reason");
    expect(container.querySelector("input")!.value).toBe("Mira draft");
  });

  it("saves in one click without a reason and does not resurrect the committed draft", async () => {
    await render(); editName();
    committingMutation();
    vi.spyOn(window.sessionStorage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    await act(async () => saveButton().click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(operation).toHaveBeenCalledWith("POST /api/v2/admin/characters/:id/soul/versions", expect.objectContaining({
      ifMatch: data.project.version,
      body: {
        entityVersion: data.project.version,
        expectedContentVersionId: data.soul.current.contentVersionId,
        persona: expect.objectContaining({ name: "Mira draft" }),
      },
    }));
    expect(container.textContent).not.toContain("Unsaved draft");
    leavePanel(); await render();
    expect(container.textContent).not.toContain("Unsaved draft");
  });

  it("sends an edited appearance only once it is complete", async () => {
    await render();
    typeInto("Identity anchor", "Composed late-night radio host");
    await act(async () => saveButton().click());
    expect(operation).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Add at least one stable visual trait.");
    expect(container.textContent).toContain("Describe the portrait's visual direction.");

    typeInto("Stable traits (one per line)", "Dark wavy hair\nWarm brown eyes\n");
    typeInto("Reference direction", "Low-key tungsten portraiture");
    expect(container.textContent).not.toContain("Add at least one stable visual trait.");
    committingMutation();
    await act(async () => saveButton().click());
    expect(operation).toHaveBeenCalledWith("POST /api/v2/admin/characters/:id/soul/versions", expect.objectContaining({
      body: expect.objectContaining({
        visualDirection: {
          identityAnchor: "Composed late-night radio host",
          stableTraits: ["Dark wavy hair", "Warm brown eyes"],
          style: "realistic",
          referenceDirection: "Low-key tungsten portraiture",
        },
      }),
    }));
  });

  it("points saved but unpublished changes to Release", async () => {
    await render(actor, { ...data, preview: { ...data.preview, live: data.preview.draft, changedFields: ["persona"] } });
    expect(container.textContent).toContain("Saved changes are not live yet.");
    expect(container.querySelector('a[href$="?tab=release"]')?.textContent).toBe("Go to Release");
  });

  it("identifies an oversized trait locally and focuses the rejected field", async () => {
    await render();
    typeInto("Identity anchor", "Adult radio host");
    typeInto("Stable traits (one per line)", "x".repeat(501));
    typeInto("Reference direction", "Warm portrait lighting");
    await act(async () => saveButton().click());
    expect(operation).not.toHaveBeenCalled();
    expect(runCommittedMutation).not.toHaveBeenCalled();
    const rejected = container.querySelector<HTMLTextAreaElement>('textarea[aria-invalid="true"]');
    expect(rejected).not.toBeNull();
    expect(rejected?.value).toHaveLength(501);
    expect(document.activeElement).toBe(rejected);
    expect(container.textContent).toContain("Each stable visual trait must be 500 characters or fewer.");
    expect(document.getElementById(rejected!.getAttribute("aria-describedby")!)?.textContent).toContain("500");
  });

  it("reports an oversized optional Markdown field before attempting a write", async () => {
    await render();
    typeInto("Additional details · Markdown (optional)", "x".repeat(24_001));
    await act(async () => saveButton().click());
    expect(runCommittedMutation).not.toHaveBeenCalled();
    expect(container.querySelector('textarea[aria-invalid="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Additional details must be 24000 characters or fewer.");
  });
});
