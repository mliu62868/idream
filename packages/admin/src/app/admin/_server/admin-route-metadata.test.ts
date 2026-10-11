import { describe, expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => ({ locale: "en" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "idream.admin.locale" ? { value: preferences.locale } : undefined }),
  headers: async () => new Headers(),
}));

import { generateMetadata as catchAllMetadata } from "../[[...section]]/page";
import { generateMetadata as characterMetadata } from "../characters/[id]/page";
import { generateMetadata as newCharacterMetadata } from "../characters/new/page";
import { generateMetadata as creativeMetadata } from "../creative/runs/page";
import { generateMetadata as jobsMetadata } from "../ops/jobs/page";

describe("shared Admin route metadata", () => {
  it.each(["en", "zh"])("keeps explicit and catch-all titles identical in %s", async (locale) => {
    preferences.locale = locale;
    const searchParams = Promise.resolve({});
    const catchAll = (section: string[]) => catchAllMetadata({ params: Promise.resolve({ section }), searchParams });
    expect(await newCharacterMetadata({ searchParams })).toEqual(await catchAll(["characters", "new"]));
    expect(await creativeMetadata({ searchParams })).toEqual(await catchAll(["creative", "runs"]));
    for (const id of ["character-1", "releases", "calendar"]) {
      expect(await characterMetadata({ params: Promise.resolve({ id }), searchParams })).toEqual(await catchAll(["characters", id]));
    }
    const title = (await newCharacterMetadata({ searchParams })).title;
    expect(title).toBe(locale === "en" ? "New Character | iDream Admin" : "新建角色 | iDream Admin");
  });

  it("resolves a query-backed subview consistently, including repeated parameters", async () => {
    preferences.locale = "en";
    const searchParams = Promise.resolve({ view: ["dead-letter", "jobs"] });
    const explicit = await jobsMetadata({ searchParams });
    expect(explicit).toEqual(await catchAllMetadata({ params: Promise.resolve({ section: ["ops", "jobs"] }), searchParams }));
    expect(explicit.title).toBe("Dead-letter | iDream Admin");
    expect(explicit.robots).toEqual({ index: false, follow: false });
  });
});
