import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { approvalMatchesIntent, assertBoundApprovalIntent, bindApprovalIntent } from "./intent";

const tx = { featureFlag: { findUnique: async () => ({ version: 7 }) } } as unknown as Prisma.TransactionClient;
const base = { action: "billing.ledger.adjust", permissionKey: "billing.ledger.adjust", targetType: "user", targetId: "user-1", payload: { delta: 1000 } };

describe("approval intent binding", () => {
  it("leaves actions outside this approval policy to their existing durable contract", async () => {
    const input = { ...base, action: "constructor", payload: { commandType: "character.release.publish" } };
    expect(await bindApprovalIntent(tx, input)).toEqual(input.payload);
    expect(assertBoundApprovalIntent(input)).toBeNull();
  });
  it("rejects a weaker permission or unrelated target type", async () => {
    await expect(bindApprovalIntent(tx, { ...base, permissionKey: "dashboard.read" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(bindApprovalIntent(tx, { ...base, targetType: "pricing_rule" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("binds the exact payload, target, version and expiration", async () => {
    const input = { ...base, payload: await bindApprovalIntent(tx, base) };
    expect(approvalMatchesIntent(input, { delta: 1000 }, null)).toBe(true);
    expect(approvalMatchesIntent(input, { delta: 1001 }, null)).toBe(false);
    expect(approvalMatchesIntent(input, { delta: 1000 }, 1)).toBe(false);
    expect(approvalMatchesIntent({ ...input, targetId: "other" }, { delta: 1000 }, null)).toBe(false);
    expect(() => assertBoundApprovalIntent(input, new Date(Date.now() + 25 * 60 * 60_000))).toThrow("request a new approval");
  });

  it("explicitly rejects approvals from before binding existed", () => {
    expect(() => assertBoundApprovalIntent(base)).toThrow("request a new approval");
    expect(approvalMatchesIntent(base, { delta: 1000 }, null)).toBe(false);
  });

  it("pins the current feature flag version and the disable intent", async () => {
    const flag = { action: "config.feature_flag.write", permissionKey: "config.feature_flag.write", targetType: "feature_flag", targetId: "dual_approval_enforced", payload: {} };
    const input = { ...flag, payload: await bindApprovalIntent(tx, flag) };
    expect(approvalMatchesIntent(input, { enabled: false }, 7)).toBe(true);
    expect(approvalMatchesIntent(input, { enabled: false }, 8)).toBe(false);
    expect(approvalMatchesIntent(input, { enabled: true }, 7)).toBe(false);
  });

  it("binds pricing and coin-offer publication snapshots", async () => {
    const pricing = { action: "config.pricing.publish", permissionKey: "config.pricing.write", targetType: "pricing_rule", targetId: "price-1", payload: { baseCost: 4, multiplier: 1, version: 2 } };
    const bound = { ...pricing, payload: await bindApprovalIntent(tx, pricing) };
    expect(approvalMatchesIntent(bound, pricing.payload, 2)).toBe(true);
    expect(approvalMatchesIntent(bound, { ...pricing.payload, baseCost: 40 }, 2)).toBe(false);
    const offer = { action: "config.coin_offer.publish", permissionKey: "config.pricing.write", targetType: "coin_offer", targetId: "offer-1", payload: { version: 2, fingerprint: "a".repeat(64) } };
    const offerBinding = { ...offer, payload: await bindApprovalIntent(tx, offer) };
    expect(approvalMatchesIntent(offerBinding, offer.payload, 2)).toBe(true);
    expect(approvalMatchesIntent(offerBinding, { ...offer.payload, fingerprint: "b".repeat(64) }, 2)).toBe(false);
  });
});
