import { describe, expect, it } from "vitest";
import { requireExecutableAdminV2Contract } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { adminV2Route } from "./route-handler";

const savedViewsUrl = "http://localhost/api/v2/admin/saved-views";

function get(url: string) {
  return new Request(url);
}

/** A payload the operation's declared contract actually admits. */
function validSavedViewList() {
  return requireExecutableAdminV2Contract("savedViewListResponseSchema").fixtures.valid;
}

describe("Admin v2 route seam", () => {
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

  it("fails closed on a path the manifest does not declare", async () => {
    const response = await adminV2Route(
      get("http://localhost/api/v2/admin/saved-views/v1/undeclared"),
      () => validSavedViewList(),
    );

    expect(response.status).toBe(500);
  });
});
