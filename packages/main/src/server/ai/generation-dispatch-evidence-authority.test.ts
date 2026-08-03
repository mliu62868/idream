import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  generationDispatchRequestId,
  generationProviderIdempotencyKey,
  idempotencyKeys,
} from "@idream/shared/contracts";
import { describe, expect, it } from "vitest";
import {
  checkExactGenerationDispatchAuthority,
  generationTerminalRecordEvidence,
  type GenerationDispatchAuthorityCode,
} from "./generation-dispatch-evidence-authority";

const jobId = "dispatch-authority-job";
const attemptId = "dispatch-authority-attempt";

const job = { id: jobId, mode: "image" };

const attempt = {
  id: attemptId,
  requestId: jobId,
  attemptNo: 2,
  provider: "pipeline-image",
  profileKey: "portrait",
  profileVersion: 3,
  workflowKey: "flux-pro",
  workflowVersion: 1,
};

const queuePayload = {
  version: 1,
  kind: "image",
  requestId: generationDispatchRequestId(attemptId),
  generationJobId: jobId,
  attemptId,
  attemptNo: attempt.attemptNo,
  provider: attempt.provider,
  userId: "dispatch-authority-user",
  characterId: null,
  prompt: "authority fixture",
  negativePrompt: null,
  controls: {
    workflowKey: attempt.workflowKey,
    workflowVersion: attempt.workflowVersion,
    generationProfileKey: attempt.profileKey,
    generationProfileVersion: attempt.profileVersion,
  },
  presetIds: [],
  orientation: "portrait",
  count: 1,
  seed: jobId,
  model: "flux-pro",
  outputPrefix: `gen/${jobId}/attempts/${attemptId}/`,
};

const dispatch = {
  aggregateType: "generation_request",
  aggregateId: jobId,
  payload: {
    generationJobId: jobId,
    attemptId,
    attemptNo: attempt.attemptNo,
    queueInput: {
      queue: "ai.image.generate",
      dedupeKey: idempotencyKeys.generationAttempt(jobId, attempt.attemptNo),
      maxAttempts: 3,
      payload: queuePayload,
    },
  },
};

const terminalRecord = {
  version: 1 as const,
  outcome: "succeeded" as const,
  attemptId,
  attemptNo: attempt.attemptNo,
  transportAttemptNo: 1,
  providerIdempotencyKey: generationProviderIdempotencyKey(attemptId),
  requestId: generationDispatchRequestId(attemptId),
  generationJobId: jobId,
  mode: "image" as const,
  provider: attempt.provider,
  providerInvoked: true,
  model: queuePayload.model,
  providerRequestId: `${attemptId}-provider-request`,
  completedAt: "2026-08-02T12:00:00.000Z",
  usage: {},
  assets: [{
    ordinal: 0,
    key: `${queuePayload.outputPrefix}image-0.webp`,
    contentType: "image/webp",
    providerKey: `${attemptId}-provider-asset`,
  }],
};

type Json = Record<string, unknown>;

function withQueueInput(patch: Json) {
  const payload = dispatch.payload;
  return {
    ...dispatch,
    payload: {
      ...payload,
      queueInput: { ...payload.queueInput, ...patch },
    },
  };
}

function withQueuePayload(patch: Json) {
  return withQueueInput({ payload: { ...queuePayload, ...patch } });
}

describe("exact generation dispatch authority", () => {
  it("accepts the envelope a real dispatch writer produces", () => {
    expect(checkExactGenerationDispatchAuthority({ job, attempt, dispatch }))
      .toEqual({
        ok: true,
        authority: {
          mode: "image",
          queue: "ai.image.generate",
          dedupeKey: idempotencyKeys.generationAttempt(jobId, attempt.attemptNo),
          maxAttempts: 3,
          queueInput: dispatch.payload.queueInput,
          queuePayload: expect.objectContaining({ attemptId }),
        },
      });
  });

  it("binds an exact terminal record to that same envelope", () => {
    expect(checkExactGenerationDispatchAuthority({
      job,
      attempt,
      dispatch,
      evidence: generationTerminalRecordEvidence(terminalRecord),
    }).ok).toBe(true);
  });

  // SPEC: one code table, not three. Every gate that asks "does this belong to
  // that immutable Attempt" gets the same verdict for the same defect.
  it.each<{
    readonly label: string;
    readonly code: GenerationDispatchAuthorityCode;
    readonly input: Parameters<typeof checkExactGenerationDispatchAuthority>[0];
  }>([
    {
      label: "unsupported request mode",
      code: "generation_dispatch_mode_unsupported",
      input: { job: { id: jobId, mode: "voice" }, attempt, dispatch },
    },
    {
      label: "queue payload that the queue-input writer could not emit",
      code: "generation_dispatch_envelope_payload_invalid",
      input: {
        job,
        attempt,
        dispatch: withQueueInput({
          payload: {
            version: 1,
            kind: "image",
            requestId: generationDispatchRequestId(attemptId),
            generationJobId: jobId,
            attemptId,
            attemptNo: attempt.attemptNo,
            provider: attempt.provider,
            model: queuePayload.model,
          },
        }),
      },
    },
    {
      label: "dispatch Outbox owned by another aggregate",
      code: "generation_dispatch_identity_mismatch",
      input: {
        job,
        attempt,
        dispatch: { ...dispatch, aggregateId: "other-request" },
      },
    },
    {
      label: "queue payload bound to another Attempt",
      code: "generation_dispatch_identity_mismatch",
      input: {
        job,
        attempt,
        dispatch: withQueuePayload({ attemptNo: 9 }),
      },
    },
    {
      label: "evidence carrying a foreign transport request id",
      code: "generation_dispatch_identity_mismatch",
      input: {
        job,
        attempt,
        dispatch,
        evidence: generationTerminalRecordEvidence({
          ...terminalRecord,
          requestId: "generation_dispatch_tampered",
        }),
      },
    },
    {
      label: "request-level dispatch dedupe key",
      code: "generation_dispatch_transport_identity_mismatch",
      input: {
        job,
        attempt,
        dispatch: withQueueInput({ dedupeKey: `generation:${jobId}` }),
      },
    },
    {
      label: "envelope without a transport attempt budget",
      code: "generation_dispatch_transport_identity_mismatch",
      input: { job, attempt, dispatch: withQueueInput({ maxAttempts: undefined }) },
    },
    {
      label: "evidence beyond the transport attempt budget",
      code: "generation_dispatch_transport_identity_mismatch",
      input: {
        job,
        attempt,
        dispatch,
        evidence: generationTerminalRecordEvidence({
          ...terminalRecord,
          transportAttemptNo: 4,
        }),
      },
    },
    {
      label: "provider drifted from the pinned Attempt",
      code: "generation_dispatch_provider_mismatch",
      input: {
        job,
        attempt,
        dispatch: withQueuePayload({ provider: "other-provider" }),
      },
    },
    {
      label: "evidence model that the envelope never dispatched",
      code: "generation_dispatch_model_mismatch",
      input: {
        job,
        attempt,
        dispatch,
        evidence: generationTerminalRecordEvidence({
          ...terminalRecord,
          model: "tampered-model",
        }),
      },
    },
    {
      label: "evidence with a foreign provider invocation identity",
      code: "generation_dispatch_provider_invocation_identity_mismatch",
      input: {
        job,
        attempt,
        dispatch,
        evidence: generationTerminalRecordEvidence({
          ...terminalRecord,
          providerIdempotencyKey: "generation:tampered:provider",
        }),
      },
    },
    {
      label: "workflow pin the envelope does not carry",
      code: "generation_dispatch_workflow_pin_mismatch",
      input: {
        job,
        attempt,
        dispatch: withQueuePayload({
          controls: { ...queuePayload.controls, workflowVersion: 7 },
        }),
      },
    },
  ])("fails closed on $label", ({ code, input }) => {
    expect(checkExactGenerationDispatchAuthority(input)).toEqual({
      ok: false,
      code,
    });
  });

  // SPEC: runtime ingest, stale recovery, and the offline cutover gate must not
  // drift apart again — the envelope judgement lives in exactly one module and
  // every gate routes through it instead of re-deriving pins and budgets.
  it("is the only implementation of the immutable envelope judgement", () => {
    const owner = "src/server/ai/generation-dispatch-evidence-authority.ts";
    const rederived = productionTypeScriptFiles("src/server/ai")
      .map((file) => path.relative(process.cwd(), file))
      .filter((file) => file !== owner)
      .filter((file) =>
        /generationProfileKey|queueInput\.maxAttempts|workflowKeyMatches/
          .test(readFileSync(file, "utf8"))
      );

    expect(rederived).toEqual([]);
    for (
      const gate of [
        "src/server/ai/generation-dispatch-cutover.ts",
        "src/server/ai/local-pipeline.ts",
        "src/server/ai/generation-terminal-record-ingest.ts",
        "src/server/ai/generation-transport-execution.ts",
      ]
    ) {
      expect(readFileSync(gate, "utf8")).toContain(
        './generation-dispatch-evidence-authority"',
      );
    }
  });
});

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(file);
    return entry.isFile() && file.endsWith(".ts") && !file.endsWith(".test.ts")
      ? [file]
      : [];
  });
}
