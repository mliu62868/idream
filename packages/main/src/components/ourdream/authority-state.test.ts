import { describe, expect, it } from "vitest";
import {
  authorityShowsEmpty,
  failedAuthorityStatus,
  initialAuthorityStatus,
  loadingAuthorityStatus,
  loadingAuthorityStatusForScope,
  profileAuthorityStateForResponse,
  readyAuthorityStatus,
} from "./authority-state";

describe("authority state", () => {
  it("does not present an unresolved initial request as a real empty result", () => {
    const status = initialAuthorityStatus();

    expect(status).toEqual({
      phase: "loading",
      error: null,
      hasSnapshot: false,
    });
    expect(authorityShowsEmpty(status, 0)).toBe(false);
  });

  it("presents zero items as empty only after a successful response", () => {
    const status = readyAuthorityStatus();

    expect(status.hasSnapshot).toBe(true);
    expect(authorityShowsEmpty(status, 0)).toBe(true);
    expect(authorityShowsEmpty(status, 1)).toBe(false);
  });

  it("retains the last-good snapshot while refreshing", () => {
    const status = loadingAuthorityStatus(readyAuthorityStatus());

    expect(status).toEqual({
      phase: "loading",
      error: null,
      hasSnapshot: true,
    });
    expect(authorityShowsEmpty(status, 0)).toBe(false);
  });

  it("drops a snapshot when the authority query scope changes", () => {
    const status = loadingAuthorityStatusForScope(
      readyAuthorityStatus(),
      false,
    );

    expect(status).toEqual({
      phase: "loading",
      error: null,
      hasSnapshot: false,
    });
  });

  it("retains a snapshot when retrying the same authority query scope", () => {
    const status = loadingAuthorityStatusForScope(
      readyAuthorityStatus(),
      true,
    );

    expect(status.hasSnapshot).toBe(true);
  });

  it("retains the last-good snapshot when a refresh fails", () => {
    const status = failedAuthorityStatus(
      readyAuthorityStatus(),
      "Service unavailable",
    );

    expect(status).toEqual({
      phase: "error",
      error: "Service unavailable",
      hasSnapshot: true,
    });
    expect(authorityShowsEmpty(status, 0)).toBe(false);
  });

  it("keeps an initial failure distinct from an empty result", () => {
    const status = failedAuthorityStatus(
      initialAuthorityStatus(),
      "Service unavailable",
    );

    expect(status.hasSnapshot).toBe(false);
    expect(authorityShowsEmpty(status, 0)).toBe(false);
  });
});

describe("profile authority", () => {
  it.each([
    [{ status: 200, ok: true }, "authenticated"],
    [{ status: 401, ok: false }, "anonymous"],
    [{ status: 403, ok: false }, "error"],
    [{ status: 500, ok: false }, "error"],
  ] as const)(
    "maps response $status/$ok to $1",
    (response, expected) => {
      expect(profileAuthorityStateForResponse(response)).toBe(expected);
    },
  );
});
