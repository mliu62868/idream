import { describe, expect, it, vi } from "vitest";
import {
  initialAuthorityStatus,
  type AuthorityStatus,
} from "@/components/ourdream/authority-state";
import type { ViewerResourceOutcome } from "@/lib/viewer-resource-client";
import {
  runViewerResourceRefresh,
  type ViewerResourceOptions,
} from "./useViewerResource";

type Item = { id: string };

/** Stands in for the component's `useState` pair. */
function stateHarness(initial: Item[]) {
  let data = initial;
  let status = initialAuthorityStatus();
  return {
    get data() {
      return data;
    },
    get status() {
      return status;
    },
    setData: (value: Item[]) => {
      data = value;
    },
    setStatus: (update: (current: AuthorityStatus) => AuthorityStatus) => {
      status = update(status);
    },
  };
}

function baseConfig(
  overrides: Partial<ViewerResourceOptions<Item[], void, unknown>> = {},
): ViewerResourceOptions<Item[], void, unknown> {
  return {
    request: () => ({ path: "/api/v1/generation/jobs?limit=20" }),
    parse: (raw) => raw as Item[],
    fallbackError: "Jobs could not load.",
    initialData: [],
    ...overrides,
  };
}

function loaderFor(
  outcome: ViewerResourceOutcome<Item[]>,
): typeof import("@/lib/viewer-resource-client").loadViewerResource {
  return (async () => outcome) as never;
}

describe("runViewerResourceRefresh", () => {
  it("applies loaded data and settles the authority status", async () => {
    const state = stateHarness([]);
    const items = [{ id: "a" }];

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig(),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "loaded", data: items }),
    });

    expect(state.data).toBe(items);
    expect(state.status).toEqual({ phase: "ready", error: null, hasSnapshot: true });
  });

  it("records a failure without discarding the snapshot the viewer can still see", async () => {
    const state = stateHarness([{ id: "a" }]);
    state.setStatus(() => ({ phase: "ready", error: null, hasSnapshot: true }));

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig(),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "failed", error: "Jobs could not load." }),
    });

    expect(state.data).toEqual([{ id: "a" }]);
    expect(state.status).toEqual({
      phase: "error",
      error: "Jobs could not load.",
      hasSnapshot: true,
    });
  });

  it("leaves state untouched when a discarded outcome comes back", async () => {
    const state = stateHarness([{ id: "a" }]);

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig(),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "discarded" }),
    });

    expect(state.data).toEqual([{ id: "a" }]);
    expect(state.status.phase).toBe("loading");
  });

  it("runs onLoaded only after a successful apply", async () => {
    const onLoaded = vi.fn();
    const state = stateHarness([]);

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig({ onLoaded }),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "failed", error: "nope" }),
    });
    expect(onLoaded).not.toHaveBeenCalled();

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig({ onLoaded }),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "loaded", data: [{ id: "z" }] }),
    });
    expect(onLoaded).toHaveBeenCalledWith([{ id: "z" }], undefined);
  });
});

describe("runViewerResourceRefresh race guard", () => {
  it("rejects a slow earlier response once a later one has claimed the serial", async () => {
    // This is the regression the hook exists to make unrepeatable: before it,
    // refreshJobs/refreshPresets had no serial at all, so a slow first response
    // could land on top of a fresh second one.
    const serialRef = { current: 0 };
    const state = stateHarness([]);
    const seen: boolean[] = [];

    const slowLoad = (async (request: { isCurrent?: () => boolean }) => {
      // A second refresh happens while this one is in flight.
      serialRef.current += 1;
      const current = request.isCurrent?.() ?? true;
      seen.push(current);
      return current
        ? { kind: "loaded", data: [{ id: "stale" }] }
        : { kind: "discarded" };
    }) as never;

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig(),
      serialRef,
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: slowLoad,
    });

    expect(seen).toEqual([false]);
    expect(state.data).toEqual([]);
  });

  it("accepts a response whose serial is still the newest", async () => {
    const serialRef = { current: 0 };
    const state = stateHarness([]);
    let observed: boolean | undefined;

    const load = (async (request: { isCurrent?: () => boolean }) => {
      observed = request.isCurrent?.();
      return { kind: "loaded", data: [{ id: "fresh" }] };
    }) as never;

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig(),
      serialRef,
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load,
    });

    expect(observed).toBe(true);
    expect(state.data).toEqual([{ id: "fresh" }]);
  });

  it("claims a monotonically increasing serial per refresh", async () => {
    const serialRef = { current: 7 };
    const state = stateHarness([]);

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig(),
      serialRef,
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "loaded", data: [] }),
    });

    expect(serialRef.current).toBe(8);
  });
});

describe("runViewerResourceRefresh viewer gate", () => {
  const ticket = { controller: new AbortController() };

  it("does nothing at all when the gate refuses the request", async () => {
    const state = stateHarness([{ id: "a" }]);
    const load = vi.fn();
    const finish = vi.fn();
    const serialRef = { current: 3 };

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig({
        gate: { begin: () => null, isCurrent: () => true, finish },
      }),
      serialRef,
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load: load as never,
    });

    expect(load).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(serialRef.current).toBe(3);
    expect(state.status).toEqual(initialAuthorityStatus());
    expect(state.data).toEqual([{ id: "a" }]);
  });

  it("attaches the gate's abort signal to the request", async () => {
    const state = stateHarness([]);
    let receivedSignal: AbortSignal | undefined;

    const load = (async (request: { init?: RequestInit }) => {
      receivedSignal = request.init?.signal ?? undefined;
      return { kind: "loaded", data: [] };
    }) as never;

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig({
        request: () => ({ path: "/x", init: { cache: "no-store" } }),
        gate: {
          begin: () => ticket,
          isCurrent: () => true,
          finish: () => {},
          signal: (t) => (t as typeof ticket).controller.signal,
        },
      }),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load,
    });

    expect(receivedSignal).toBe(ticket.controller.signal);
  });

  it("releases the ticket even when the request throws", async () => {
    const finish = vi.fn();
    const state = stateHarness([]);

    await expect(
      runViewerResourceRefresh({
        arg: undefined,
        config: baseConfig({
          gate: { begin: () => ticket, isCurrent: () => true, finish },
        }),
        serialRef: { current: 0 },
        snapshotKeyRef: { current: null },
        setData: state.setData,
        setStatus: state.setStatus,
        load: (async () => {
          throw new Error("exploded");
        }) as never,
      }),
    ).rejects.toThrow("exploded");

    expect(finish).toHaveBeenCalledWith(ticket);
  });

  it("treats a viewer-scope change as stale even when the serial still matches", async () => {
    const state = stateHarness([]);
    let observed: boolean | undefined;

    const load = (async (request: { isCurrent?: () => boolean }) => {
      observed = request.isCurrent?.();
      return { kind: "discarded" };
    }) as never;

    await runViewerResourceRefresh({
      arg: undefined,
      config: baseConfig({
        gate: {
          begin: () => ticket,
          isCurrent: () => false,
          finish: () => {},
        },
      }),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: null },
      setData: state.setData,
      setStatus: state.setStatus,
      load,
    });

    expect(observed).toBe(false);
  });
});

describe("runViewerResourceRefresh snapshot slicing", () => {
  const sliceConfig = (onSnapshotChange = vi.fn()) =>
    ({
      request: (tab: string) => ({ path: `/api/v1/media?type=${tab}` }),
      parse: (raw) => raw as Item[],
      fallbackError: "Gallery could not load.",
      initialData: [] as Item[],
      snapshotKey: (tab: string) => tab,
      onSnapshotChange,
    }) satisfies ViewerResourceOptions<Item[], string, unknown>;

  it("keeps the visible snapshot while refreshing the same slice", async () => {
    const onSnapshotChange = vi.fn();
    const state = stateHarness([{ id: "kept" }]);
    state.setStatus(() => ({ phase: "ready", error: null, hasSnapshot: true }));

    await runViewerResourceRefresh({
      arg: "image",
      config: sliceConfig(onSnapshotChange),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: "image" },
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "discarded" }),
    });

    expect(onSnapshotChange).not.toHaveBeenCalled();
    expect(state.data).toEqual([{ id: "kept" }]);
    // Still labelled as having a snapshot, so the UI keeps showing it.
    expect(state.status).toEqual({
      phase: "loading",
      error: null,
      hasSnapshot: true,
    });
  });

  it("drops the snapshot when the slice changes so no stale tab is shown", async () => {
    const onSnapshotChange = vi.fn();
    const snapshotKeyRef = { current: "image" };
    const state = stateHarness([{ id: "from-image-tab" }]);
    state.setStatus(() => ({ phase: "ready", error: null, hasSnapshot: true }));

    await runViewerResourceRefresh({
      arg: "video",
      config: sliceConfig(onSnapshotChange),
      serialRef: { current: 0 },
      snapshotKeyRef,
      setData: state.setData,
      setStatus: state.setStatus,
      load: loaderFor({ kind: "discarded" }),
    });

    expect(snapshotKeyRef.current).toBe("video");
    expect(onSnapshotChange).toHaveBeenCalledWith("video");
    expect(state.data).toEqual([]);
    expect(state.status).toEqual({
      phase: "loading",
      error: null,
      hasSnapshot: false,
    });
  });

  it("requests the path built from the refresh argument", async () => {
    const state = stateHarness([]);
    let requestedPath: string | undefined;

    const load = (async (request: { path: string }) => {
      requestedPath = request.path;
      return { kind: "loaded", data: [] };
    }) as never;

    await runViewerResourceRefresh({
      arg: "liked",
      config: sliceConfig(),
      serialRef: { current: 0 },
      snapshotKeyRef: { current: "liked" },
      setData: state.setData,
      setStatus: state.setStatus,
      load,
    });

    expect(requestedPath).toBe("/api/v1/media?type=liked");
  });
});
