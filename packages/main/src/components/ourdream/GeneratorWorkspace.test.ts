import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCharacterById,
  loadGeneratorLooksForViewer,
  loadGeneratorWorkspaceInitialData,
} from "./GeneratorWorkspace";

describe("generator target character lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a real 404 as a missing character", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(fetchCharacterById("missing")).resolves.toBeNull();
  });

  it("does not turn a target-character service failure into a missing character", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { message: "Character service unavailable." },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    await expect(fetchCharacterById("target")).rejects.toThrow(
      "Character service unavailable.",
    );
  });
});

describe("generator saved Looks authority", () => {
  it("does not run the protected Looks loader for an anonymous viewer", async () => {
    const loadLooks = vi.fn(async () => undefined);

    await loadGeneratorLooksForViewer(false, loadLooks);

    expect(loadLooks).not.toHaveBeenCalled();
  });

  it("runs the protected Looks loader for an authenticated viewer", async () => {
    const loadLooks = vi.fn(async () => undefined);

    await loadGeneratorLooksForViewer(true, loadLooks);

    expect(loadLooks).toHaveBeenCalledOnce();
  });
});

describe("generator viewer data bootstrap", () => {
  it("loads public configuration and characters without anonymous protected requests", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => false),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(loaders);

    expect(loaders.loadConfig).toHaveBeenCalledOnce();
    expect(loaders.loadCharacters).toHaveBeenCalledOnce();
    expect(loaders.loadJobs).not.toHaveBeenCalled();
    expect(loaders.loadMedia).not.toHaveBeenCalled();
    expect(loaders.loadPresets).not.toHaveBeenCalled();
    expect(loaders.loadIdentityMedia).not.toHaveBeenCalled();
  });

  it("loads protected generation data after authentication resolves", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => true),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(loaders);

    expect(loaders.loadJobs).toHaveBeenCalledOnce();
    expect(loaders.loadMedia).toHaveBeenCalledOnce();
    expect(loaders.loadPresets).toHaveBeenCalledOnce();
    expect(loaders.loadIdentityMedia).toHaveBeenCalledOnce();
  });

  it("keeps protected generation data unresolved when config authority fails", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => null),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(loaders);

    expect(loaders.loadJobs).not.toHaveBeenCalled();
    expect(loaders.loadMedia).not.toHaveBeenCalled();
    expect(loaders.loadPresets).not.toHaveBeenCalled();
    expect(loaders.loadIdentityMedia).not.toHaveBeenCalled();
  });
});
