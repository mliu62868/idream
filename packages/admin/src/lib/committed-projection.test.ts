// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  committedProjectionTargetId,
  createCommittedProjectionLoader,
  isProjectionRequestCancellation,
  SupersededProjectionError,
  type CommittedProjectionVerdict,
} from "./committed-projection";
import {
  beginDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "./durable-mutation-intent";

type Projection = { readonly id: string; readonly stamp: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function intentFixture(
  overrides: Partial<DurableMutationIntent> = {},
): DurableMutationIntent {
  return {
    version: 1,
    scope: "test-scope",
    signature: "test-signature",
    idempotencyKey: "test-key",
    status: "committed_projection_pending",
    createdAt: 0,
    updatedAt: 0,
    committedTargetId: "run-1",
    ...overrides,
  };
}

// 一个最小的调用方：目标 id 与在途意图都放在可变的 state 里，测试据此模拟
// 「等待响应期间运营台切了目标 / 另一笔提交占了意图槽位」。
function createHarness(
  options: {
    readonly reflects?: (
      intent: DurableMutationIntent,
      projection: Projection,
    ) => boolean;
    readonly onCommit?: () => void;
  } = {},
) {
  const pending: Array<{
    readonly targetId: string;
    readonly deferred: ReturnType<typeof deferred<Projection>>;
  }> = [];
  const commits: Array<{
    readonly projection: Projection;
    readonly verdict: CommittedProjectionVerdict;
  }> = [];
  const state = {
    target: "run-1" as string | null,
    intent: null as DurableMutationIntent | null,
    releases: 0,
  };
  const loader = createCommittedProjectionLoader<Projection>(() => ({
    fetch: (targetId) => {
      const entry = { targetId, deferred: deferred<Projection>() };
      pending.push(entry);
      return entry.deferred.promise;
    },
    isCurrentTarget: (targetId) => state.target === targetId,
    committed: {
      current: () => state.intent,
      reflects: options.reflects ??
        ((intent, projection) => intent.committedTargetId === projection.id),
      mismatchMessage: "The committed projection does not match.",
      onReleased: () => {
        state.releases += 1;
        state.intent = null;
      },
    },
    commit: (projection, verdict) => {
      commits.push({ projection, verdict });
      options.onCommit?.();
    },
  }));
  return { loader, pending, commits, state };
}

describe("committed projection protocol", () => {
  // INVARIANT 1: 同一个目标的在途请求不重复发起。
  it("shares one in-flight projection request per target", async () => {
    const harness = createHarness();
    const first = harness.loader.load("run-1");
    const second = harness.loader.load("run-1");

    expect(harness.pending).toHaveLength(1);
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "a" });

    expect(await first).toEqual({ id: "run-1", stamp: "a" });
    expect(await second).toEqual({ id: "run-1", stamp: "a" });
    // 去重必须一路做到写状态：两个调用方只能产生一次写入。
    expect(harness.commits).toHaveLength(1);
  });

  it("stops sharing once the in-flight request settles", async () => {
    const harness = createHarness();
    const first = harness.loader.load("run-1");
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "a" });
    await first;

    void harness.loader.load("run-1").catch(() => undefined);
    expect(harness.pending).toHaveLength(2);
  });

  // INVARIANT 2: 被取代的投影不得覆盖更新的结果。
  it("never asks the server for a target that is no longer wanted", async () => {
    const harness = createHarness();
    harness.state.target = "run-2";

    await expect(harness.loader.load("run-1")).rejects.toBeInstanceOf(
      SupersededProjectionError,
    );
    expect(harness.pending).toHaveLength(0);
    expect(harness.commits).toHaveLength(0);
  });

  it("drops a projection whose target changed while it was in flight", async () => {
    const harness = createHarness();
    const load = harness.loader.load("run-1");
    harness.state.target = "run-2";
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "stale" });

    await expect(load).rejects.toBeInstanceOf(SupersededProjectionError);
    expect(harness.commits).toHaveLength(0);
  });

  it("drops a projection that was invalidated while it was in flight", async () => {
    const harness = createHarness();
    const load = harness.loader.load("run-1");
    harness.loader.invalidate();
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "stale" });

    await expect(load).rejects.toBeInstanceOf(SupersededProjectionError);
    expect(harness.commits).toHaveLength(0);
  });

  it("keeps a superseded projection from overwriting the newer one", async () => {
    const harness = createHarness();
    const stale = harness.loader.load("run-1");
    // 运营台切到另一条 Run：先作废在途结果，再换目标。
    harness.loader.invalidate();
    harness.state.target = "run-2";
    const fresh = harness.loader.load("run-2");

    harness.pending[1].deferred.resolve({ id: "run-2", stamp: "fresh" });
    await fresh;
    // 旧请求最后才回来——它必须无声退场，而不是把界面倒退回旧投影。
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "stale" });
    await expect(stale).rejects.toBeInstanceOf(SupersededProjectionError);

    expect(harness.commits.map((entry) => entry.projection.stamp)).toEqual([
      "fresh",
    ]);
  });

  // INVARIANT 3: 提交目标与非提交目标的失败走不同出口。
  it("routes a failed committed target to the recoverable exit", () => {
    const harness = createHarness();
    harness.state.intent = intentFixture({ committedTargetId: "run-1" });

    expect(harness.loader.routeFailure("run-1", new Error("boom"))).toEqual({
      kind: "recoverable",
      detail: "boom",
    });
    expect(harness.loader.routeFailure("run-2", new Error("boom"))).toEqual({
      kind: "fatal",
      detail: "boom",
    });
  });

  it("routes every failure to the fatal exit when nothing is committed", () => {
    const harness = createHarness();

    expect(harness.loader.routeFailure("run-1", new Error("boom"))).toEqual({
      kind: "fatal",
      detail: "boom",
    });
    // 提交中 / 结果未知的意图还没有可校验的目标，不能把失败降级成旁注。
    harness.state.intent = intentFixture({
      status: "outcome_unknown",
      committedTargetId: "run-1",
    });
    expect(harness.loader.routeFailure("run-1", new Error("boom"))).toEqual({
      kind: "fatal",
      detail: "boom",
    });
  });

  it("routes cancellations to no exit at all", () => {
    const harness = createHarness();
    harness.state.intent = intentFixture({ committedTargetId: "run-1" });
    const abort = new Error("aborted");
    abort.name = "AbortError";

    expect(
      harness.loader.routeFailure("run-1", new SupersededProjectionError()),
    ).toEqual({ kind: "ignored" });
    expect(harness.loader.routeFailure("run-1", abort)).toEqual({
      kind: "ignored",
    });
    expect(isProjectionRequestCancellation(new Error("boom"))).toBe(false);
  });

  it("only treats a committed_projection_pending intent as having a target", () => {
    expect(committedProjectionTargetId(null)).toBeNull();
    expect(
      committedProjectionTargetId(intentFixture({ committedTargetId: "run-1" })),
    ).toBe("run-1");
    expect(
      committedProjectionTargetId(
        intentFixture({
          status: "reconciliation_required",
          committedTargetId: "run-1",
        }),
      ),
    ).toBeNull();
  });

  // INVARIANT 5: 成功写状态是一个原子步骤——要么整步发生，要么一处都不写。
  it("writes nothing when the committed target's projection does not match", async () => {
    const harness = createHarness({ reflects: () => false });
    harness.state.intent = intentFixture({ committedTargetId: "run-1" });
    const load = harness.loader.load("run-1");
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "wrong" });

    await expect(load).rejects.toThrow(
      "The committed projection does not match.",
    );
    expect(harness.commits).toHaveLength(0);
    // 对不上就不能放掉幂等键——放掉等于允许再发一次生成。
    expect(harness.state.releases).toBe(0);
  });

  it("applies the state write and releases the key as one step", async () => {
    const scope = "committed-projection-release";
    const intent = beginDurableMutationIntent({
      scope,
      signature: "release-signature",
      createIdempotencyKey: () => "release-key",
    });
    const committed = updateDurableMutationIntent(intent, {
      status: "committed_projection_pending",
      committedTargetId: "run-1",
    });
    const harness = createHarness();
    harness.state.intent = committed;

    const load = harness.loader.load("run-1");
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "ok" });
    await load;

    expect(harness.commits).toEqual([
      {
        projection: { id: "run-1", stamp: "ok" },
        verdict: { kind: "reflected" },
      },
    ]);
    expect(harness.state.releases).toBe(1);
    expect(readActiveDurableMutationIntent({ scope })).toBeNull();
  });

  it("reports an unrelated read as unrelated and leaves the key alone", async () => {
    const harness = createHarness();
    harness.state.intent = intentFixture({ committedTargetId: "run-9" });
    harness.state.target = "run-1";

    const load = harness.loader.load("run-1");
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "browsing" });
    await load;

    expect(harness.commits).toEqual([
      {
        projection: { id: "run-1", stamp: "browsing" },
        verdict: { kind: "unrelated" },
      },
    ]);
    expect(harness.state.releases).toBe(0);
  });

  it("never releases an intent that was replaced during the write", async () => {
    const replacement = intentFixture({
      idempotencyKey: "another-tab-key",
      committedTargetId: "run-1",
    });
    const harness = createHarness({
      onCommit: () => {
        harness.state.intent = replacement;
      },
    });
    harness.state.intent = intentFixture({ committedTargetId: "run-1" });

    const load = harness.loader.load("run-1");
    harness.pending[0].deferred.resolve({ id: "run-1", stamp: "ok" });
    await load;

    expect(harness.commits).toHaveLength(1);
    expect(harness.state.releases).toBe(0);
    expect(harness.state.intent).toBe(replacement);
  });
});
