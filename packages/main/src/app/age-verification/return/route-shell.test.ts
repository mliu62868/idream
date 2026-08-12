import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/age-verification/return",
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

import Page, { metadata } from "./page";

describe("canonical age verification return route", () => {
  it("renders a deterministic app shell while status authority is loading", async () => {
    const render = async () => renderToString(await Page({
      searchParams: Promise.resolve({ next: "/generate?mode=image" }),
    }));

    const serverMarkup = await render();
    expect(await render()).toBe(serverMarkup);
    expect(serverMarkup).toContain("ourdream.ai");
    expect(serverMarkup).toContain("Checking your verification");
    expect(serverMarkup).toContain('role="status"');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("sanitizes the resume target before it reaches the client boundary", async () => {
    const markup = renderToString(await Page({
      searchParams: Promise.resolve({ next: "//attacker.example/steal" }),
    }));

    expect(markup).not.toContain("attacker.example");
  });
});
