// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creativeRunCreateRequestSchema } from "@idream/shared/admin";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  beginDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  readDurableMutationIntent,
  updateDurableMutationIntent,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { createOrRecoverCharacterRun } from "./creative-run-creation";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/admin-v2-api")>(),
  adminV2Request: request,
}));

const scope = "character-asset:create:actor-1:character-1";
const original = creativeRunCreateRequestSchema.parse({
  title: "First portrait", purpose: "character_cover", targetType: "character",
  targetId: "character-1", profileId: "portrait-v1", bootstrapIdentity: true,
  count: 1, brief: "Portrait with natural daylight", reason: "Create a first identity portrait",
});

describe("Character creative Run creation", () => {
  let intent: DurableMutationIntent | null;
  const saved = () => readActiveDurableMutationIntent({ scope });
  const create = (draft = original, commit?: Parameters<typeof createOrRecoverCharacterRun>[0]["commit"]) =>
    createOrRecoverCharacterRun({
      scope,
      characterId: "character-1",
      expectedPurpose: "character_cover",
      intent,
      request: draft,
      parseRequest: (snapshot) => {
        const parsed = creativeRunCreateRequestSchema.safeParse(snapshot);
        return parsed.success ? parsed.data : null;
      },
      signature: JSON.stringify,
      onIntentChange: (next) => { intent = next; },
      commit,
    });
  const seed = (status: DurableMutationIntent["status"] = "outcome_unknown", snapshot: unknown = original) => {
    intent = updateDurableMutationIntent(beginDurableMutationIntent({
      scope, signature: JSON.stringify(original), requestSnapshot: snapshot,
    }), { status });
    return intent;
  };
  const committedReceipt = (snapshot: unknown = original) => ({
    state: "committed", commandType: "creative.run.create", commandId: "command-1",
    status: "succeeded", committedTargetId: "run-1",
    verification: { kind: "creative_run", runId: "run-1", requestSnapshot: snapshot },
  });

  beforeEach(() => {
    window.localStorage.clear();
    intent = null;
    request.mockReset();
    request.mockResolvedValue({ batch: { id: "run-1" }, replayed: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it("releases a first definite rejection and permits a fresh key", async () => {
    request.mockRejectedValueOnce(new AdminV2RequestError("Permission denied", 403));
    await expect(create()).rejects.toThrow("Permission denied");
    expect(intent).toBeNull();
    expect(saved()).toBeNull();
    const firstKey = request.mock.calls[0][1].idempotencyKey;
    await expect(create()).resolves.toMatchObject({ state: "committed", runId: "run-1" });
    expect(request.mock.calls[1][1].idempotencyKey).not.toBe(firstKey);
  });

  it.each([
    [401, "Session expired"],
    [403, "Permission denied"],
    [409, "Version changed"],
    [503, "Runtime unavailable. No Run was created."],
  ])("preserves an unknown submission through a rejected replay (%s)", async (status, message) => {
    request.mockRejectedValueOnce(new TypeError("Response ended before receipt"));
    await expect(create()).rejects.toThrow("Response ended before receipt");
    const firstKey = saved()?.idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(saved()?.status).toBe("outcome_unknown");
    // Recover after a page reload, with an editable draft that has since changed.
    intent = saved();
    request.mockRejectedValueOnce(new AdminV2RequestError(message, status, "unavailable"));
    await expect(create({ ...original, brief: "A later unrelated draft" })).rejects.toThrow(message);
    expect(saved()).toMatchObject({ idempotencyKey: firstKey, status: "outcome_unknown", requestSnapshot: original });
    request.mockResolvedValueOnce({ batch: { id: "run-1" }, replayed: true });
    await expect(create()).resolves.toMatchObject({ state: "committed", runId: "run-1", replayed: true });
    expect(request.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([firstKey, firstKey, firstKey]);
    expect(request.mock.calls.map(([, options]) => options.body)).toEqual([original, original, original]);
  });

  it("retains a first submission when a rejection status has no usable receipt", async () => {
    request.mockRejectedValueOnce(new AdminV2RequestError(
      "Authority response body ended before it could be decoded", 400,
      undefined, undefined, "interrupted-receipt-request", "unknown",
    ));
    await expect(create()).rejects.toThrow("before it could be decoded");
    const key = saved()?.idempotencyKey;
    expect(saved()).toMatchObject({ status: "outcome_unknown", requestSnapshot: original });
    await expect(create()).resolves.toMatchObject({ state: "committed", runId: "run-1" });
    expect(request.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([key, key]);
  });

  it("releases an explicit no-effect runtime rejection only on the first submission", async () => {
    request.mockRejectedValueOnce(new AdminV2RequestError("Runtime unavailable. No Run was created.", 503, "unavailable"));
    await expect(create()).rejects.toThrow("No Run was created");
    expect(saved()).toBeNull();
  });

  it("treats a saved submitting intent as a replay, even without legacy replay evidence", async () => {
    const active = seed("submitting");
    expect(active.replayStarted).toBeUndefined();
    request.mockRejectedValueOnce(new AdminV2RequestError("Replay forbidden", 403));
    await expect(create()).rejects.toThrow("Replay forbidden");
    expect(saved()).toMatchObject({ idempotencyKey: active.idempotencyKey, status: "outcome_unknown", replayStarted: true });
  });

  it("shows another tab's saved request before acting on it", async () => {
    const active = seed();
    intent = null;
    await expect(create({ ...original, brief: "New editable request" })).resolves.toMatchObject({ state: "blocked", intent: active });
    expect(request).not.toHaveBeenCalled();
    expect(saved()?.idempotencyKey).toBe(active.idempotencyKey);
  });

  it("never downgrades another tab's committed receipt after a late rejected replay", async () => {
    const active = seed();
    request.mockImplementationOnce(async () => {
      updateDurableMutationIntent(active, { status: "committed_projection_pending", committedTargetId: "run-1" });
      throw new AdminV2RequestError("Replay forbidden", 403);
    });
    await expect(create()).rejects.toThrow("Replay forbidden");
    expect(saved()).toMatchObject({ idempotencyKey: active.idempotencyKey, status: "committed_projection_pending", committedTargetId: "run-1" });
    await expect(create()).resolves.toMatchObject({ state: "committed", source: "projection", runId: "run-1" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the active key when the first request is rejected while a replay is still in flight", async () => {
    let rejectFirst: (cause: unknown) => void = () => { throw new Error("First request not started"); };
    let acceptReplay: () => void = () => { throw new Error("Replay not started"); };
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    request.mockImplementationOnce(() => new Promise((resolve) => {
      acceptReplay = () => resolve({ batch: { id: "run-1" }, replayed: false });
    }));
    const first = create().catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const key = saved()?.idempotencyKey;
    const replay = create();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    rejectFirst(new AdminV2RequestError("First request forbidden", 403));
    expect(await first).toBeInstanceOf(AdminV2RequestError);
    expect(saved()).toMatchObject({ idempotencyKey: key, replayStarted: true });
    acceptReplay();
    await expect(replay).resolves.toMatchObject({ state: "committed", runId: "run-1" });
    expect(saved()).toMatchObject({ idempotencyKey: key, status: "committed_projection_pending", replayStarted: true });
    expect(request.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual([key, key]);
  });

  it("reconciles a stale page copy after another tab released its original key", async () => {
    const stale = seed();
    clearDurableMutationIntent(stale);
    request.mockResolvedValueOnce({ state: "cancelled", commandType: "creative.run.create", commandId: null, status: null, committedTargetId: null });
    await expect(create()).resolves.toEqual({ state: "cancelled" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("/api/v2/admin/mutation-receipts/reconcile");
    expect(request.mock.calls[0][1].idempotencyKey).toBe(stale.idempotencyKey);
    expect(saved()).toBeNull();
  });

  it("restores the active pointer before reconciling a stale page's committed receipt", async () => {
    const stale = seed();
    clearDurableMutationIntent(stale);
    request.mockResolvedValueOnce(committedReceipt());
    await expect(create()).resolves.toMatchObject({ state: "committed", source: "reconciliation" });
    expect(saved()).toMatchObject({ idempotencyKey: stale.idempotencyKey, status: "committed_projection_pending", committedTargetId: "run-1" });
    intent = saved();
    await expect(create()).resolves.toMatchObject({ state: "committed", source: "projection" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])("does not resurrect a released intent after a late %s", async (outcome) => {
    let finish: () => void = () => { throw new Error("Request not started"); };
    request.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => outcome === "success"
        ? resolve({ batch: { id: "run-1" }, replayed: true })
        : reject(new TypeError("Late transport failure"));
    }));
    const pending = create();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const old = saved()!;
    clearDurableMutationIntent(old);
    intent = null;
    finish();
    await expect(pending).resolves.toEqual({ state: "superseded" });
    expect(saved()).toBeNull();
    expect(readDurableMutationIntent({ scope, signature: old.signature })).toBeNull();
  });

  it.each([
    ["success", "same"], ["failure", "same"],
    ["success", "different"], ["failure", "different"],
  ])("preserves the next request after a late %s with a %s signature", async (outcome, signature) => {
    let finish: () => void = () => { throw new Error("Request not started"); };
    request.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => outcome === "success"
        ? resolve({ batch: { id: "run-1" }, replayed: true })
        : reject(new AdminV2RequestError("Late forbidden", 403));
    }));
    const pending = create();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const old = saved()!;
    // The other tab has already displayed and released the old Run, then created another.
    clearDurableMutationIntent(old);
    intent = null;
    request.mockResolvedValueOnce({ batch: { id: "run-2" }, replayed: false });
    const nextDraft = signature === "same" ? original : { ...original, brief: "Another portrait" };
    await expect(create(nextDraft)).resolves.toMatchObject({ state: "committed", runId: "run-2" });
    const next = saved();
    expect(next?.idempotencyKey).not.toBe(old.idempotencyKey);
    finish();
    await expect(pending).resolves.toMatchObject({ state: "blocked", intent: next });
    expect(saved()).toEqual(next);
    expect(readDurableMutationIntent({ scope, signature: JSON.stringify(nextDraft) })).toEqual(next);
  });

  it("holds the same journal lock for replay marking and response settlement, but never HTTP", async () => {
    const previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    let queue = Promise.resolve();
    let held: string | null = null;
    const names: string[] = [];
    const locks = {
      request<T>(name: string, transition: () => T | Promise<T>): Promise<T> {
        names.push(name);
        const result = queue.then(async () => {
          held = name;
          try { return await transition(); } finally { held = null; }
        });
        queue = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
    const storage = window.localStorage;
    const previousStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
    const writeLocks: (string | null)[] = [];
    const expectedLock = `idream:admin:mutation-intent:v1:claim:${encodeURIComponent(scope)}`;
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: storage.getItem.bind(storage),
      setItem: (key: string, value: string) => { writeLocks.push(held); storage.setItem(key, value); },
      removeItem: (key: string) => { writeLocks.push(held); storage.removeItem(key); },
    } });
    try {
      let rejectFirst: (cause: unknown) => void = () => { throw new Error("Request not started"); };
      request.mockImplementationOnce(() => {
        expect(held).toBeNull();
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      });
      const first = create().catch((cause: unknown) => cause);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      const key = saved()?.idempotencyKey;
      // Simulate another tab owning the journal while the first response arrives.
      let release: () => void = () => { throw new Error("Lock not held"); };
      const otherTab = locks.request(expectedLock, () => {
        updateDurableMutationIntent(saved()!, { status: "submitting", replayStarted: true });
        return new Promise<void>((resolve) => { release = resolve; });
      });
      await vi.waitFor(() => expect(held).toBe(expectedLock));
      rejectFirst(new AdminV2RequestError("First request forbidden", 403));
      await vi.waitFor(() => expect(names).toHaveLength(3));
      expect(saved()).toMatchObject({ idempotencyKey: key, status: "submitting", replayStarted: true });
      release();
      await otherTab;
      expect(await first).toBeInstanceOf(AdminV2RequestError);
      expect(saved()).toMatchObject({ idempotencyKey: key, status: "outcome_unknown", replayStarted: true });
      expect(new Set(names)).toEqual(new Set([expectedLock]));
      expect(writeLocks.length).toBeGreaterThan(0);
      expect(new Set(writeLocks)).toEqual(new Set([expectedLock]));
    } finally {
      if (previousStorage) Object.defineProperty(window, "localStorage", previousStorage);
      else Reflect.deleteProperty(window, "localStorage");
      if (previousLocks) Object.defineProperty(navigator, "locks", previousLocks);
      else Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("records the receipt before a coordinated workspace refresh can fail", async () => {
    await expect(create(original, async (submit) => {
      await submit();
      throw new Error("Workspace refresh unavailable");
    })).rejects.toThrow("Workspace refresh unavailable");
    expect(saved()).toMatchObject({ status: "committed_projection_pending", committedTargetId: "run-1" });
    await expect(create()).resolves.toMatchObject({ state: "committed", source: "projection" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recovers an unusable saved snapshot from a verified receipt without another create", async () => {
    const old = seed("outcome_unknown", { legacy: true });
    request.mockResolvedValueOnce(committedReceipt());
    await expect(create()).resolves.toMatchObject({ state: "committed", source: "reconciliation", runId: "run-1", request: original });
    expect(request).toHaveBeenCalledWith("/api/v2/admin/mutation-receipts/reconcile", expect.objectContaining({
      idempotencyKey: old.idempotencyKey,
      body: { commandType: "creative.run.create", expectedCharacterId: "character-1", expectedPurpose: "character_cover" },
    }));
    expect(saved()).toMatchObject({ status: "committed_projection_pending", requestSnapshot: original });
  });

  it("retains a saved key when reconciliation returns another Character's request", async () => {
    const old = seed("reconciliation_required");
    request.mockResolvedValueOnce(committedReceipt({ ...original, targetId: "other-character" }));
    await expect(create()).rejects.toThrow("exact request");
    expect(saved()).toMatchObject({ idempotencyKey: old.idempotencyKey, status: "reconciliation_required" });
  });

  it("unlocks a reconciled request only after the server seals a no-effect cancellation", async () => {
    seed("reconciliation_required");
    request.mockResolvedValueOnce({ state: "cancelled", commandType: "creative.run.create", commandId: null, status: null, committedTargetId: null });
    await expect(create()).resolves.toEqual({ state: "cancelled" });
    expect(saved()).toBeNull();
    expect(request.mock.calls[0][0]).toBe("/api/v2/admin/mutation-receipts/reconcile");
  });

  it("keeps a terminally failed receipt locked for investigation", async () => {
    const old = seed("reconciliation_required");
    request.mockResolvedValueOnce({ state: "failed", commandType: "creative.run.create", commandId: "command-1", status: "failed", committedTargetId: null });
    await expect(create()).resolves.toMatchObject({ state: "pending", receipt: { state: "failed" } });
    expect(saved()?.idempotencyKey).toBe(old.idempotencyKey);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
