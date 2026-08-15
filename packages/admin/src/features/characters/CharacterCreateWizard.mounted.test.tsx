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
import {
  beginDurableMutationIntent,
  readActiveDurableMutationIntent,
} from "@/lib/durable-mutation-intent";

const restoredDraft = {
  positioning: {
    audience: "Adult companion audience",
    companionNeed: "Reliable evening companionship",
    hypothesis: "Consistency builds trust",
    differentiation: "A precise and observant point of view",
  },
  persona: {
    name: "Mira",
    age: 24,
    gender: "female",
    relationshipArchetype: "steady confidante",
    characterPromise: "A dependable conversational presence",
    personality: "Warm and observant",
    tone: "Natural and concise",
    backstory: "A complete restored backstory.",
    firstMessage: "Where should we begin?",
    exampleDialogue: ["Tell me what matters most."],
  },
  visualDirection: {
    identityAnchor: "A recognizable adult companion",
    stableTraits: ["dark wavy hair"],
    style: "realistic",
    referenceDirection: "Natural portrait light",
  },
  commercialIntent: {
    ownerId: null,
    plannedLaunchAt: null,
    targetPlacementKeys: [],
    successCriteria: ["Restore without duplication"],
    productionPackage: "Portrait, hero, and chat assets",
    qaPlan: "Verify desktop and mobile",
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

describe("Character create wizard restore authority", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
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

  it("locks navigation before a requested draft has been checked", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    adminV2Request.mockImplementation(() => new Promise(() => undefined));

    await act(async () => {
      root.render(
        <CharacterCreateWizard
          actorId="operator-a"
          canCreate
        />,
      );
    });

    const next = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.toLowerCase().includes("continue"),
    );
    expect(next?.disabled).toBe(true);
    next?.click();
    expect(adminV2Request.mock.calls.some(([, options]) =>
      options?.method === "POST"
    )).toBe(false);
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
      "idream.admin.character-create-draft.v1:operator-hydration",
      JSON.stringify(restoredDraft),
    );

    const hydrationContainer = document.createElement("div");
    hydrationContainer.innerHTML = serverMarkup;
    document.body.append(hydrationContainer);
    const consoleError = vi.spyOn(console, "error").mockImplementation(
      () => undefined,
    );
    let hydrationRoot: Root | null = null;
    try {
      await act(async () => {
        hydrationRoot = hydrateRoot(
          hydrationContainer,
          <CharacterCreateWizard actorId="operator-hydration" canCreate />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitUntil(() =>
        hydrationContainer.querySelector("textarea")?.value ===
          "A dependable conversational presence"
      );
      expect(hydrationContainer.textContent).toContain(
        "Required information complete.",
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await act(async () => hydrationRoot?.unmount());
      hydrationContainer.remove();
    }
  });

  it("keeps edits in memory without claiming local persistence when browser storage rejects writes", async () => {
    window.localStorage.setItem(
      "idream.admin.character-create-draft.v1:operator-storage-denied",
      JSON.stringify(restoredDraft),
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage access denied", "SecurityError");
    });

    await act(async () => {
      root.render(
        <CharacterCreateWizard
          actorId="operator-storage-denied"
          canCreate
        />,
      );
    });
    await waitUntil(() =>
      container.querySelector("textarea")?.value ===
        "A dependable conversational presence"
    );

    const audience = container.querySelector("textarea");
    await act(async () => {
      if (audience) {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(audience, "Updated only in this tab");
        audience.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("fails closed after restore failure and returns to a blank local draft only after explicit confirmation", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path ===
          "/api/v2/admin/characters/existing-character/project" &&
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
      root.render(
        <CharacterCreateWizard
          actorId="operator-a"
          canCreate
        />,
      );
    });
    await waitUntil(() =>
      container.textContent?.includes(
        "The requested server draft was not restored.",
      ) === true
    );
    const lockedNext = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.toLowerCase().includes("continue"),
    );
    expect(lockedNext?.disabled).toBe(true);
    expect(adminV2Request.mock.calls.some(([, options]) =>
      options?.method === "POST"
    )).toBe(false);

    const startNew = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Start a new Character instead"),
    );
    await act(async () => startNew?.click());
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Confirm start new"),
    );
    await act(async () => confirm?.click());
    expect(window.location.search).toBe("");

    const blankNext = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.toLowerCase().includes("continue"),
    );
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(blankNext?.disabled).toBe(true);
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toBe(false);
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
        path ===
          "/api/v2/admin/characters/existing-character/project" &&
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
        path ===
          "/api/v2/admin/characters/existing-character/project" &&
        options?.method === "PATCH"
      ) {
        return { version: 4 };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CharacterCreateWizard
          actorId="operator-a"
          canCreate
        />,
      );
    });
    await waitUntil(() =>
      container.textContent?.includes("Retry restore") === true
    );
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Retry restore"),
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      container.querySelector("textarea")?.value ===
        "A dependable conversational presence"
    );
    const audience = container.querySelector("textarea");
    await act(async () => {
      if (audience) {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(audience, "Updated restored audience");
        audience.dispatchEvent(
          new Event("input", { bubbles: true }),
        );
      }
    });

    const next = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.toLowerCase().includes("continue"),
    );
    await act(async () => {
      next?.click();
      await Promise.resolve();
    });
    await waitUntil(() => adminV2Request.mock.calls.some(([path, options]) =>
      path ===
        "/api/v2/admin/characters/existing-character/project" &&
      options?.method === "PATCH"
    ));
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toBe(false);
  });

  it("restores a legacy instructional draft but blocks its final production handoff", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=legacy-character",
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path ===
          "/api/v2/admin/characters/legacy-character/project" &&
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
            positioning: {
              ...restoredDraft.positioning,
              audience: "Define the adult audience for this companion",
            },
          },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CharacterCreateWizard actorId="operator-a" canCreate />,
      );
    });
    await waitUntil(() =>
      container.querySelector("textarea")?.value ===
        "A dependable conversational presence"
    );
    for (let index = 0; index < 2; index += 1) {
      const advance = [...container.querySelectorAll("button")].find(
        (button) =>
          button.textContent?.toLowerCase().includes("continue") &&
          !button.disabled,
      );
      await act(async () => advance?.click());
    }

    await waitUntil(() => container.textContent?.includes(
      "Visual identity",
    ) === true);
    const finish = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(
        "Save character & open portrait studio",
      ),
    );
    // SPEC: 遗留草稿里的 instructional sentinel 仍然拦住最终创建，即使它落在向导已不再渲染的
    // positioning 字段上——production-ready 校验吃的是整份草稿，不是当前这一屏。
    expect(finish?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Review the character before creating it.",
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toBe(false);
  });

  it("isolates an unresolved new-Character intent while an explicit server draft is restored", async () => {
    beginDurableMutationIntent({
      scope: "character-project:create:operator-a",
      signature: "unresolved-new-character",
      requestSnapshot: {
        ...restoredDraft,
        reason: {
          code: "character_wizard_started",
          summary: "Create a server-authoritative Character Project draft",
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
        path ===
          "/api/v2/admin/characters/existing-character/project" &&
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
      root.render(
        <CharacterCreateWizard actorId="operator-a" canCreate />,
      );
    });
    await waitUntil(() =>
      container.querySelector("textarea")?.value ===
        "A dependable conversational presence"
    );
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.textContent).not.toContain(
      "A Character creation request is unresolved",
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toBe(false);
    expect(readActiveDurableMutationIntent({
      scope: "character-project:create:operator-a",
    })?.idempotencyKey).toBe("unresolved-new-character-key");
  });

  it("clears the committed creation receipt before non-authoritative URL synchronization", async () => {
    window.localStorage.setItem(
      "idream.admin.character-create-draft.v1:operator-a",
      JSON.stringify(restoredDraft),
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path === "/api/v2/admin/characters" &&
        options?.method === "POST"
      ) {
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
      root.render(
        <CharacterCreateWizard actorId="operator-a" canCreate />,
      );
    });
    for (const label of ["Continue to visual direction", "Continue"]) {
      await waitUntil(() =>
        [...container.querySelectorAll("button")].some((button) =>
          button.textContent?.includes(label) &&
          !button.disabled
        )
      );
      const advance = [...container.querySelectorAll("button")].find(
        (button) =>
          button.textContent?.includes(label) &&
          !button.disabled,
      );
      await act(async () => {
        advance?.click();
        await Promise.resolve();
      });
    }
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes(
          "Save character & open portrait studio",
        ) &&
        !button.disabled
      )
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toBe(false);
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("history unavailable");
    });
    const finish = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes(
          "Save character & open portrait studio",
        ),
    );
    await act(async () => {
      finish?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path, options]) =>
        path === "/api/v2/admin/characters" &&
        options?.method === "POST"
      )
    );
    expect(container.textContent).toContain("Project version 1");
    expect(readActiveDurableMutationIntent({
      scope: "character-project:create:operator-a",
    })).toBeNull();
    expect(container.textContent).toContain(
      "The Character was created, but this tab URL could not be updated.",
    );
    expect(adminV2Request.mock.calls.filter(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toHaveLength(1);
    expect(routerPush).toHaveBeenCalledWith(
      "/admin/characters/created-character?tab=assets",
    );
    expect(window.localStorage.getItem(
      "idream.admin.character-create-draft.v1:operator-a",
    )).toBeNull();
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
          summary:
            "Create a server-authoritative Character Project draft",
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
      root.render(
        <CharacterCreateWizard actorId="operator-a" canCreate />,
      );
    });
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reconcile saved request") &&
        !button.disabled
      )
    );
    const reconcile = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Reconcile saved request"),
    );
    await act(async () => {
      reconcile?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      container.textContent?.includes(
        "Its key was sealed on the server",
      ) === true
    );

    expect(container.textContent).toContain("1.Persona");
    expect(container.textContent).not.toContain("Failed to save");
    expect(readActiveDurableMutationIntent({
      scope: "character-project:create:operator-a",
    })).toBeNull();
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toBe(false);
  });
});
