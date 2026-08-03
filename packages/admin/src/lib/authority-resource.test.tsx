// @vitest-environment happy-dom

import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAuthorityResource,
  usePollingTask,
  type AuthorityPollContext,
  type AuthorityResource,
  type PollDecision,
  type PollingTask,
} from "./authority-resource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("usePollingTask", () => {
  function Probe({ task, initialDelay }: {
    task: PollingTask | null;
    initialDelay?: PollDecision | (() => PollDecision);
  }) {
    usePollingTask(task, initialDelay);
    return null;
  }

  it("re-arms with the delay the task returns and stops when it returns null", async () => {
    const at: number[] = [];
    let start = 0;
    const task = vi.fn((): PollDecision => {
      at.push(Date.now() - start);
      return at.length < 3 ? at.length * 1_000 : null;
    });

    start = Date.now();
    await act(async () => {
      root.render(<Probe task={task} initialDelay={500} />);
    });

    await advance(10_000);
    // 500 → +1000 → +2000, then the third decision stops the loop.
    expect(at).toEqual([500, 1_500, 3_500]);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("never arms when the initial decision is null", async () => {
    const task = vi.fn((): PollDecision => 1_000);
    await act(async () => {
      root.render(<Probe task={task} initialDelay={() => null} />);
    });
    await advance(30_000);
    expect(task).not.toHaveBeenCalled();
  });

  it("stops scheduling after unmount and tells the in-flight round it was cancelled", async () => {
    let seenCancelled: boolean | null = null;
    let release: (() => void) | null = null;
    const task = vi.fn(async (context: { cancelled: boolean }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      seenCancelled = context.cancelled;
      return 1_000 as PollDecision;
    });

    await act(async () => {
      root.render(<Probe task={task} initialDelay={0} />);
    });
    await advance(1);
    expect(task).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    await act(async () => {
      release?.();
    });
    await advance(30_000);

    expect(seenCancelled).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe("useAuthorityResource", () => {
  type Row = { id: string; state: string };

  function Harness({
    queryKey,
    load,
    pollWhile,
    onState,
  }: {
    queryKey: string;
    load: () => Promise<Row>;
    pollWhile?: (context: AuthorityPollContext<Row>) => PollDecision;
    onState: (resource: AuthorityResource<Row>) => void;
  }) {
    const resource = useAuthorityResource(
      { key: queryKey, load: useCallback(load, [load]) },
      { pollWhile },
    );
    onState(resource);
    return null;
  }

  it("loads once on mount without the caller writing a mount ceremony", async () => {
    const load = vi.fn(async () => ({ id: "run-1", state: "running" }));
    let latest: AuthorityResource<Row> | null = null;

    await act(async () => {
      root.render(
        <Harness queryKey="run-1" load={load} onState={(r) => { latest = r; }} />,
      );
    });
    expect(latest!.loading).toBe(true);

    await advance(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(latest!).toMatchObject({
      data: { id: "run-1", state: "running" },
      dataKey: "run-1",
      loading: false,
      error: null,
    });
  });

  it("keeps last-good data and routes a background poll failure to refreshError", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return { id: "run-1", state: "running" };
      throw new Error("Projection unavailable");
    });
    let latest: AuthorityResource<Row> | null = null;

    await act(async () => {
      root.render(
        <Harness
          queryKey="run-1"
          load={load}
          pollWhile={({ data }) => (data?.state === "running" ? 4_000 : null)}
          onState={(r) => { latest = r; }}
        />,
      );
    });
    await advance(1);
    expect(latest!.data).toMatchObject({ state: "running" });

    await advance(4_000);
    // SPEC: 后台刷新失败不得把已经取到的权威数据换成报错。
    expect(latest!.data).toMatchObject({ state: "running" });
    expect(latest!.error).toBeNull();
    expect(latest!.refreshError).toBe("Projection unavailable");
  });

  it("discards data from a superseded query key", async () => {
    let releaseSecond: ((row: Row) => void) | null = null;
    const load = vi.fn((key: string) => async () =>
      key === "run-1"
        ? { id: "run-1", state: "succeeded" }
        : new Promise<Row>((resolve) => { releaseSecond = resolve; }));
    let latest: AuthorityResource<Row> | null = null;

    const render = (queryKey: string) =>
      act(async () => {
        root.render(
          <Harness
            queryKey={queryKey}
            load={load(queryKey)}
            onState={(r) => { latest = r; }}
          />,
        );
      });

    await render("run-1");
    await advance(1);
    expect(latest!).toMatchObject({ dataKey: "run-1", data: { id: "run-1" } });

    await render("run-2");
    await advance(1);
    // INVARIANT: 换查询后，在新数据到达前不得继续显示旧资源的数据。
    expect(latest!).toMatchObject({ data: null, dataKey: null, loading: true });

    await act(async () => {
      releaseSecond?.({ id: "run-2", state: "queued" });
    });
    expect(latest!).toMatchObject({ dataKey: "run-2", data: { id: "run-2" } });
  });

  it("ignores a stale in-flight response that resolves after the query key changed", async () => {
    let releaseFirst: ((row: Row) => void) | null = null;
    const load = (key: string) => async () =>
      key === "run-1"
        ? new Promise<Row>((resolve) => { releaseFirst = resolve; })
        : { id: "run-2", state: "queued" };
    let latest: AuthorityResource<Row> | null = null;

    const render = (queryKey: string) =>
      act(async () => {
        root.render(
          <Harness
            queryKey={queryKey}
            load={load(queryKey)}
            onState={(r) => { latest = r; }}
          />,
        );
      });

    await render("run-1");
    await advance(1);
    await render("run-2");
    await advance(1);
    expect(latest!.dataKey).toBe("run-2");

    // INVARIANT: 迟到的旧查询响应必须被 latest-request 门控丢弃，不得覆盖新查询。
    await act(async () => {
      releaseFirst?.({ id: "run-1", state: "succeeded" });
    });
    expect(latest!).toMatchObject({ dataKey: "run-2", data: { id: "run-2" } });
  });

  it("stops polling once the resource reaches a settled state", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      return { id: "run-1", state: attempt < 3 ? "running" : "succeeded" };
    });
    let latest: AuthorityResource<Row> | null = null;

    await act(async () => {
      root.render(
        <Harness
          queryKey="run-1"
          load={load}
          pollWhile={({ data }) => (data?.state === "running" ? 4_000 : null)}
          onState={(r) => { latest = r; }}
        />,
      );
    });
    await advance(1);
    await advance(60_000);

    expect(latest!.data).toMatchObject({ state: "succeeded" });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("lets pollWhile express an attempt-indexed escalating interval", async () => {
    // SPEC: CharacterWorkspace 的五档自适应必须能声明式表达，不能被压成固定间隔。
    const tiers = [250, 1_000, 2_000, 5_000, 5_000];
    const gaps: number[] = [];
    let previous = 0;
    const load = vi.fn(async () => {
      const now = Date.now();
      if (previous) gaps.push(now - previous);
      previous = now;
      return { id: "run-1", state: "running" };
    });
    let latest: AuthorityResource<Row> | null = null;

    await act(async () => {
      root.render(
        <Harness
          queryKey="run-1"
          load={load}
          pollWhile={({ data, attempt }) =>
            data?.state === "running"
              ? tiers[Math.min(attempt, tiers.length - 1)]!
              : null}
          onState={(r) => { latest = r; }}
        />,
      );
    });
    await advance(1);
    previous = Date.now();
    await advance(30_000);

    // 首轮 250ms，随后逐档放慢到 5s 并保持。
    expect(gaps.slice(0, 4)).toEqual([250, 1_000, 2_000, 5_000]);
    expect(latest!.error).toBeNull();
  });

  it("backs off on consecutive failures and recovers the base cadence after a success", async () => {
    const outcomes = ["ok", "fail", "fail", "ok", "ok"];
    const gaps: number[] = [];
    let previous = 0;
    let index = 0;
    const load = vi.fn(async () => {
      const now = Date.now();
      if (previous) gaps.push(now - previous);
      previous = now;
      const outcome = outcomes[Math.min(index, outcomes.length - 1)]!;
      index += 1;
      if (outcome === "fail") throw new Error("upstream stalled");
      return { id: "run-1", state: "running" };
    });

    await act(async () => {
      root.render(
        <Harness
          queryKey="run-1"
          load={load}
          pollWhile={({ data, consecutiveFailures }) =>
            data?.state === "running"
              ? 5_000 * 2 ** Math.min(consecutiveFailures, 2)
              : null}
          onState={() => {}}
        />,
      );
    });
    await advance(1);
    previous = Date.now();
    await advance(60_000);

    // 5s 基础 → 失败后 10s → 再失败 20s → 成功后回到 5s。
    expect(gaps.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 5_000]);
  });

  it("does not fetch or poll while disabled", async () => {
    const load = vi.fn(async () => ({ id: "run-1", state: "running" }));
    function Disabled() {
      const [enabled] = useState(false);
      useAuthorityResource(
        { key: "run-1", enabled, load: useCallback(load, []) },
        { pollWhile: () => 1_000 },
      );
      return null;
    }
    await act(async () => {
      root.render(<Disabled />);
    });
    await advance(30_000);
    expect(load).not.toHaveBeenCalled();
  });
});
