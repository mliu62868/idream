// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request, routerPush } = vi.hoisted(() => ({
  adminV2Request: vi.fn<
    (
      path: string,
      options?: {
        readonly method?: string;
        readonly idempotencyKey?: string;
        readonly body?: unknown;
      },
    ) => Promise<unknown>
  >(),
  routerPush: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import { CharacterCreateWizard } from "./CharacterCreateWizard";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  beginDurableMutationIntent,
  readActiveDurableMutationIntent,
} from "@/lib/durable-mutation-intent";

const restoredDraft = {
  persona: {
    name: "Mira",
    age: 24,
    gender: "female",
    characterPromise: "A dependable conversational presence",
    detailsMarkdown:
      "## Personality\nWarm and observant.\n\n## Voice\nNatural and concise.\n\n## Background\nA complete restored backstory.",
    firstMessage: "Where should we begin?",
  },
  visualDirection: {
    identityAnchor: "A recognizable adult companion",
    stableTraits: ["dark wavy hair"],
    style: "realistic",
    referenceDirection: "Natural portrait light",
  },
};

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Character create wizard");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

async function openReviewSection(container: HTMLElement, sectionIndex: number) {
  const edit = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === "Edit",
  )[sectionIndex];
  await act(async () => edit?.click());
}

describe("Character create wizard restore authority", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    routerPush.mockReset();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    window.history.replaceState(null, "", "/admin/characters/new");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("retains every field when autofill updates the persona in one render batch", async () => {
    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(() => container.querySelector("fieldset")?.disabled === false);

    const values = {
      "persona.name": "Mira",
      "persona.characterPromise": "A dependable conversational presence",
      "persona.firstMessage": "Where should we begin?",
      "persona.detailsMarkdown": "Warm and observant.",
    };
    await act(async () => {
      for (const [name, value] of Object.entries(values)) {
        const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
        const prototype = input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    for (const [name, value] of Object.entries(values)) {
      expect(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value, name).toBe(value);
    }
    await waitUntil(() => container.textContent?.includes("Saved locally") === true);
    const saved = JSON.parse(window.localStorage.getItem("idream.admin.character-create-draft.v3:operator-a")!);
    expect(saved.persona).toMatchObject({
      name: values["persona.name"],
      characterPromise: values["persona.characterPromise"],
      firstMessage: values["persona.firstMessage"],
      detailsMarkdown: values["persona.detailsMarkdown"],
    });
  });

  it("returns a rejected placeholder from Review to the editable field", async () => {
    window.localStorage.setItem("idream.admin.character-create-draft.v3:operator-a", JSON.stringify({
      ...restoredDraft,
      persona: { ...restoredDraft.persona, name: "Untitled companion" },
    }));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save character")!;
    await act(async () => save.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const name = container.querySelector<HTMLInputElement>('[name="persona.name"]');
    expect(name).not.toBeNull();
    expect(name?.getAttribute("aria-invalid")).toBe("true");
    expect(name?.labels?.[0]?.textContent).toBe("Name");
    expect(document.getElementById(name!.getAttribute("aria-describedby")!)?.textContent).toBe("Replace the placeholder with real character information.");
    expect(document.activeElement).toBe(name);
    expect(container.textContent).toContain("Replace the placeholder with real character information.");
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("preserves spaces and newlines while typing stable visual traits", async () => {
    window.localStorage.setItem("idream.admin.character-create-draft.v3:operator-a", JSON.stringify({
      ...restoredDraft,
      visualDirection: { ...restoredDraft.visualDirection, stableTraits: [] },
    }));
    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(() => container.querySelector('[name="visualDirection.stableTraits"]') !== null);
    const input = container.querySelector<HTMLTextAreaElement>('[name="visualDirection.stableTraits"]')!;
    const text = "Brown eyes\nDark brown hair\n\nLight freckles ";
    for (const letter of text) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, input.value + letter);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(input.value).toBe(text);
    const saved = JSON.parse(window.localStorage.getItem("idream.admin.character-create-draft.v3:operator-a")!);
    expect(saved.visualDirection.stableTraits).toEqual(["Brown eyes", "Dark brown hair", "Light freckles"]);
  });

  it("shows the optional Markdown limit at the editable field and focuses it", async () => {
    window.localStorage.setItem("idream.admin.character-create-draft.v3:operator-a", JSON.stringify({
      ...restoredDraft,
      persona: { ...restoredDraft.persona, detailsMarkdown: "x".repeat(24_001) },
    }));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.querySelector<HTMLTextAreaElement>('[name="persona.detailsMarkdown"]')?.value.length === 24_001);
    const next = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Continue to visual direction"))!;
    await act(async () => next.click());
    await waitUntil(() => container.querySelector('[name="persona.detailsMarkdown"]')?.getAttribute("aria-invalid") === "true");
    const details = container.querySelector('[name="persona.detailsMarkdown"]')!;
    expect(container.textContent).toContain("Additional details must be 24000 characters or fewer.");
    expect(document.activeElement).toBe(details);
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("allows revisiting completed steps and keeps data without creating early", async () => {
    window.localStorage.setItem("idream.admin.character-create-draft.v3:operator-a", JSON.stringify(restoredDraft));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    const persona = container.querySelector("ol button") as HTMLButtonElement;
    await act(async () => persona.click());
    expect(container.querySelector<HTMLInputElement>('[name="persona.name"]')?.value).toBe("Mira");
    expect(document.activeElement?.id).toBe("character-create-current-step");
    const visual = container.querySelectorAll<HTMLButtonElement>("ol button")[1];
    await act(async () => visual.click());
    expect(container.querySelector<HTMLTextAreaElement>('[name="visualDirection.stableTraits"]')?.value).toBe("dark wavy hair");
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("discards a local creation draft only after confirmation without writing a character", async () => {
    const storageKey = "idream.admin.character-create-draft.v3:operator-a";
    window.localStorage.setItem(storageKey, JSON.stringify(restoredDraft));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Discard draft")!.click());
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === "Discard draft")!;
    await act(async () => confirm.click());
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[name="persona.name"]')?.value).toBe("");
    expect(adminV2Request).not.toHaveBeenCalled();
  });

  it("lets an assigned editor resume an authorized draft without offering creation", async () => {
    window.history.replaceState(null, "", "/admin/characters/new?draft=assigned-character");
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/assigned-character/project") && options?.method === "GET") return {
        authority: { characterId: "assigned-character", projectId: "assigned-project", projectVersion: 3, deepLink: "/admin/characters/assigned-character" },
        draft: restoredDraft,
      };
      throw new Error("Unexpected write");
    });
    await act(async () => root.render(<CharacterCreateWizard actorId="scoped-operator" canCreate={false} canResumeDraft />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    expect(container.textContent).toContain("Saved to server");
    expect(container.textContent).not.toContain("Start a new Character instead");
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save character")!;
    await act(async () => save.click());
    expect(routerPush).toHaveBeenCalledWith("/admin/characters/assigned-character");
    expect(adminV2Request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("allows returning to an earlier step with invalid unsaved server-draft values", async () => {
    window.history.replaceState(null, "", "/admin/characters/new?draft=assigned-character");
    adminV2Request.mockImplementation(async () => ({
      authority: { characterId: "assigned-character", projectId: "assigned-project", projectVersion: 3, deepLink: "/admin/characters/assigned-character" },
      draft: restoredDraft,
    }));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    await openReviewSection(container, 1);
    const anchor = container.querySelector<HTMLTextAreaElement>('[name="visualDirection.identityAnchor"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(anchor, "");
      anchor.dispatchEvent(new Event("input", { bubbles: true }));
      [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Back")!.click();
    });
    expect(container.querySelector('[name="persona.name"]')).not.toBeNull();
    expect(adminV2Request.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("2."))!.click());
    expect(container.querySelector<HTMLTextAreaElement>('[name="visualDirection.identityAnchor"]')?.value).toBe("");
    expect(adminV2Request.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });

  it("locks review edits during the final save and unlocks after a rejected write", async () => {
    window.history.replaceState(null, "", "/admin/characters/new?draft=assigned-character");
    const pendingWrites: Array<{ resolve(value: unknown): void; reject(cause: unknown): void }> = [];
    adminV2Request.mockImplementation(async (_path, options) => {
      if (options?.method === "PATCH") return new Promise((resolve, reject) => pendingWrites.push({ resolve, reject }));
      return { authority: { characterId: "assigned-character", projectId: "assigned-project", projectVersion: 3, deepLink: "/admin/characters/assigned-character" }, draft: restoredDraft };
    });
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    await openReviewSection(container, 1);
    const reference = container.querySelector<HTMLTextAreaElement>('[name="visualDirection.referenceDirection"]')!;
    const editReference = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reference, value);
      reference.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await editReference("Warm light A");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Continue")!.click());
    await waitUntil(() => pendingWrites.length === 1);
    await editReference("Warm light B");
    await act(async () => pendingWrites[0]!.resolve({ version: 4 }));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save character")!.click());
    await waitUntil(() => pendingWrites.length === 2);
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(routerPush).not.toHaveBeenCalled();
    await act(async () => pendingWrites[1]!.reject(new AdminV2RequestError("Rejected", 400, "bad_request")));
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Warm light B");
  });

  it("guards leaving a server draft while autosave has not committed the edit", async () => {
    window.history.replaceState(null, "", "/admin/characters/new?draft=assigned-character");
    adminV2Request.mockImplementation(async () => ({
      authority: { characterId: "assigned-character", projectId: "assigned-project", projectVersion: 3, deepLink: "/admin/characters/assigned-character" },
      draft: restoredDraft,
    }));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate />));
    await waitUntil(() => container.textContent?.includes("Persona & conversation") === true);
    await openReviewSection(container, 0);
    const name = container.querySelector<HTMLInputElement>('[name="persona.name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Unsaved Mira");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="/admin/characters"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === "Cancel")!;
    await act(async () => cancel.click());
    expect(name.value).toBe("Unsaved Mira");
    expect(adminV2Request.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });

  it("locks navigation before a requested draft has been checked", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    adminV2Request.mockImplementation(() => new Promise(() => undefined));

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });

    const next = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.toLowerCase().includes("continue"),
    );
    expect(next?.disabled).toBe(true);
    next?.click();
    expect(
      adminV2Request.mock.calls.some(
        ([, options]) => options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("hydrates a blank server snapshot before restoring a complete local draft", async () => {
    const browserWindow = window;
    vi.stubGlobal("window", undefined);
    const serverMarkup = renderToString(
      <CharacterCreateWizard actorId="operator-hydration" canCreate />,
    );
    vi.unstubAllGlobals();
    expect(window).toBe(browserWindow);
    window.localStorage.setItem(
      "idream.admin.character-create-draft.v3:operator-hydration",
      JSON.stringify(restoredDraft),
    );

    const hydrationContainer = document.createElement("div");
    hydrationContainer.innerHTML = serverMarkup;
    document.body.append(hydrationContainer);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let hydrationRoot: Root | null = null;
    try {
      await act(async () => {
        hydrationRoot = hydrateRoot(
          hydrationContainer,
          <CharacterCreateWizard actorId="operator-hydration" canCreate />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitUntil(
        () =>
          hydrationContainer.textContent?.includes(
            "Creating saves a private, inactive draft",
          ) === true,
      );
      expect(hydrationContainer.textContent).toContain(
        "Required information complete.",
      );
      expect(hydrationContainer.textContent).toContain("Review & create");
      expect(hydrationContainer.textContent).toContain("Saved locally");
      expect(hydrationContainer.textContent).toContain(
        "Creating saves a private, inactive draft",
      );
      const personaSummary = [...hydrationContainer.querySelectorAll("h3")].find(
        (heading) => heading.textContent?.trim() === "Persona & conversation",
      );
      const technicalDetails = hydrationContainer.querySelector<HTMLDetailsElement>(
        '[data-testid="character-create-soul-preview"]',
      );
      expect(personaSummary).toBeTruthy();
      expect(technicalDetails).toBeTruthy();
      if (!personaSummary || !technicalDetails) {
        throw new Error("Review hierarchy was not rendered");
      }
      expect(
        personaSummary.compareDocumentPosition(technicalDetails) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(technicalDetails.open).toBe(false);
      expect(technicalDetails.querySelector("summary")?.textContent).toContain(
        "Technical details",
      );
      expect(technicalDetails.textContent).toContain(
        "SOUL.md · exact Agent prompt",
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await act(async () => hydrationRoot?.unmount());
      hydrationContainer.remove();
    }
  });

  it("explains invalid persona fields and moves focus to the first correction", async () => {
    await act(async () => {
      root.render(
        <CharacterCreateWizard actorId="operator-validation" canCreate />,
      );
    });
    await waitUntil(
      () =>
        container.textContent?.includes("Continue to visual direction") ===
        true,
    );

    const age = container.querySelector<HTMLInputElement>(
      'input[name="persona.age"]',
    );
    await act(async () => {
      if (age) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(age, "121");
        age.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const next = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Continue to visual direction"),
    );
    expect(next?.disabled).toBe(false);

    await act(async () => {
      next?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const name = container.querySelector<HTMLInputElement>(
      'input[name="persona.name"]',
    );
    expect(name?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
    expect(age?.getAttribute("aria-invalid")).toBe("true");
    expect(age?.max).toBe("120");
    expect(container.textContent).toContain("Enter a character name.");
    expect(container.textContent).toContain(
      "Age must be a whole number from 18 to 120.",
    );
    expect(container.textContent).toContain(
      "Write the first message users will receive.",
    );
  });

  it("keeps edits in memory without claiming local persistence when browser storage rejects writes", async () => {
    window.localStorage.setItem(
      "idream.admin.character-create-draft.v3:operator-storage-denied",
      JSON.stringify(restoredDraft),
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage access denied", "SecurityError");
    });

    await act(async () => {
      root.render(
        <CharacterCreateWizard actorId="operator-storage-denied" canCreate />,
      );
    });
    await waitUntil(
      () =>
        container.textContent?.includes(
          "Creating saves a private, inactive draft",
        ) === true,
    );
    const soulPreview = container.querySelector(
      '[data-testid="character-create-soul-preview"]',
    );
    expect(soulPreview?.textContent).toContain("# Mira — Character Soul");
    expect(soulPreview?.textContent).not.toContain("Relationship:");
    expect(soulPreview?.textContent).toContain("## Additional details");
    expect(soulPreview?.textContent).toContain("Warm and observant.");
    await openReviewSection(container, 0);

    const additionalDetails = container.querySelector("textarea");
    await act(async () => {
      if (additionalDetails) {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(additionalDetails, "Updated only in this tab");
        additionalDetails.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    expect(container.querySelector("textarea")?.value).toBe(
      "Updated only in this tab",
    );
    expect(container.textContent).toContain("In memory only");
    expect(container.textContent).not.toContain("Saved locally");

    const next = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Continue to visual direction") &&
        !button.disabled,
    );
    await act(async () => next?.click());
    expect(container.textContent).toContain("Persona");
    expect(container.textContent).toContain("In memory only");
    expect(container.textContent).not.toContain("Saved locally");

    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Back") && !button.disabled,
    );
    await act(async () => back?.click());
    expect(container.querySelector("textarea")?.value).toBe(
      "Updated only in this tab",
    );
  });

  it("directs a non-resumable character to its settings without offering an ineffective retry", async () => {
    window.history.replaceState(null, "", "/admin/characters/new?draft=character-old");
    adminV2Request.mockRejectedValue(new AdminV2RequestError(
      "Character has no resumable project draft", 409, "conflict", { reason: "draft_not_resumable" },
    ));
    await act(async () => root.render(<CharacterCreateWizard actorId="operator-a" canCreate={false} canResumeDraft />));
    await waitUntil(() => container.textContent?.includes("This character has no resumable creation draft.") === true);
    expect(container.querySelector('a[href="/admin/characters/character-old?tab=soul"]')?.textContent).toBe("Open character settings");
    expect(container.textContent).not.toContain("Retry restore");
    expect(container.textContent).not.toContain("Start a new Character instead");
    expect(adminV2Request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("fails closed after restore failure and returns to a blank local draft only after explicit confirmation", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path === "/api/v2/admin/characters/existing-character/project" &&
        options?.method === "GET"
      ) {
        throw new Error("restore unavailable");
      }
      if (path === "/api/v2/admin/characters" && options?.method === "POST") {
        return {
          characterId: "new-character",
          characterContentVersionId: "new-content",
          projectId: "new-project",
          revisionId: "new-revision",
          projectVersion: 1,
          contentVersion: 1,
          deepLink: "/admin/characters/new-character",
          replayed: false,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(
      () =>
        container.textContent?.includes(
          "The requested server draft was not restored.",
        ) === true,
    );
    const lockedNext = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.toLowerCase().includes("continue"),
    );
    expect(lockedNext?.disabled).toBe(true);
    expect(
      adminV2Request.mock.calls.some(
        ([, options]) => options?.method === "POST",
      ),
    ).toBe(false);

    const startNew = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Start a new Character instead"),
    );
    await act(async () => startNew?.click());
    const confirm = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Confirm start new"),
    );
    await act(async () => confirm?.click());
    expect(window.location.search).toBe("");

    const blankNext = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.toLowerCase().includes("continue"),
    );
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(blankNext?.disabled).toBe(false);
    expect(
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("retries restore and then patches the existing Project without creating another Character", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    let restoreAttempts = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path === "/api/v2/admin/characters/existing-character/project" &&
        options?.method === "GET"
      ) {
        restoreAttempts += 1;
        if (restoreAttempts === 1) throw new Error("temporary restore failure");
        return {
          authority: {
            characterId: "existing-character",
            projectId: "existing-project",
            projectVersion: 3,
            deepLink: "/admin/characters/existing-character",
          },
          draft: restoredDraft,
        };
      }
      if (
        path === "/api/v2/admin/characters/existing-character/project" &&
        options?.method === "PATCH"
      ) {
        return { version: 4 };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(
      () => container.textContent?.includes("Retry restore") === true,
    );
    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry restore"),
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    await waitUntil(
      () =>
        container.textContent?.includes(
          "Creating saves a private, inactive draft",
        ) === true,
    );
    await openReviewSection(container, 0);
    const additionalDetails = container.querySelector("textarea");
    await act(async () => {
      if (additionalDetails) {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(additionalDetails, "Updated restored details");
        additionalDetails.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    const next = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.toLowerCase().includes("continue"),
    );
    await act(async () => {
      next?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters/existing-character/project" &&
          options?.method === "PATCH",
      ),
    );
    expect(
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("restores a legacy instructional draft but blocks its final production handoff", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=legacy-character",
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path === "/api/v2/admin/characters/legacy-character/project" &&
        options?.method === "GET"
      ) {
        return {
          authority: {
            characterId: "legacy-character",
            projectId: "legacy-project",
            projectVersion: 2,
            deepLink: "/admin/characters/legacy-character",
          },
          draft: {
            ...restoredDraft,
            persona: {
              ...restoredDraft.persona,
              name: "Untitled companion",
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(
      () =>
        container.textContent?.includes(
          "Creating saves a private, inactive draft",
        ) === true,
    );
    const finish = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save character"),
    );
    // SPEC: 遗留占位名可以恢复为草稿，但最终创建必须要求替换，并返回对应编辑字段。
    expect(finish?.disabled).toBe(false);
    await act(async () => finish?.click());
    expect(container.textContent).toContain(
      "Correct the highlighted fields to continue.",
    );
    expect(
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("isolates an unresolved new-Character intent while an explicit server draft is restored", async () => {
    beginDurableMutationIntent({
      scope: "character-project:create:operator-a",
      signature: "unresolved-new-character",
      requestSnapshot: {
        ...restoredDraft,
        reason: {
          code: "character_wizard_started",
          summary: "Create a server-authoritative Character draft",
        },
        confirmation: "CREATE CHARACTER",
      },
      createIdempotencyKey: () => "unresolved-new-character-key",
    });
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path === "/api/v2/admin/characters/existing-character/project" &&
        options?.method === "GET"
      ) {
        return {
          authority: {
            characterId: "existing-character",
            projectId: "existing-project",
            projectVersion: 3,
            deepLink: "/admin/characters/existing-character",
          },
          draft: restoredDraft,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(
      () =>
        container.textContent?.includes(
          "Creating saves a private, inactive draft",
        ) === true,
    );
    await openReviewSection(container, 0);
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.textContent).not.toContain(
      "A Character creation request is unresolved",
    );
    expect(
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toBe(false);
    expect(
      readActiveDurableMutationIntent({
        scope: "character-project:create:operator-a",
      })?.idempotencyKey,
    ).toBe("unresolved-new-character-key");
  });

  it("clears the committed creation receipt before non-authoritative URL synchronization", async () => {
    window.localStorage.setItem(
      "idream.admin.character-create-draft.v3:operator-a",
      JSON.stringify(restoredDraft),
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === "/api/v2/admin/characters" && options?.method === "POST") {
        return {
          characterId: "created-character",
          characterContentVersionId: "created-content",
          projectId: "created-project",
          revisionId: "created-revision",
          projectVersion: 1,
          contentVersion: 1,
          deepLink: "/admin/characters/created-character",
          replayed: false,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(
      () =>
        container.textContent?.includes(
          "Creating saves a private, inactive draft",
        ) === true,
    );
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.includes("Save character") && !button.disabled,
      ),
    );
    expect(
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toBe(false);
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("history unavailable");
    });
    const finish = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save character"),
    );
    await act(async () => {
      finish?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    );
    expect(container.textContent).toContain("Private server draft · version 1");
    expect(
      readActiveDurableMutationIntent({
        scope: "character-project:create:operator-a",
      }),
    ).toBeNull();
    expect(container.textContent).toContain(
      "The Character was created, but this tab URL could not be updated.",
    );
    expect(
      adminV2Request.mock.calls.filter(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(routerPush).toHaveBeenCalledWith(
      "/admin/characters/created-character",
    );
    expect(
      window.localStorage.getItem(
        "idream.admin.character-create-draft.v3:operator-a",
      ),
    ).toBeNull();
  });

  it("shows a neutral recovery result and does not advance after sealing an uncommitted Character key", async () => {
    beginDurableMutationIntent({
      scope: "character-project:create:operator-a",
      signature: "legacy-character-create",
      now: 1,
      createIdempotencyKey: () => "legacy-character-key",
      requestSnapshot: {
        ...restoredDraft,
        reason: {
          code: "character_wizard_started",
          summary: "Create a server-authoritative Character draft",
        },
        confirmation: "CREATE CHARACTER",
      },
    });
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path === "/api/v2/admin/mutation-receipts/reconcile" &&
        options?.method === "POST"
      ) {
        return {
          state: "cancelled",
          commandType: "character.project.create",
          commandId: "cancelled-character-command",
          status: "cancelled",
          committedTargetId: null,
          verification: null,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CharacterCreateWizard actorId="operator-a" canCreate />);
    });
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.includes("Reconcile saved request") &&
          !button.disabled,
      ),
    );
    const reconcile = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Reconcile saved request"),
    );
    await act(async () => {
      reconcile?.click();
      await Promise.resolve();
    });
    await waitUntil(
      () =>
        container.textContent?.includes("Its key was sealed on the server") ===
        true,
    );

    expect(container.textContent).toContain("1.Persona");
    expect(container.textContent).not.toContain("Failed to save");
    expect(
      readActiveDurableMutationIntent({
        scope: "character-project:create:operator-a",
      }),
    ).toBeNull();
    expect(
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/characters" && options?.method === "POST",
      ),
    ).toBe(false);
  });
});
