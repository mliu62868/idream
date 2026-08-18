import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit, rateLimitIdentity, RATE_LIMITS } from "./rate-limit";

// SPEC: 限流是 P0「未认证可触发破坏性操作」的纵深防御那一层。它默认在 test 关闭
// （所有测试共享同一个无 IP 身份，开着会让不相关用例互相打架），所以这里显式开。
const previous = process.env.RATE_LIMIT_FORCE;
process.env.RATE_LIMIT_FORCE = "1";

afterAll(() => {
  if (previous === undefined) delete process.env.RATE_LIMIT_FORCE;
  else process.env.RATE_LIMIT_FORCE = previous;
});

function freshIdentity(label: string) {
  return `ip:zt-rl-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe("rate limit identity", () => {
  it("prefers the authenticated user over any client-supplied header", () => {
    const request = new Request("http://localhost/api/v1/reports", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(rateLimitIdentity(request, "user-1")).toBe("user:user-1");
  });

  it("falls back through proxy headers, then to a shared bucket", () => {
    const forwarded = new Request("http://localhost/api/v1/reports", {
      headers: { "x-forwarded-for": "203.0.113.9, 70.41.3.18" },
    });
    expect(rateLimitIdentity(forwarded, undefined)).toBe("ip:203.0.113.9");

    const real = new Request("http://localhost/api/v1/reports", {
      headers: { "x-real-ip": "203.0.113.10" },
    });
    expect(rateLimitIdentity(real, undefined)).toBe("ip:203.0.113.10");

    // No trustworthy client address: degrade into one shared bucket rather than
    // handing every anonymous caller its own unlimited quota.
    const bare = new Request("http://localhost/api/v1/reports");
    expect(rateLimitIdentity(bare, undefined)).toBe("ip:unknown");
  });
});

describe("rate limit accounting", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_FORCE = "1";
  });

  it("allows exactly the policy limit and then refuses", async () => {
    const identity = freshIdentity("login");
    const { limit } = RATE_LIMITS.authLogin;

    for (let attempt = 1; attempt <= limit; attempt++) {
      const decision = await consumeRateLimit("authLogin", identity);
      expect(decision.allowed).toBe(true);
      expect(decision.count).toBe(attempt);
    }

    const refused = await consumeRateLimit("authLogin", identity);
    expect(refused.allowed).toBe(false);
    expect(refused.count).toBe(limit + 1);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("keeps separate identities and separate scopes independent", async () => {
    const attacker = freshIdentity("attacker");
    const bystander = freshIdentity("bystander");
    const { limit } = RATE_LIMITS.redeemCode;

    for (let attempt = 0; attempt < limit + 1; attempt++) {
      await consumeRateLimit("redeemCode", attacker);
    }
    expect((await consumeRateLimit("redeemCode", attacker)).allowed).toBe(false);

    // A different caller is untouched...
    expect((await consumeRateLimit("redeemCode", bystander)).allowed).toBe(true);
    // ...and so is a different endpoint for the same caller.
    expect((await consumeRateLimit("authLogin", attacker)).allowed).toBe(true);
  });

  it("is inert when disabled so ordinary tests are not throttled", async () => {
    process.env.RATE_LIMIT_FORCE = "0";
    process.env.RATE_LIMIT_DISABLED = "1";
    const identity = freshIdentity("disabled");
    try {
      for (let attempt = 0; attempt < RATE_LIMITS.authLogin.limit + 5; attempt++) {
        expect((await consumeRateLimit("authLogin", identity)).allowed).toBe(true);
      }
    } finally {
      delete process.env.RATE_LIMIT_DISABLED;
      process.env.RATE_LIMIT_FORCE = "1";
    }
  });
});
