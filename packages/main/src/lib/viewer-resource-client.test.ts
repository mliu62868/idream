import { describe, expect, it, vi } from "vitest";
import {
  apiEnvelopeErrorMessage,
  loadViewerResource,
  requestErrorMessage,
} from "./viewer-resource-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetcherReturning(response: Response | Promise<never>) {
  return vi.fn(async () => (response instanceof Response ? response : response));
}

const identity = (raw: unknown) => raw;

describe("loadViewerResource", () => {
  it("returns the parsed value on a 2xx envelope", async () => {
    const outcome = await loadViewerResource(
      {
        path: "/api/v1/generation/jobs?limit=20",
        parse: (raw) => (raw as { data: { items: number[] } }).data.items,
        fallbackError: "Jobs could not load.",
      },
      fetcherReturning(jsonResponse({ ok: true, data: { items: [1, 2] } })),
    );

    expect(outcome).toEqual({ kind: "loaded", data: [1, 2] });
  });

  it("passes path and init through verbatim without inventing a cache default", async () => {
    // INVARIANT: ProfileWorkspace's reads deliberately omit `cache: "no-store"`
    // while GeneratorWorkspace's set it. A default here would silently change
    // one of them.
    const fetcher = fetcherReturning(jsonResponse({ ok: true }));
    const signal = new AbortController().signal;

    await loadViewerResource(
      {
        path: "/api/v1/media?type=image",
        parse: identity,
        fallbackError: "nope",
        init: { cache: "no-store", signal },
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith("/api/v1/media?type=image", {
      cache: "no-store",
      signal,
    });
  });

  it("omits init entirely when the caller passes none", async () => {
    const fetcher = fetcherReturning(jsonResponse({ ok: true }));

    await loadViewerResource(
      { path: "/api/v1/library/recent", parse: identity, fallbackError: "nope" },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith("/api/v1/library/recent", undefined);
  });

  it("surfaces the envelope error message on a non-2xx response", async () => {
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: identity,
        fallbackError: "Jobs could not load.",
        },
      fetcherReturning(
        jsonResponse({ ok: false, error: { message: "Rate limited." } }, 429),
      ),
    );

    expect(outcome).toEqual({ kind: "failed", error: "Rate limited." });
  });

  it("falls back when a failing response carries no envelope message", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Jobs could not load." },
      fetcherReturning(jsonResponse({ ok: false }, 500)),
    );

    expect(outcome).toEqual({ kind: "failed", error: "Jobs could not load." });
  });

  it("falls back when the envelope message is blank", async () => {
    // Matches the old `throw new Error("")` → `error.message || fallback` path:
    // an empty banner would be worse than the generic sentence.
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Gallery could not load." },
      fetcherReturning(jsonResponse({ ok: false, error: { message: "" } }, 500)),
    );

    expect(outcome).toEqual({ kind: "failed", error: "Gallery could not load." });
  });

  it("treats an unparseable failure body as a plain failure", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Saved presets could not load." },
      fetcherReturning(new Response("<html>502</html>", { status: 502 })),
    );

    expect(outcome).toEqual({
      kind: "failed",
      error: "Saved presets could not load.",
    });
  });

  it("hands the parser null when a 2xx body is not JSON", async () => {
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: (raw) => ({ seen: raw }),
        fallbackError: "nope",
      },
      fetcherReturning(new Response("", { status: 200 })),
    );

    expect(outcome).toEqual({ kind: "loaded", data: { seen: null } });
  });
});

describe("loadViewerResource staleness", () => {
  it("discards a superseded response instead of applying it", async () => {
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: identity,
        fallbackError: "nope",
        isCurrent: () => false,
      },
      fetcherReturning(jsonResponse({ ok: true, data: { items: [1] } })),
    );

    expect(outcome).toEqual({ kind: "discarded" });
  });

  it("discards a superseded FAILURE without raising an error banner", async () => {
    // This is the regression the open-coded copies kept re-introducing: a slow
    // 500 from a previous viewer scope must not paint an error over fresh data.
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: identity,
        fallbackError: "Jobs could not load.",
        isCurrent: () => false,
      },
      fetcherReturning(jsonResponse({ ok: false, error: { message: "boom" } }, 500)),
    );

    expect(outcome).toEqual({ kind: "discarded" });
  });

  it("checks staleness only after the body has been read", async () => {
    const calls: string[] = [];
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: identity,
        fallbackError: "nope",
        isCurrent: () => {
          calls.push("isCurrent");
          return true;
        },
      },
      vi.fn(async () => {
        calls.push("fetch");
        return jsonResponse({ ok: true });
      }),
    );

    expect(calls).toEqual(["fetch", "isCurrent"]);
    expect(outcome.kind).toBe("loaded");
  });

  it("is current by default when the caller has no staleness notion", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "nope" },
      fetcherReturning(jsonResponse({ ok: true })),
    );

    expect(outcome.kind).toBe("loaded");
  });

  it("discards a rejection that arrives after the request went stale", async () => {
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: identity,
        fallbackError: "Jobs could not load.",
        isCurrent: () => false,
      },
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    expect(outcome).toEqual({ kind: "discarded" });
  });
});

describe("loadViewerResource failures", () => {
  it("discards an aborted request", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Jobs could not load." },
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );

    expect(outcome).toEqual({ kind: "discarded" });
  });

  it("keeps an ordinary Error named AbortError as a real failure", async () => {
    // INVARIANT: only a DOMException counts as an abort, matching the original
    // `error instanceof DOMException` test.
    const impostor = new Error("Upstream aborted the stream.");
    impostor.name = "AbortError";

    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Jobs could not load." },
      vi.fn(async () => {
        throw impostor;
      }),
    );

    expect(outcome).toEqual({
      kind: "failed",
      error: "Upstream aborted the stream.",
    });
  });

  it("reports a network rejection with its own message", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Jobs could not load." },
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    expect(outcome).toEqual({ kind: "failed", error: "Failed to fetch" });
  });

  it("falls back when a rejection carries no message", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Jobs could not load." },
      vi.fn(async () => {
        throw new Error("");
      }),
    );

    expect(outcome).toEqual({ kind: "failed", error: "Jobs could not load." });
  });

  it("falls back when the rejection is not an Error at all", async () => {
    const outcome = await loadViewerResource(
      { path: "/x", parse: identity, fallbackError: "Gallery could not load." },
      vi.fn(async () => {
        throw "string throw";
      }),
    );

    expect(outcome).toEqual({ kind: "failed", error: "Gallery could not load." });
  });

  it("routes a malformed payload rejected by the parser to the failure path", async () => {
    const outcome = await loadViewerResource(
      {
        path: "/x",
        parse: () => {
          throw new Error("Jobs payload was malformed.");
        },
        fallbackError: "Jobs could not load.",
      },
      fetcherReturning(jsonResponse({ ok: true, data: null })),
    );

    expect(outcome).toEqual({
      kind: "failed",
      error: "Jobs payload was malformed.",
    });
  });
});

describe("apiEnvelopeErrorMessage", () => {
  it("reads a well-formed envelope", () => {
    expect(apiEnvelopeErrorMessage({ error: { message: "nope" } })).toBe("nope");
  });

  it.each([
    ["null", null],
    ["an array", [{ message: "nope" }]],
    ["a bare string", "nope"],
    ["a missing error", { ok: false }],
    ["a non-object error", { error: "nope" }],
    ["an array error", { error: [{ message: "nope" }] }],
    ["a non-string message", { error: { message: 42 } }],
  ])("returns undefined for %s", (_label, payload) => {
    expect(apiEnvelopeErrorMessage(payload)).toBeUndefined();
  });
});

describe("requestErrorMessage", () => {
  it("prefers the error's own message", () => {
    expect(requestErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it.each([
    ["a blank message", new Error("")],
    ["a non-Error", { message: "boom" }],
    ["undefined", undefined],
  ])("falls back for %s", (_label, error) => {
    expect(requestErrorMessage(error, "fallback")).toBe("fallback");
  });
});
