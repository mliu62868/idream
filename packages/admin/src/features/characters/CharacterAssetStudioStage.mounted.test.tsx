// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreativeRunDetail } from "@idream/shared/admin";
import { CandidateBatchGrid } from "./CharacterAssetStudioStage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pending = (executionState: string) => [{
  id: "item-1", ordinal: 0, status: "pending", version: 1, executionState,
  asset: null, review: null, lineage: null, failure: null,
}] as unknown as CreativeRunDetail["items"];

describe("Character Asset Studio generation clock", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:01:05Z"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(executionState: string) {
    act(() => root.render(
      <CandidateBatchGrid
        activeItemId="item-1" activePurpose="character_cover" comparisonItemId={null} disabled={false}
        items={pending(executionState)} onActivate={() => undefined} onCompare={() => undefined}
        runCreatedAt="2026-10-07T10:00:00Z" runId="run-1" selectedPackAssetId={null} subjectName="Mira"
      />,
    ));
    act(() => { vi.advanceTimersByTime(0); });
  }

  it("shows how long an in-flight image has been running and keeps counting", () => {
    render("generating");
    expect(container.textContent).toContain("Elapsed 1m 5s");
    expect(container.textContent).toContain("you can leave this page");
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(container.textContent).toContain("Elapsed 1m 15s");
  });

  it("does not run a clock for a failed image", () => {
    render("failed");
    expect(container.textContent).not.toContain("Elapsed");
  });
});
