import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { POST } from "./route";

// SPEC: the internal worker endpoint is the Vercel-Cron entrypoint that claims a
// batch of queued jobs. Exercises the shared http `handle()` wrapper (auth error
// → fail(); success → ok()) and DbJobQueue.claim through the real route handler.

function workerRequest(token?: string) {
  return new Request("http://localhost/api/internal/worker", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("internal worker route", () => {
  it("rejects requests without a valid internal token (401)", async () => {
    const response = await POST(workerRequest("nope"));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("unauthorized");
  });

  it("claims a queued job batch with a valid token", async () => {
    const response = await POST(workerRequest(env.INTERNAL_TOKEN));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { workerId: string; claimed: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(typeof body.data.workerId).toBe("string");
    expect(Array.isArray(body.data.claimed)).toBe(true);
  });
});
