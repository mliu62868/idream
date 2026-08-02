"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  failedAuthorityStatus,
  initialAuthorityStatus,
  loadingAuthorityStatusForScope,
  readyAuthorityStatus,
  type AuthorityStatus,
} from "@/components/ourdream/authority-state";
import { loadViewerResource } from "@/lib/viewer-resource-client";

// SPEC: binds one viewer-scoped read to component state — the data, its
// authority status, and a stable `refresh`.
//
// INTENT: the request lifecycle lives in `@/lib/viewer-resource-client` so it
// can be tested without React; the orchestration around it (request serial,
// viewer gate, snapshot slicing) lives in `runViewerResourceRefresh`, which
// takes its refs and setters as plain arguments for the same reason. The hook
// itself is the thin React binding that owns the real refs and state.
//
// INTENT: callers no longer choose *whether* to guard against an out-of-order
// response. GeneratorWorkspace's `refreshMedia` carried a request serial while
// its `refreshJobs` and `refreshPresets` — same file, same hazard — did not.
// The guard now lives where it cannot be omitted.

/**
 * A gate lets the owning component refuse or invalidate requests for viewer
 * reasons — signed out, or the signed-in identity changed underneath an
 * in-flight request. `begin` returning null means "do nothing at all": no
 * loading state, no snapshot reset, no request.
 */
export type ViewerRequestGate<Ticket = unknown> = {
  begin: () => Ticket | null;
  isCurrent: (ticket: Ticket) => boolean;
  finish: (ticket: Ticket) => void;
  /** Abort signal for the ticket, when the gate tracks controllers. */
  signal?: (ticket: Ticket) => AbortSignal | undefined;
};

export type ViewerResourceOptions<T, A, Ticket> = {
  /** Built per call so the URL can depend on the refresh argument. */
  request: (arg: A) => { path: string; init?: RequestInit };
  parse: (raw: unknown) => T;
  fallbackError: string;
  /** Also the value `reset()` restores. */
  initialData: T;
  gate?: ViewerRequestGate<Ticket>;
  /**
   * Identifies which slice the current snapshot belongs to (a gallery tab, say).
   * When it changes, the stale snapshot is dropped rather than left on screen
   * under a spinner that implies it is being refreshed.
   */
  snapshotKey?: (arg: A) => string;
  /**
   * Which slice the (empty) starting projection counts as, so the first refresh
   * for that slice is treated as a refresh rather than a slice change.
   */
  initialSnapshotKey?: string;
  /** Extra component state to clear when the snapshot key changes. */
  onSnapshotChange?: (arg: A) => void;
  /** Extra component state to settle once fresh data has been applied. */
  onLoaded?: (data: T, arg: A) => void;
};

export type ViewerResource<T, A> = {
  data: T;
  status: AuthorityStatus;
  /** For optimistic updates the owning component applies itself. */
  setData: React.Dispatch<React.SetStateAction<T>>;
  /**
   * Drops the projection back to empty-and-settled and invalidates every
   * in-flight request. Used when the viewer scope changes.
   */
  reset: () => void;
  refresh: (arg: A) => Promise<void>;
};

type MutableRef<V> = { current: V };

export type ViewerResourceRefreshInput<T, A, Ticket> = {
  arg: A;
  config: ViewerResourceOptions<T, A, Ticket>;
  serialRef: MutableRef<number>;
  snapshotKeyRef: MutableRef<string | null>;
  setData: (value: T) => void;
  setStatus: (update: (current: AuthorityStatus) => AuthorityStatus) => void;
  load?: typeof loadViewerResource;
};

/**
 * One refresh, start to finish. Exported for tests: every argument it needs is
 * injected, so the ordering rules below can be exercised with plain objects.
 *
 * INVARIANT: the serial is claimed before the first await and re-read after it,
 * so a slow earlier response can never overwrite a faster later one.
 */
export async function runViewerResourceRefresh<T, A, Ticket>(
  input: ViewerResourceRefreshInput<T, A, Ticket>,
): Promise<void> {
  const { config, serialRef, snapshotKeyRef } = input;
  const load = input.load ?? loadViewerResource;
  const gate = config.gate;

  const ticket = gate ? gate.begin() : (null as Ticket);
  // INVARIANT: a refused ticket leaves every piece of state untouched — no
  // loading spinner for a request that will never be sent.
  if (gate && ticket === null) return;

  const serial = serialRef.current + 1;
  serialRef.current = serial;

  const snapshotKey = config.snapshotKey?.(input.arg) ?? null;
  const hasMatchingSnapshot =
    snapshotKey === null || snapshotKeyRef.current === snapshotKey;
  if (!hasMatchingSnapshot) {
    snapshotKeyRef.current = snapshotKey;
    input.setData(config.initialData);
    config.onSnapshotChange?.(input.arg);
  }
  input.setStatus((current) =>
    loadingAuthorityStatusForScope(current, hasMatchingSnapshot),
  );

  const isCurrent = () =>
    serial === serialRef.current && (!gate || gate.isCurrent(ticket as Ticket));

  try {
    const { path, init } = config.request(input.arg);
    const signal = gate?.signal?.(ticket as Ticket);
    const outcome = await load({
      path,
      parse: config.parse,
      fallbackError: config.fallbackError,
      init: signal ? { ...init, signal } : init,
      isCurrent,
    });

    if (outcome.kind === "discarded") return;
    if (outcome.kind === "failed") {
      input.setStatus((current) => failedAuthorityStatus(current, outcome.error));
      return;
    }
    input.setData(outcome.data);
    input.setStatus(() => readyAuthorityStatus());
    config.onLoaded?.(outcome.data, input.arg);
  } finally {
    if (gate) gate.finish(ticket as Ticket);
  }
}

export function useViewerResource<T, A = void, Ticket = unknown>(
  options: ViewerResourceOptions<T, A, Ticket>,
): ViewerResource<T, A> {
  const [data, setData] = useState<T>(options.initialData);
  const [status, setStatus] = useState<AuthorityStatus>(initialAuthorityStatus);

  // INVARIANT: `refresh` and `reset` must keep a stable identity across renders.
  // They feed effect and memo dependency arrays in the workspaces; a fresh
  // closure each render would re-fire those effects and turn one refresh into a
  // request loop. Options are read through a ref so the callbacks can hold [].
  //
  // INVARIANT: options must not close over changing render state. The ref is
  // synced after commit, so a refresh fired between render and effect would see
  // the previous options. Every caller's callbacks touch only setState
  // dispatchers and module-level parsers, which never go stale.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const serialRef = useRef(0);
  const snapshotKeyRef = useRef<string | null>(
    options.initialSnapshotKey ?? null,
  );

  const reset = useCallback(() => {
    serialRef.current += 1;
    // INVARIANT: the snapshot key deliberately survives a reset. The projection
    // it labels is emptied, not re-sliced, so the next refresh for the same
    // slice stays a refresh — matching the viewer-scope reset it replaces.
    setData(optionsRef.current.initialData);
    setStatus(readyAuthorityStatus());
  }, []);

  const refresh = useCallback(
    (arg: A) =>
      runViewerResourceRefresh({
        arg,
        config: optionsRef.current,
        serialRef,
        snapshotKeyRef,
        setData,
        setStatus,
      }),
    [],
  );

  return { data, status, setData, reset, refresh };
}
