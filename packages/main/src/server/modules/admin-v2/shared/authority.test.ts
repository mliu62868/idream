import { describe, expect, it } from "vitest";
import { jsonBody, queryParams } from "./authority";

function writeRequest(pathname: string, body: unknown, headers: HeadersInit = {}) {
  return new Request(`https://admin.test${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const caseDecision = {
  entityVersion: 3,
  decision: "actioned",
  summary: "Refunded the disputed charge",
  evidenceRefs: ["https://example.test/evidence"],
};

describe("Admin v2 request body authority", () => {
  it("parses a write body with the schema the manifest declares for that route", async () => {
    const request = writeRequest(
      "/api/v2/admin/cases/case-1/decisions",
      caseDecision,
      { "idempotency-key": "key-1" },
    );

    // The typed result is already narrowed — no handler-side re-parse involved.
    await expect(jsonBody(request, "caseDecisionRequestSchema+idempotency-key"))
      .resolves.toEqual(caseDecision);
  });

  it("fails closed when a handler names a contract the manifest does not own", async () => {
    const request = writeRequest(
      "/api/v2/admin/cases/case-1/decisions",
      caseDecision,
      { "idempotency-key": "key-1" },
    );

    // Adjacent, real, same-domain schema — the drift that used to pass silently because
    // the manifest narrowed first and the handler narrowed again.
    await expect(
      jsonBody(request, "caseVerificationRequestSchema+idempotency-key"),
    ).rejects.toThrow("Admin v2 handler declared a request contract the manifest does not own");
  });

  it("refuses to serve a cached parse to a second, differently declared contract", async () => {
    const request = writeRequest(
      "/api/v2/admin/cases/case-1/decisions",
      caseDecision,
      { "idempotency-key": "key-1" },
    );

    await jsonBody(request, "caseDecisionRequestSchema+idempotency-key");
    await expect(
      jsonBody(request, "caseWaitRequestSchema+idempotency-key"),
    ).rejects.toThrow("Admin v2 handler declared a request contract the manifest does not own");
  });

  it("still enforces the declared mutation transport before parsing the body", async () => {
    const request = writeRequest("/api/v2/admin/cases/case-1/decisions", caseDecision);

    await expect(jsonBody(request, "caseDecisionRequestSchema+idempotency-key"))
      .rejects.toThrow("Idempotency-Key header is required");
  });
});

function readRequest(pathnameWithQuery: string) {
  return new Request(`https://admin.test${pathnameWithQuery}`);
}

describe("Admin v2 request query authority", () => {
  it("parses a read query with the schema the manifest declares for that operation", () => {
    const query = queryParams(
      readRequest("/api/v2/admin/cases?view=mine&limit=5"),
      "GET /api/v2/admin/cases",
    );

    // Coerced and defaulted by the manifest's contract, not by the handler.
    expect(query).toMatchObject({ view: "mine", limit: 5 });
  });

  it("fails closed when a handler reads a different operation's query", () => {
    // Adjacent, real, same-domain read — the drift a hand-imported schema could not detect,
    // because both sides were the handler's own choice.
    expect(() => queryParams(
      readRequest("/api/v2/admin/today?workMode=support"),
      "GET /api/v2/admin/today/all-work",
    )).toThrow("Admin v2 handler read the query of a different operation");
  });

  it("rejects a query the declared contract does not admit", () => {
    expect(() => queryParams(
      readRequest("/api/v2/admin/cases?view=nonsense"),
      "GET /api/v2/admin/cases",
    )).toThrow();
  });
});
