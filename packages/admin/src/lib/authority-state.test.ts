import { describe, expect, it } from "vitest";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "./authority-state";

describe("authority query state", () => {
  it("starts without invented data and keeps a first-load failure distinct from empty success", () => {
    const initial = createAuthorityState<string[]>();
    const loading = authorityRequestStarted(initial, "status=pending");
    const failed = authorityRequestFailed(loading, "status=pending", "Unavailable");

    expect(initial.data).toBeNull();
    expect(failed).toMatchObject({
      data: null,
      dataKey: null,
      loading: false,
      error: "Unavailable",
    });
  });

  it("preserves last-good data when the same query fails during refresh", () => {
    const successful = authorityRequestSucceeded(
      "status=pending",
      ["verification-1"],
      "2026-07-16T12:00:00.000Z",
    );
    const refreshing = authorityRequestStarted(successful, "status=pending");
    const failed = authorityRequestFailed(refreshing, "status=pending", "Timeout");

    expect(failed).toMatchObject({
      data: ["verification-1"],
      dataKey: "status=pending",
      loading: false,
      error: "Timeout",
      refreshedAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("clears an old snapshot when the query scope changes", () => {
    const successful = authorityRequestSucceeded(
      "status=pending",
      ["verification-1"],
      "2026-07-16T12:00:00.000Z",
    );
    const loading = authorityRequestStarted(successful, "status=failed");
    const failed = authorityRequestFailed(loading, "status=failed", "Unavailable");

    expect(loading.data).toBeNull();
    expect(failed.data).toBeNull();
    expect(failed.dataKey).toBeNull();
  });

  it("keeps a successful empty result as authoritative data", () => {
    const successful = authorityRequestSucceeded(
      "status=pending",
      [],
      "2026-07-16T12:00:00.000Z",
    );

    expect(successful.data).toEqual([]);
    expect(successful.data).not.toBeNull();
    expect(successful.error).toBeNull();
  });
});
