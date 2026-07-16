import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCharacterById } from "./GeneratorWorkspace";

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
