import { afterEach, describe, expect, it, vi } from "vitest";
import { shareOrCopy } from "./utils";

afterEach(() => vi.unstubAllGlobals());

describe("shareOrCopy across browser sharing capabilities", () => {
  const url = "https://idream.example/feed?item=collection-1";

  it.each(["shared", "cancelled"])("leaves native %s feedback to the browser without copying", async (outcome) => {
    const share = outcome === "shared"
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new DOMException("User dismissed sharing", "AbortError"));
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { share, clipboard: { writeText } });

    expect(await shareOrCopy(url, "iDream")).toBe("");
    expect(share).toHaveBeenCalledWith({ title: "iDream", url });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the exact link when native sharing is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await shareOrCopy(url, "iDream")).toBe("Share link copied.");
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it("offers the exact link when native sharing and clipboard access fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard denied", "NotAllowedError"));
    vi.stubGlobal("navigator", {
      share: vi.fn().mockRejectedValue(new DOMException("Share denied", "NotAllowedError")),
      clipboard: { writeText },
    });
    expect(await shareOrCopy(url, "iDream")).toBe(`Share link: ${url}`);
    expect(writeText).toHaveBeenCalledWith(url);
  });
});
