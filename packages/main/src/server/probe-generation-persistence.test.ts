import { describe, expect, it } from "vitest";
import {
  evaluateGenerationPersistenceSnapshot,
  type GenerationPersistenceSnapshot,
} from "./probe-generation-persistence";

function successfulSnapshot(): GenerationPersistenceSnapshot {
  const checksum = "a".repeat(64);
  const ref = "gen/terminal-records/attempt_1/terminal.json";
  return {
    checkedAt: "2026-08-12T12:01:00.000Z",
    job: {
      id: "job_1",
      mode: "image",
      status: "completed",
      completedAt: new Date("2026-08-12T12:00:00.000Z"),
      deliveredOutputCount: 1,
    },
    attempt: {
      id: "attempt_1",
      attemptNo: 1,
      status: "succeeded",
      provider: "backend",
      profileKey: "image-premium",
      profileVersion: 1,
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      workflowVersion: 1,
      terminalRecordRef: ref,
      finishedAt: new Date("2026-08-12T12:00:00.000Z"),
    },
    terminalEvent: {
      outcome: "succeeded",
      occurredAt: new Date("2026-08-12T12:00:00.000Z"),
      payload: { terminalRecordChecksum: checksum },
    },
    ingestEvent: {
      payload: { terminalRecordRef: ref, terminalRecordChecksum: checksum },
    },
    receipt: {
      id: "receipt_1",
      processingState: "processed",
      payloadHash:
        "5e0e4047febf77c3a576498294c3bc36c4e6a18e577b81a6b4d2197c6f0fd4e1",
    },
    outbox: {
      eventType: "generation.terminal_record.accepted.v1",
      aggregateType: "generation_attempt",
      aggregateId: "attempt_1",
      status: "delivered",
    },
    transports: [
      {
        transportAttemptNo: 1,
        status: "succeeded",
        terminalRecordRef: ref,
      },
    ],
    artifacts: [
      {
        id: "artifact_1",
        terminalRecordChecksum: checksum,
        validationState: "valid",
        archiveState: "active",
        assetId: "asset_1",
      },
    ],
    deliveries: [{ artifactId: "artifact_1", status: "delivered" }],
    mediaAssets: [{ id: "asset_1", type: "image", deletedAt: null }],
  };
}

describe("generation persistence probe", () => {
  it("accepts one exact Main terminal projection", async () => {
    const snapshot = successfulSnapshot();
    const { canonicalSha256 } = await import(
      "./modules/admin-v2/shared/canonical-json"
    );
    snapshot.receipt!.payloadHash = canonicalSha256({
      terminalRecordRef: snapshot.attempt!.terminalRecordRef,
      terminalRecordChecksum: "a".repeat(64),
    });

    expect(evaluateGenerationPersistenceSnapshot(snapshot)).toMatchObject({
      ok: true,
      mode: "image",
      generationJobId: "job_1",
      observedAt: "2026-08-12T12:00:00.000Z",
      terminal: {
        receiptState: "processed",
        outboxState: "delivered",
        artifactCount: 1,
        deliveredCount: 1,
        mediaAssetCount: 1,
      },
      error: null,
    });
  });

  it("fails when Main has not delivered and projected the terminal record", async () => {
    const snapshot = successfulSnapshot();
    const { canonicalSha256 } = await import(
      "./modules/admin-v2/shared/canonical-json"
    );
    snapshot.receipt!.payloadHash = canonicalSha256({
      terminalRecordRef: snapshot.attempt!.terminalRecordRef,
      terminalRecordChecksum: "a".repeat(64),
    });
    snapshot.outbox!.status = "pending";
    snapshot.deliveries = [];
    snapshot.mediaAssets = [];

    const report = evaluateGenerationPersistenceSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.error?.message).toContain("not delivered");
    expect(report.error?.message).toContain("artifact deliveries are incomplete");
    expect(report.error?.message).toContain(
      "MediaAsset projection does not match delivered artifacts",
    );
  });

  it("fails when the projected MediaAsset is not the artifact asset", async () => {
    const snapshot = successfulSnapshot();
    const { canonicalSha256 } = await import(
      "./modules/admin-v2/shared/canonical-json"
    );
    snapshot.receipt!.payloadHash = canonicalSha256({
      terminalRecordRef: snapshot.attempt!.terminalRecordRef,
      terminalRecordChecksum: "a".repeat(64),
    });
    snapshot.mediaAssets[0]!.id = "unrelated_asset";

    const report = evaluateGenerationPersistenceSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.error?.message).toContain(
      "MediaAsset projection does not match delivered artifacts",
    );
  });

  it("fails when a delivered row belongs to a different artifact", async () => {
    const snapshot = successfulSnapshot();
    const { canonicalSha256 } = await import(
      "./modules/admin-v2/shared/canonical-json"
    );
    snapshot.receipt!.payloadHash = canonicalSha256({
      terminalRecordRef: snapshot.attempt!.terminalRecordRef,
      terminalRecordChecksum: "a".repeat(64),
    });
    snapshot.deliveries[0]!.artifactId = "unrelated_artifact";

    const report = evaluateGenerationPersistenceSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.error?.message).toContain(
      "artifact deliveries are incomplete",
    );
  });
});
