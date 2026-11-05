import { describe, expect, it } from "vitest";
import { GENERATION_QUEUE_AHEAD_CAP, generationQueueCopy } from "./generation-queue-copy";

const copy = (queueAhead: number | null | undefined, queueEtaSeconds: number | null | undefined = null, mode: "image" | "video" = "image") =>
  generationQueueCopy({ mode, queueAhead, queueEtaSeconds });

describe("generationQueueCopy", () => {
  it("says nothing when the request has no place in the queue", () => {
    expect(copy(null)).toBeNull();
    expect(copy(undefined)).toBeNull();
  });

  it("states the place in plain words, without an ETA when there is too little data", () => {
    expect(copy(0)).toBe("Next in line");
    expect(copy(1)).toBe("1 request ahead of yours");
    expect(copy(4)).toBe("4 requests ahead of yours");
    expect(copy(GENERATION_QUEUE_AHEAD_CAP)).toBe(`More than ${GENERATION_QUEUE_AHEAD_CAP} requests ahead of yours`);
  });

  it("rounds the wait so polling cannot make it look precise", () => {
    expect(copy(0, 70)).toBe("Next in line · ready in about a minute");
    expect(copy(2, 7 * 60 + 20)).toBe("2 requests ahead of yours · ready in about 7 minutes");
    expect(copy(2, 23 * 60)).toBe("2 requests ahead of yours · ready in about 25 minutes");
    expect(copy(9, 60 * 60)).toBe("9 requests ahead of yours · ready in about an hour");
    expect(copy(30, 5 * 3600)).toBe("30 requests ahead of yours · ready in about 5 hours");
  });

  it("warns only a video that newer images can overtake it", () => {
    expect(copy(1, 600, "video")).toContain("New image requests can go first");
    expect(copy(1, 600, "image")).not.toContain("New image requests");
    expect(copy(1, null, "video")).toBe("1 request ahead of yours");
  });
});
