// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
    relationshipArchetype: "trusted companion",
    characterPromise: "A dependable conversational presence",
    personality: "Warm and observant",
    tone: "Natural and concise",
    backstory: "A complete restored backstory.",
    firstMessage: "Where should we begin?",
    exampleDialogue: ["Tell me what matters most."],
  },
  visualDirection: {
    identityAnchor: "A recognizable adult companion",
    stableTraits: ["consistent face"],
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
      (button) => button.textContent?.includes("continue"),
    );
    expect(next?.disabled).toBe(true);
    next?.click();
    expect(adminV2Request.mock.calls.some(([, options]) =>
      options?.method === "POST"
    )).toBe(false);
  });

  it("fails closed after restore failure and creates only after explicit start-new confirmation", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/new?draft=existing-character",
    );
    adminV2Request.mockImplementation(async (path, options) => {
      if (
        path ===
          "/api/v2/admin/characters/existing-character/project" &&
        !options?.method
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
      (button) => button.textContent?.includes("continue"),
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

    const enabledNext = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("continue"),
    );
    expect(enabledNext?.disabled).toBe(false);
    await act(async () => {
      enabledNext?.click();
      await Promise.resolve();
    });
    await waitUntil(() => adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    ));
    expect(adminV2Request.mock.calls.filter(([path, options]) =>
      path === "/api/v2/admin/characters" &&
      options?.method === "POST"
    )).toHaveLength(1);
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
        !options?.method
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
        "Adult companion audience"
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
      (button) => button.textContent?.includes("continue"),
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
        !options?.method
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
        "Adult companion audience"
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
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Save positioning & continue") &&
        !button.disabled
      )
    );
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("history unavailable");
    });
    const next = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Save positioning & continue"),
    );
    await act(async () => {
      next?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      container.textContent?.includes("Project version 1") === true
    );
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

    expect(container.textContent).toContain("1.Positioning");
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
