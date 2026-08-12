import { describe, expect, it, vi } from "vitest";
import {
  CREATE_PREVIEW_CANDIDATE_COUNT,
  CREATE_PREVIEW_TOTAL_WAIT_MS,
  continueCreatePreviewBatch,
  newCreatePreviewBatch,
  parseCreatePreviewBatch,
  retryCreatePreviewBatch,
  type CreatePreviewBatch,
  type CreatePreviewCandidate,
} from "./create-preview-flow";

function candidate(number: number): CreatePreviewCandidate {
  return {
    previewJobId: `job-${number}`,
    assetId: `asset-${number}`,
    url: `/user-content/asset-${number}`,
    isSynthetic: false,
  };
}

function resumedLastCandidate(overrides: Partial<CreatePreviewBatch> = {}): CreatePreviewBatch {
  return {
    ...newCreatePreviewBatch(0, "create-preview-request-last"),
    activePreviewJobId: "job-4",
    activeJobStatus: "queued",
    currentCandidateNumber: 4,
    candidates: [candidate(1), candidate(2), candidate(3)],
    ...overrides,
  };
}

describe("create preview batch", () => {
  it("keeps polling the same durable job when a normal preview completes after 90 seconds", async () => {
    let clock = 0;
    const enqueue = vi.fn();
    const read = vi.fn(async () =>
      clock < 90_000
        ? { id: "job-4", status: "running" as const, asset: null }
        : {
            id: "job-4",
            status: "completed" as const,
            asset: candidate(4),
          },
    );

    const completed = await continueCreatePreviewBatch(resumedLastCandidate(), {
      enqueue,
      read,
      persist: vi.fn(),
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect(completed.phase).toBe("complete");
    expect(completed.candidates).toHaveLength(CREATE_PREVIEW_CANDIDATE_COUNT);
    expect(read.mock.calls.length).toBeGreaterThan(50);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("restores the active job and candidate number from draft storage without resubmitting it", async () => {
    const restored = parseCreatePreviewBatch(
      JSON.parse(JSON.stringify(resumedLastCandidate())),
    );
    const enqueue = vi.fn();

    expect(restored).not.toBeNull();
    const completed = await continueCreatePreviewBatch(restored!, {
      enqueue,
      read: async () => ({
        id: "job-4",
        status: "completed",
        asset: candidate(4),
      }),
      persist: vi.fn(),
      now: () => 90_000,
      sleep: async () => undefined,
    });

    expect(completed.phase).toBe("complete");
    expect(completed.currentCandidateNumber).toBe(4);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reuses one persisted request key when the server commits before the response is lost", async () => {
    const serverJobs = new Map<string, string>();
    let loseFirstResponse = true;
    const enqueue = vi.fn(async (_candidateNumber: number, requestKey: string) => {
      const previewJobId = serverJobs.get(requestKey) ?? "job-4-recovered";
      serverJobs.set(requestKey, previewJobId);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("response lost after commit");
      }
      return { id: previewJobId, status: "queued" as const };
    });
    const first = await continueCreatePreviewBatch(
      resumedLastCandidate({
        activePreviewJobId: "",
        activeJobStatus: null,
      }),
      {
        enqueue,
        read: vi.fn(),
        persist: vi.fn(),
        now: () => 1,
        sleep: async () => undefined,
      },
    );

    expect(first).toMatchObject({
      phase: "failed",
      failureReason: "request_failed",
      activePreviewJobId: "",
      activeRequestKey: "create-preview-request-last",
    });

    const completed = await continueCreatePreviewBatch(
      retryCreatePreviewBatch(first, 2),
      {
        enqueue,
        read: async (jobId) => ({
          id: jobId,
          status: "completed",
          asset: { ...candidate(4), previewJobId: jobId },
        }),
        persist: vi.fn(),
        now: () => 3,
        sleep: async () => undefined,
      },
    );

    expect(completed.phase).toBe("complete");
    expect(serverJobs.size).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[1]).toBe(enqueue.mock.calls[1]?.[1]);
  });

  it("fails closed on an impossible persisted completion instead of unlocking Publish", () => {
    expect(
      parseCreatePreviewBatch({
        ...newCreatePreviewBatch(0),
        phase: "complete",
        currentCandidateNumber: 4,
        candidates: [],
      }),
    ).toBeNull();
  });

  it("stops the old owner after navigation so a returning workspace is the only poller", async () => {
    let active = true;
    let reads = 0;
    const enqueue = vi.fn();
    const batch: CreatePreviewBatch = {
      ...newCreatePreviewBatch(0),
      activePreviewJobId: "job-1",
      activeJobStatus: "running",
    };

    const paused = await continueCreatePreviewBatch(batch, {
      enqueue,
      read: async () => {
        reads += 1;
        return reads === 1
          ? { id: "job-1", status: "running", asset: null }
          : { id: "job-1", status: "completed", asset: candidate(1) };
      },
      persist: vi.fn(),
      now: () => 1,
      sleep: async () => {
        active = false;
      },
      isActive: () => active,
    });

    expect(paused).toMatchObject({
      phase: "running",
      currentCandidateNumber: 1,
      activePreviewJobId: "job-1",
    });
    expect(reads).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("preserves a non-terminal job at the explicit batch deadline and retries by polling it", async () => {
    let clock = CREATE_PREVIEW_TOTAL_WAIT_MS;
    const enqueue = vi.fn();
    const timedOut = await continueCreatePreviewBatch(resumedLastCandidate(), {
      enqueue,
      read: async () => ({ id: "job-4", status: "queued", asset: null }),
      persist: vi.fn(),
      now: () => clock,
      sleep: async () => undefined,
    });

    expect(timedOut).toMatchObject({
      phase: "failed",
      failureReason: "timed_out",
      activePreviewJobId: "job-4",
    });
    expect(enqueue).not.toHaveBeenCalled();

    const retried = retryCreatePreviewBatch(timedOut, clock);
    clock += 1;
    const completed = await continueCreatePreviewBatch(retried, {
      enqueue,
      read: async () => ({
        id: "job-4",
        status: "completed",
        asset: candidate(4),
      }),
      persist: vi.fn(),
      now: () => clock,
      sleep: async () => undefined,
    });

    expect(completed.phase).toBe("complete");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("aborts a hung status request at the explicit batch deadline", async () => {
    const abortObserved = vi.fn();
    const settled = await continueCreatePreviewBatch(resumedLastCandidate(), {
      enqueue: vi.fn(),
      read: (_jobId, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            abortObserved();
            reject(signal.reason);
          });
        }),
      persist: vi.fn(),
      now: () => 1,
      sleep: async () => undefined,
      scheduleDeadline: (onDeadline) => {
        onDeadline();
        return () => undefined;
      },
    });

    expect(abortObserved).toHaveBeenCalledTimes(1);
    expect(settled).toMatchObject({
      phase: "failed",
      failureReason: "timed_out",
      activePreviewJobId: "job-4",
    });
  });

  it("clears a terminally failed job so an explicit retry can enqueue a replacement", async () => {
    const failed = await continueCreatePreviewBatch(resumedLastCandidate(), {
      enqueue: vi.fn(),
      read: async () => ({
        id: "job-4",
        status: "failed",
        asset: null,
        errorMessage: "Provider rejected the preview.",
      }),
      persist: vi.fn(),
      now: () => 1,
      sleep: async () => undefined,
    });

    expect(failed).toMatchObject({
      phase: "failed",
      failureReason: "generation_failed",
      activePreviewJobId: "",
      errorMessage: "Provider rejected the preview.",
    });

    const enqueue = vi.fn(async () => ({ id: "job-4-retry", status: "queued" as const }));
    const completed = await continueCreatePreviewBatch(retryCreatePreviewBatch(
      failed,
      2,
      "create-preview-request-replacement",
    ), {
      enqueue,
      read: async (jobId) => ({
        id: jobId,
        status: "completed",
        asset: { ...candidate(4), previewJobId: jobId },
      }),
      persist: vi.fn(),
      now: () => 3,
      sleep: async () => undefined,
    });

    expect(completed.phase).toBe("complete");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      4,
      "create-preview-request-replacement",
      expect.any(AbortSignal),
    );
    expect(completed.candidates.at(-1)?.previewJobId).toBe("job-4-retry");
  });

  it("does not trap retry on a terminal completion that has no usable asset", async () => {
    const failed = await continueCreatePreviewBatch(resumedLastCandidate(), {
      enqueue: vi.fn(),
      read: async () => ({
        id: "job-4",
        status: "completed",
        asset: null,
      }),
      persist: vi.fn(),
      now: () => 1,
      sleep: async () => undefined,
    });

    expect(failed).toMatchObject({
      phase: "failed",
      failureReason: "generation_failed",
      activePreviewJobId: "",
    });
  });
});
