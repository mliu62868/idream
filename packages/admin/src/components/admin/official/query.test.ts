import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOfficialListApiQuery,
  buildOfficialListUrlQuery,
  defaultOfficialListQuery,
  observeOfficialListUrl,
  parseOfficialListQuery,
  writeOfficialListUrl,
} from "./query";

describe("Official character list URL query", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("initializes every visible search, filter, and page control from a shareable URL", () => {
    expect(parseOfficialListQuery(new URLSearchParams(
      "search=aurora&gender=female&style=anime&status=approved&page=3",
    ))).toEqual({
      search: "aurora",
      gender: "female",
      style: "anime",
      status: "approved",
      page: 3,
    });
  });

  it("writes navigation state back to the URL without changing the server-side list query", () => {
    const query = {
      search: "aurora sky",
      gender: "female",
      style: "anime",
      status: "approved",
      page: 3,
    } as const;

    expect(buildOfficialListUrlQuery(query).toString()).toBe(
      "search=aurora+sky&gender=female&style=anime&status=approved&page=3",
    );
    expect(buildOfficialListApiQuery(query).toString()).toBe(
      "page=3&limit=24&search=aurora+sky&gender=female&style=anime&status=approved",
    );

    const pushState = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/admin/content/official" },
      history: { pushState, replaceState: vi.fn() },
    });
    writeOfficialListUrl(query, "push");
    expect(pushState).toHaveBeenCalledWith(
      null,
      "",
      "/admin/content/official?search=aurora+sky&gender=female&style=anime&status=approved&page=3",
    );
  });

  it("restores the complete URL state on Back and Forward notifications", () => {
    const target = new EventTarget();
    const restored = vi.fn();
    const location = { search: "?search=aurora&gender=female&style=anime&status=approved&page=3" };
    const cleanup = observeOfficialListUrl(Object.assign(target, { location }), restored);

    target.dispatchEvent(new Event("popstate"));
    location.search = "?search=nova&gender=male&style=realistic&status=draft&page=2";
    target.dispatchEvent(new Event("popstate"));
    cleanup();

    expect(restored).toHaveBeenNthCalledWith(1, {
      search: "aurora",
      gender: "female",
      style: "anime",
      status: "approved",
      page: 3,
    });
    expect(restored).toHaveBeenNthCalledWith(2, {
      search: "nova",
      gender: "male",
      style: "realistic",
      status: "draft",
      page: 2,
    });
  });

  it("fails closed to supported defaults for stale or malformed legacy query values", () => {
    expect(parseOfficialListQuery(new URLSearchParams(
      "search=%20%20&gender=unknown&style=random&status=deleted&page=-8&limit=999",
    ))).toEqual(defaultOfficialListQuery);
  });
});
