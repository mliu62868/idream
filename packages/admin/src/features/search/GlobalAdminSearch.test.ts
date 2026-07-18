import { describe, expect, it } from "vitest";
import type { GlobalAdminSearchResponse } from "@idream/shared/admin";
import {
  INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
  globalAdminSearchFailed,
  globalAdminSearchSucceeded,
  globalAdminSearchUnavailableMessage,
} from "./GlobalAdminSearch";

const result: GlobalAdminSearchResponse["items"][number] = {
  kind: "customer",
  id: "user-1",
  title: "Amy",
  subtitle: "amy@example.test",
  href: "/admin/customers?customer=user-1",
  status: "active",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

describe("Global Admin Search authority state", () => {
  it("keeps the last good results when a later authority request fails", () => {
    const available = globalAdminSearchSucceeded(
      INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
      "amy",
      [result],
    );
    const unavailable = globalAdminSearchFailed(available);

    expect(unavailable).toEqual({
      availability: "unavailable",
      items: [result],
      lastGoodQuery: "amy",
    });
    expect(globalAdminSearchUnavailableMessage(unavailable)).toBe(
      'Search unavailable. Showing last successful results for "amy".',
    );
  });

  it("does not pretend an unavailable empty cache is a valid empty search", () => {
    const unavailable = globalAdminSearchFailed(
      INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
    );

    expect(unavailable.items).toEqual([]);
    expect(globalAdminSearchUnavailableMessage(unavailable)).toBe(
      "Search unavailable. No cached results are available.",
    );
  });

  it("distinguishes a cached empty result from no successful result", () => {
    const available = globalAdminSearchSucceeded(
      INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
      "nobody",
      [],
    );
    const unavailable = globalAdminSearchFailed(available);

    expect(globalAdminSearchUnavailableMessage(unavailable)).toBe(
      'Search unavailable. The last successful search for "nobody" returned no results.',
    );
  });
});
