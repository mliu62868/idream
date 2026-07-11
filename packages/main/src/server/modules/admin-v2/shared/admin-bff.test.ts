import { describe, expect, it } from "vitest";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { verifyAdminBffRequest } from "./admin-bff";

const secret = "admin-bff-test-secret-at-least-32-characters";
const now = 1_800_000_000_000;

function signedRequest(options: {
  readonly url?: string;
  readonly body?: string;
  readonly authTime?: number;
  readonly signedUrl?: string;
}) {
  const url = options.url ?? "https://main.example/api/v2/admin/today?limit=20";
  const signedUrl = new URL(options.signedUrl ?? url);
  const body = options.body ?? "";
  const { signature, context } = signBffContext({
    secret,
    userId: "admin-bff",
    method: body ? "POST" : "GET",
    path: `${signedUrl.pathname}${signedUrl.search}`,
    body: body ? Buffer.from(body).toString("base64") : "",
    authTime: options.authTime ?? now,
  });
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers: {
      [BFF_HEADER]: signature,
      [BFF_USER_HEADER]: JSON.stringify(context),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body || undefined,
  });
}

describe("Admin BFF service HMAC", () => {
  it("binds method, path, query, body, and the expected service identity", async () => {
    await expect(verifyAdminBffRequest(signedRequest({ body: '{"status":"active"}' }), {
      secret,
      appEnv: "production",
      now,
    })).resolves.toEqual({ ok: true });

    await expect(verifyAdminBffRequest(signedRequest({
      url: "https://main.example/api/v2/admin/today?limit=100",
      signedUrl: "https://main.example/api/v2/admin/today?limit=20",
    }), { secret, appEnv: "production", now })).resolves.toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects missing signatures, body tampering, replay outside the TTL, and future clock skew", async () => {
    await expect(verifyAdminBffRequest(
      new Request("https://main.example/api/v2/admin/today"),
      { secret, appEnv: "production", now },
    )).resolves.toEqual({ ok: false, reason: "missing_bff" });

    const tampered = signedRequest({ body: '{"status":"active"}' });
    const tamperedRequest = new Request(tampered.url, {
      method: "POST",
      headers: tampered.headers,
      body: '{"status":"suspended"}',
    });
    await expect(verifyAdminBffRequest(tamperedRequest, {
      secret,
      appEnv: "production",
      now,
    })).resolves.toEqual({ ok: false, reason: "bad_signature" });

    await expect(verifyAdminBffRequest(signedRequest({ authTime: now - 30_001 }), {
      secret,
      appEnv: "production",
      now,
      ttlMs: 30_000,
    })).resolves.toEqual({ ok: false, reason: "expired" });

    await expect(verifyAdminBffRequest(signedRequest({ authTime: now + 30_001 }), {
      secret,
      appEnv: "production",
      now,
      ttlMs: 30_000,
    })).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("allows unsigned direct requests only outside production when no secret is configured", async () => {
    const request = new Request("http://main.local/api/v2/admin/today");
    await expect(verifyAdminBffRequest(request, { appEnv: "test", secret: "" }))
      .resolves.toEqual({ ok: true });
    await expect(verifyAdminBffRequest(request, { appEnv: "production", secret: "" }))
      .resolves.toEqual({ ok: false, reason: "missing_secret" });
  });
});
