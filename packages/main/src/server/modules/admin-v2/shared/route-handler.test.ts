import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminGrantBundleKeySchema, globalAdminSearchResponseSchema } from "@idream/shared/admin";
import { adminV2ContractFixtures } from "@idream/shared/admin/testing/contract-fixtures";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
import { IdempotencyConflictError } from "./control-plane-command";
import { jsonBody, multipartFields, parseRequestInput, queryParams } from "./authority";
import { adminV2Route } from "./route-handler";

const savedViewsUrl = "http://localhost/api/v2/admin/saved-views";

function get(url: string) {
  return new Request(url);
}

/** A payload the operation's declared contract actually admits. */
function validSavedViewList() {
  return adminV2ContractFixtures("savedViewListResponseSchema").valid;
}

describe("Admin v2 route seam", () => {
  afterEach(() => vi.restoreAllMocks());
  it("preserves an explicitly declared media stream and filters private headers", async () => {
    const request = get("http://localhost/api/v2/admin/characters/character-1/media-library/entry-1/content");
    const media = new Response(new Uint8Array([255, 0, 128]), { status: 206, headers: {
      "content-type": "video/mp4", "cache-control": "private, no-store", "accept-ranges": "bytes", "content-range": "bytes 1-3/4", "x-private-storage-key": "secret",
    } });
    const response = await adminV2Route(request, () => media);
    expect(media.bodyUsed).toBe(false);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-3/4");
    expect(response.headers.get("x-private-storage-key")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 0, 128]));
  });

  it("does not bypass content authentication or unknown-operation admission", async () => {
    const authorizedPath = get("http://localhost/api/v2/admin/characters/character-1/media-library/entry-1/content");
    const denied = await adminV2Route(authorizedPath, () => { throw Errors.unauthorized("Login required"); });
    expect(denied.status).toBe(401);
    const execute = vi.fn(() => new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } }));
    const unknown = await adminV2Route(get("http://localhost/api/v2/admin/unknown/content"), execute);
    expect(unknown.status).toBe(500);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses HTML or public caching on the binary operation", async () => {
    const request = get("http://localhost/api/v2/admin/characters/character-1/media-library/entry-1/content");
    for (const headers of [{ "content-type": "text/html", "cache-control": "private, no-store" }, { "content-type": "video/mp4", "cache-control": "public" }]) {
      const response = await adminV2Route(request, () => new Response("private", { headers }));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('"private"');
    }
  });
  it("ships a payload its declared response contract admits", async () => {
    const response = await adminV2Route(get(savedViewsUrl), () => validSavedViewList());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: validSavedViewList() });
  });

  it("refuses a payload outside the contract instead of shipping it", async () => {
    const response = await adminV2Route(get(savedViewsUrl), () => ({ items: [{ nope: true }] }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it.each(["raw", "parsed-in-domain", "response"])(
    "classifies the same invalid server output as internal through %s",
    async (path) => {
      const request = get("http://localhost/api/v2/admin/search?q=portrait");
      const invalid = { items: [], query: "portrait", asOf: "private-invalid-server-value" };
      const response = await adminV2Route(request, () => path === "raw"
        ? invalid
        : path === "response" ? ok(invalid) : globalAdminSearchResponseSchema.parse(invalid));
      expect(response.status).toBe(500);
      const envelope = await response.json();
      expect(envelope).toMatchObject({ ok: false, error: { code: "internal" } });
      expect(JSON.stringify(envelope)).not.toContain("private-invalid-server-value");
      expect(envelope.error).not.toHaveProperty("details.fieldErrors");
    },
  );

  it.each(["body", "query", "path", "multipart"])(
    "keeps invalid %s input a client error at the request ingress",
    async (kind) => {
      const request = kind === "query"
        ? get("http://localhost/api/v2/admin/search?q=x&limit=0")
        : new Request(kind === "multipart"
          ? "http://localhost/api/v2/admin/characters/character-1/image-sources"
          : kind === "path"
            ? "http://localhost/api/v2/admin/users/user-1/grant-bundles/invalid-bundle"
            : savedViewsUrl, {
          method: kind === "path" ? "DELETE" : "POST",
          headers: { "idempotency-key": "invalid-request-fields-key", "content-type": "application/json" },
          body: "{}",
        });
      const response = await adminV2Route(request, () => {
        if (kind === "query") return queryParams(request, "GET /api/v2/admin/search");
        if (kind === "path") return parseRequestInput(adminGrantBundleKeySchema, "invalid-bundle");
        if (kind === "multipart") return multipartFields(request, "POST /api/v2/admin/characters/:id/image-sources", { purpose: "invalid-purpose" });
        return jsonBody(request);
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "bad_request" } });
    },
  );

  it("does not turn an unexpected input parser failure into a client rejection", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const response = await adminV2Route(get(savedViewsUrl), () => parseRequestInput({
      parse: () => { throw new Error("Internal parser configuration failed"); },
    }, {}));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  // INVARIANT: a module that builds its own Response (for a status or Cache-Control it needs)
  // does not thereby buy an exit past the contract — the envelope is re-narrowed from its bytes.
  it("narrows a module-built success Response rather than passing it through", async () => {
    const passing = await adminV2Route(
      get(savedViewsUrl),
      () => ok(validSavedViewList(), { headers: { "cache-control": "no-store" } }),
    );
    expect(passing.status).toBe(200);
    expect(passing.headers.get("cache-control")).toBe("no-store");
    expect(await passing.json()).toEqual({ ok: true, data: validSavedViewList() });

    const drifted = await adminV2Route(get(savedViewsUrl), () => ok({ items: [{ nope: true }] }));
    expect(drifted.status).toBe(500);
  });

  // INTENT: the contract governs what ships, not just what is documented. Admin response
  // contracts are `.strict()`, so an undeclared field is refused outright rather than quietly
  // leaked — a payload that grew a field nobody declared is drift, not a richer answer.
  it("refuses a field the contract does not declare", async () => {
    const response = await adminV2Route(
      get(savedViewsUrl),
      () => ({ ...(validSavedViewList() as object), leakedInternalCursor: "secret" }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("leakedInternalCursor");
  });

  it("lets a domain failure through untouched — an error is not the success contract", async () => {
    const response = await adminV2Route(get(savedViewsUrl), () => {
      throw Errors.forbidden("Saved view scope is out of reach");
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("keeps unexpected authority failures inside the JSON error envelope", async () => {
    const failure = new Error("Prisma client rejected runItemId: null; private database details");
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const request = new Request(savedViewsUrl, { headers: { "x-request-id": "authority-failure-test" } });
    const response = await adminV2Route(request, async () => {
      throw failure;
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "internal", message: "Internal error" },
    });
    expect(logged).toHaveBeenCalledWith({
      err: failure,
      method: "GET",
      path: "/api/v2/admin/saved-views",
      requestId: "authority-failure-test",
    }, "Unhandled Admin v2 route error");
  });

  it("fails closed on a path the manifest does not declare", async () => {
    const response = await adminV2Route(
      get("http://localhost/api/v2/admin/saved-views/v1/undeclared"),
      () => validSavedViewList(),
    );

    expect(response.status).toBe(500);
  });
  it("logs an AppError of status 500 or above, whose details the client never sees", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const response = await adminV2Route(get(savedViewsUrl), () => ({ items: [{ nope: true }] }));

    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ code: "internal", method: "GET", path: "/api/v2/admin/saved-views" }),
      "Admin authority produced a response outside its declared contract",
    );
  });

  it("logs a 5xx response that a module built from its own caught AppError", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const response = await adminV2Route(get(savedViewsUrl), () => Response.json(
      { ok: false, error: { code: "internal", message: "Read model failed" } },
      { status: 500 },
    ));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { message: "Read model failed" } });
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, body: expect.stringContaining("Read model failed") }),
      "Admin v2 route answered with a server error",
    );
  });

  it("does not log an AppError the client caused", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const response = await adminV2Route(get(savedViewsUrl), () => {
      throw Errors.forbidden("Saved view scope is out of reach");
    });

    expect(response.status).toBe(403);
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([
    ["P2025", 404, "not_found"],
    ["P2034", 409, "conflict"],
    ["P2028", 503, "unavailable"],
    ["P2020", 400, "bad_request"],
  ])("maps Prisma %s to %i without leaking its message", async (code, status, errorCode) => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const response = await adminV2Route(get(savedViewsUrl), () => {
      throw new Prisma.PrismaClientKnownRequestError("private query text", { code, clientVersion: "test" });
    });

    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: { code: errorCode } });
    expect(body).not.toContain("private query text");
  });

  it("keeps an unmapped Prisma failure a 500, since it is not the caller's", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const response = await adminV2Route(get(savedViewsUrl), () => {
      throw new Prisma.PrismaClientKnownRequestError("private query text", { code: "P2003", clientVersion: "test" });
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private query text");
  });

  it("answers an idempotency conflict thrown outside commandResponse with 409", async () => {
    const response = await adminV2Route(get(savedViewsUrl), () => {
      throw new IdempotencyConflictError("command-1", "hash-a", "hash-b");
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict", commandId: "command-1" },
    });
  });

  it.each([
    ["a search term", "http://localhost/api/v2/admin/saved-views?q=a%00b"],
    ["a query name", "http://localhost/api/v2/admin/saved-views?a%00b=1"],
    ["a path id", "http://localhost/api/v2/admin/users/user%00id"],
  ])("rejects a NUL byte in %s before the handler runs", async (_name, url) => {
    const execute = vi.fn(() => validSavedViewList());
    const response = await adminV2Route(get(url), execute);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized Idempotency-Key on every route, and admits the longest generated one", async () => {
    const execute = vi.fn(() => validSavedViewList());
    const withKey = (key: string) => new Request(savedViewsUrl, { headers: { "idempotency-key": key } });

    expect((await adminV2Route(withKey("k".repeat(201)), execute)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    // Release canary: `<prefix up to 120>:<uuid>:<iteration>`.
    const canary = `${"p".repeat(120)}:${crypto.randomUUID()}:99999`;
    expect((await adminV2Route(withKey(canary), execute)).status).toBe(200);
  });
});
