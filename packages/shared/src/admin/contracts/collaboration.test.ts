import { describe, expect, it } from "vitest";
import {
  collaborationActivityListResponseSchema,
  collaborationActivityMutationSchema,
  collaborationActivityCreateSchema,
  collaborationWatchResponseSchema,
  experimentDefinitionCreateSchema,
  savedViewMutationResponseSchema,
  savedViewQueryStateSchema,
} from "./index";

describe("admin collaboration and experiment contracts", () => {
  it("rejects unbounded or client-only saved view query state", () => {
    expect(savedViewQueryStateSchema.safeParse({ search: "", filters: {}, sort: { field: "updatedAt", direction: "desc" }, pageSize: 201 }).success).toBe(false);
    expect(savedViewQueryStateSchema.safeParse({ search: "", filters: {}, sort: { field: "updatedAt", direction: "desc" }, pageSize: 50, cursor: "client-row" }).success).toBe(false);
  });

  it("requires balanced immutable experiment variants and a real guardrail", () => {
    const base = {
      key: "onboarding.copy",
      hypothesis: "A shorter opening increases qualified engagement",
      eligibility: {},
      variants: [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
      salt: "0123456789abcdef",
      metrics: { primary: "relationship.qce_activation.v1", controlVariant: "control", minimumMaturePerArm: 100, guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }] },
    };
    expect(experimentDefinitionCreateSchema.safeParse(base).success).toBe(true);
    expect(experimentDefinitionCreateSchema.safeParse({ ...base, variants: [{ key: "control", allocationBps: 9_000 }, { key: "treatment", allocationBps: 500 }] }).success).toBe(false);
    expect(experimentDefinitionCreateSchema.safeParse({ ...base, metrics: { ...base.metrics, guardrails: [] } }).success).toBe(false);
  });

  it("owns collaboration and Saved View authority response contracts", () => {
    const now = new Date().toISOString();
    const activity = { id: "activity-1", targetType: "incident", targetId: "incident-1", kind: "comment", actorId: "admin-1", body: "Investigating", mentionedIds: [], metadata: {}, parentId: null, createdAt: now };
    expect(collaborationActivityListResponseSchema.parse({ items: [activity], watching: true, watcherIds: ["actor-1"], pageInfo: { hasNextPage: false, endCursor: null }, asOf: now }).items).toHaveLength(1);
    expect(collaborationActivityMutationSchema.parse({ activity, authority: { ownerId: "actor-2", version: 2 }, duplicate: false }).authority).toEqual({ ownerId: "actor-2", version: 2 });
    expect(collaborationActivityCreateSchema.safeParse({ kind: "handoff", body: "Transfer", mentionedIds: [], metadata: { handoffToActorId: "actor-2" } }).success).toBe(false);
    expect(collaborationActivityCreateSchema.safeParse({ kind: "handoff", expectedVersion: 1, body: "Transfer", mentionedIds: [], metadata: { handoffToActorId: "actor-2" } }).success).toBe(true);
    expect(collaborationWatchResponseSchema.parse({ watching: true, duplicate: false }).watching).toBe(true);
    expect(savedViewMutationResponseSchema.parse({ view: { id: "view-1", scope: "incident", label: "Mine", queryState: { search: "", filters: {}, sort: { field: "id", direction: "asc" }, pageSize: 30 }, version: 1, createdAt: now, updatedAt: now }, duplicate: false }).view.version).toBe(1);
  });
});
