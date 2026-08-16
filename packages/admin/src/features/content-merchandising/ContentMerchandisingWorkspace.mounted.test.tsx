// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentMerchandisingWorkspace } from "./ContentMerchandisingWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("ContentMerchandisingWorkspace Featured concurrency", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("sends the loaded version, refreshes on conflict, and preserves the operator draft", async () => {
    let featuredReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path.includes("/api/v2/admin/content/characters")) {
        return Response.json({
          ok: true,
          data: {
            items: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        });
      }
      if (
        path.includes("/api/v2/admin/content/featured") &&
        (init?.method ?? "GET") === "GET"
      ) {
        featuredReads += 1;
        const conflicted = featuredReads > 1;
        return Response.json({
          ok: true,
          data: {
            items: [],
            characterIds: conflicted ? ["character-current"] : ["character-original"],
            configuredCharacterIds: conflicted
              ? ["character-current"]
              : ["character-original"],
            effectiveCharacterIds: [],
            settingVersion: conflicted ? 4 : 3,
            settingDiagnostics: [],
          },
        });
      }
      if (
        path.includes("/api/v2/admin/content/featured") &&
        init?.method === "PUT"
      ) {
        return Response.json({
          ok: false,
          error: {
            code: "conflict",
            message: "Featured configuration changed before this save was applied",
            details: {
              reason: "featured_setting_version_conflict",
              expectedVersion: 3,
              settingVersion: 4,
              configuredCharacterIds: ["character-current"],
            },
          },
        }, { status: 409 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ContentMerchandisingWorkspace canWrite />);
    });
    await waitFor(() => featuredReads === 1);

    const ids = requiredInput('input[placeholder="char_a, char_b"]');
    const reason = requiredInput('input[placeholder="Reason (≥3 chars)"]');
    const confirmation = requiredInput(
      'input[aria-label="Featured confirmation"]',
    );
    await changeInput(ids, "character-draft");
    await changeInput(reason, "keep operator intent");
    await changeInput(confirmation, "character-draft");

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save featured"),
    );
    expect(save).toBeDefined();
    expect(save?.disabled).toBe(false);
    await act(async () => {
      save?.click();
    });
    await waitFor(() => featuredReads === 2);
    await waitFor(() =>
      container.textContent?.includes(
        "Another operator changed Featured before your save.",
      ) ?? false,
    );

    const putCall = fetchMock.mock.calls.find(([, options]) =>
      options?.method === "PUT"
    );
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      characterIds: ["character-draft"],
      expectedVersion: 3,
      reason: "keep operator intent",
      confirmation: "character-draft",
    });
    expect(ids.value).toBe("character-draft");
    expect(reason.value).toBe("keep operator intent");
    expect(confirmation.value).toBe("character-draft");
    expect(container.textContent).toContain(
      "Latest authority was refreshed. Your draft remains in the fields",
    );
    expect(container.textContent).toContain("Current version 4");
    expect(container.textContent).toContain(
      "Current configured IDs: character-current",
    );
  });

  it("surfaces dirty-history diagnostics from the canonical authority DTO", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/api/v2/admin/content/characters")) {
        return Response.json({
          ok: true,
          data: {
            items: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        });
      }
      return Response.json({
        ok: true,
        data: {
          items: [],
          characterIds: ["character-a"],
          configuredCharacterIds: ["character-a"],
          effectiveCharacterIds: [],
          settingVersion: 12,
          settingDiagnostics: [
            {
              code: "character_id_duplicate",
              message: "Featured character character-a is duplicated.",
              index: 1,
              id: "character-a",
            },
            {
              code: "character_id_overflow",
              message: "Featured character character-z exceeds the limit.",
              index: 24,
              id: "character-z",
            },
          ],
        },
      });
    }));

    await act(async () => {
      root.render(<ContentMerchandisingWorkspace canWrite />);
    });
    await waitFor(() =>
      container.textContent?.includes(
        "Stored Featured configuration needs repair",
      ) ?? false,
    );

    expect(container.textContent).toContain("character id duplicate");
    expect(container.textContent).toContain("character-a");
    expect(container.textContent).toContain("Position 2");
    expect(container.textContent).toContain("character id overflow");
    expect(container.textContent).toContain("Configuration version 12");
  });

  function requiredInput(selector: string) {
    const input = container.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`Missing input ${selector}`);
    return input;
  }
});

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Condition did not become true");
}
