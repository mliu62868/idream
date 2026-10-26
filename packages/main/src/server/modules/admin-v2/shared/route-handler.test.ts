import { afterEach, describe, expect, it, vi } from "vitest";
import { adminGrantBundleKeySchema, globalAdminSearchResponseSchema } from "@idream/shared/admin";
import { adminV2ContractFixtures } from "@idream/shared/admin/testing/contract-fixtures";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
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
});
