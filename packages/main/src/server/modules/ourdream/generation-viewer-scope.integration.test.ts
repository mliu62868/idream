import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createMedia, createUser, dreamcoinBalance, expectError, expectOk, grantCoins, purgeTestData } from "@/server/test/helpers";
import { quoteAuthorityFor } from "./generation-quote";

const prefix = "zt-generation-viewer-";
const owner = `${prefix}owner`;
const other = `${prefix}other`;
const userIds = [owner, other];

beforeAll(async () => {
  await purgeTestData(prefix);
  for (const id of userIds) {
    await createUser({ id });
    await grantCoins(id, 200);
    await prisma.entitlement.create({ data: { userId: id, key: "premium_controls", value: true, source: "test" } });
  }
});
afterAll(async () => { await purgeTestData(prefix); });

async function writeFacts() {
  const jobs = await prisma.generationJob.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  return {
    jobs: jobs.length,
    attempts: await prisma.generationAttempt.count({ where: { requestId: { in: jobs.map(job => job.id) } } }),
    charges: await prisma.dreamcoinLedger.count({ where: { userId: { in: userIds }, reason: "generation_spend" } }),
    ownerBalance: await dreamcoinBalance(owner),
    otherBalance: await dreamcoinBalance(other),
  };
}

describe("generation writes bind retained UI authority to its expected account", () => {
  it.each([
    "generation/jobs",
    `generation/jobs/${prefix}failed/retry`,
    `media/${prefix}image/variation`,
    `media/${prefix}image/enhance`,
  ])("rejects an old viewer at %s before body, replay or creation", async path => {
    const before = await writeFacts();
    const response = await api("POST", path, {
      userId: other, ageGate: true, autoGenerationQuote: false,
      headers: { "x-idream-viewer-scope": `user:${owner}`, "Idempotency-Key": `${prefix}blocked` }, body: {},
    });
    expectError(response, 409);
    expect(response.error?.message).toContain("Your account changed");
    expect(await writeFacts()).toEqual(before);
  });

  it("cannot turn an old account's accepted freeplay receipt into a charge for the newly signed-in account", async () => {
    const original = { mode: "image", freeplay: true, prompt: "A quiet reading nook at dusk", outputCount: 1, controls: {} };
    const quoted = await api("POST", "generation/quote", { userId: owner, ageGate: true, body: original });
    expectOk(quoted);
    const authority = quoteAuthorityFor(quoted.data.quote, 1);
    expect(authority).not.toBeNull();
    const body = { ...original, quoteAuthority: authority! };
    const key = `${prefix}accepted-request`;
    const headers = { "Idempotency-Key": key, "x-idream-viewer-scope": `user:${owner}` };
    const accepted = await api("POST", "generation/jobs", { userId: owner, ageGate: true, headers, body, autoGenerationQuote: false });
    expectOk(accepted, 202);
    const beforeCheck = await writeFacts();

    // Both accounts can afford the same public route. Only the expected-owner
    // boundary prevents a lost A response from becoming a new B reservation.
    const otherQuote = await api("POST", "generation/quote", { userId: other, ageGate: true, body: original });
    expectOk(otherQuote);
    expect(quoteAuthorityFor(otherQuote.data.quote, 1)).toEqual(authority);
    const switched = await api("POST", "generation/jobs", { userId: other, ageGate: true, headers, body, autoGenerationQuote: false });
    expectError(switched, 409);
    expect(switched.error?.message).toContain("Your account changed");
    expect(await writeFacts()).toEqual(beforeCheck);
    expect(await prisma.generationJob.count({ where: { userId: other } })).toBe(0);

    const checked = await api("POST", "generation/jobs", { userId: owner, ageGate: true, headers, body, autoGenerationQuote: false });
    expectOk(checked, 202);
    expect(checked.data.job.id).toBe(accepted.data.job.id);
    expect(await writeFacts()).toEqual(beforeCheck);

    // A normal API caller with no retained viewer expectation still acts as
    // its current authenticated account; the header grants no extra authority.
    const current = await api("POST", "generation/jobs", { userId: other, ageGate: true, headers: { "Idempotency-Key": key }, body, autoGenerationQuote: false });
    expectOk(current, 202);
    expect(current.data.job.id).not.toBe(accepted.data.job.id);
    const afterCurrent = await writeFacts();
    expect(afterCurrent.jobs).toBe(beforeCheck.jobs + 1);
    expect(afterCurrent.attempts).toBe(beforeCheck.attempts + 1);
    expect(afterCurrent.charges).toBe(beforeCheck.charges + 1);
    expect(afterCurrent.otherBalance).toBe(beforeCheck.otherBalance - authority!.costDreamcoins);
    const currentReplay = await api("POST", "generation/jobs", { userId: other, ageGate: true, headers: { ...headers, "x-idream-viewer-scope": `user:${other}` }, body, autoGenerationQuote: false });
    expectOk(currentReplay, 202);
    expect(currentReplay.data.job.id).toBe(current.data.job.id);
    expect(await writeFacts()).toEqual(afterCurrent);
  });

  it.each(["jobs", "presets", "media"] as const)("binds private %s reads to the viewer confirmed before cookies changed", async kind => {
    const a = `${prefix}${kind}-a`;
    const b = `${prefix}${kind}-b`;
    for (const id of [a, b]) {
      await createUser({ id });
      if (kind === "jobs") await prisma.generationJob.create({ data: {
        id: `${id}-private`, userId: id, mode: "image", status: "completed", prompt: `${id} private result`, controls: {}, presetIds: [],
      } });
      else if (kind === "presets") await prisma.generationPreset.create({ data: {
        id: `${id}-private`, ownerId: id, scope: "user", visibility: "private", type: "background", label: `${id} private preset`, controls: {},
      } });
      else await createMedia({ id: `${id}-private`, ownerId: id, visibility: "private" });
    }
    const path = kind === "media" ? "media" : `generation/${kind}`;
    const query = kind === "presets" ? { scope: "user" } : undefined;
    const wrong = await api("GET", path, { userId: b, ageGate: true, query, headers: { "x-idream-viewer-scope": `user:${a}` } });
    expectError(wrong, 409);
    expect(wrong.error?.message).toContain("Your account changed");
    expect(JSON.stringify(wrong.json)).not.toContain(`${b}-private`);
    for (const headers of [{ "x-idream-viewer-scope": `user:${b}` }, undefined]) {
      const current = await api("GET", path, { userId: b, ageGate: true, query, headers });
      expectOk(current);
      expect(current.data.items.map((item: { id: string }) => item.id)).toContain(`${b}-private`);
      expect(current.data.items.map((item: { id: string }) => item.id)).not.toContain(`${a}-private`);
    }
  });

  it("retains anonymous public preset reads but never treats an expected user as authentication", async () => {
    expectOk(await api("GET", "generation/presets", { ageGate: true }));
    expectError(await api("GET", "generation/presets", { ageGate: true, headers: { "x-idream-viewer-scope": `user:${owner}` } }), 401);
  });

  it("does not authenticate a request with a viewer header", async () => {
    const before = await writeFacts();
    const response = await api("POST", "generation/jobs", { ageGate: true, autoGenerationQuote: false, headers: { "x-idream-viewer-scope": `user:${owner}` }, body: {} });
    expectError(response, 401);
    expect(await writeFacts()).toEqual(before);
  });
});
