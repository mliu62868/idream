"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  invalidateViewerAuthority,
  resolveViewerAuthority,
  type ViewerAuthority,
} from "@/components/ourdream/viewer-auth";
import {
  requestErrorMessage,
  type ResourceFetcher,
} from "@/lib/viewer-resource-client";
import type { ViewerRequestGate } from "./useViewerResource";

/**
 * INVARIANT: an `AbortError`, so `loadViewerResource` and every existing catch
 * that already swallows aborts treat a mid-flight account change the same way
 * they treat a cancelled request — as "no answer", never as data.
 */
export class ViewerGateError extends DOMException {
  constructor() {
    super(
      "Your account changed. Reload this page to continue with the current account.",
      "AbortError",
    );
  }
}

// SPEC: the standard gate every viewer-scoped read passes through. It owns the
// server-confirmed owner, the request generation, the `x-idream-viewer-scope`
// header, the focus/visibility re-validation, and the projection reset that an
// account change demands.
//
// INTENT: `ViewerRequestGate` shipped with exactly one adopter, so it was a seam
// nobody crossed. Every workspace grew its own epoch/owner/scope triple instead:
// GroupChatManager compared an `ownerScope` echoed by the payload,
// CoinStoreWorkspace re-read `/api/v1/me` around each write, ComicStudio
// verified an `authorId` on focus, UserPersonaPanel remounted on an `ownerScope`
// prop, RecoveryCodeCard kept its own serial. Nine surfaces, nine spellings of
// one rule — which is why 2026-09-02 landed nine same-shaped fixes in a day and
// the next four surfaces written after it repeated the bug anyway.
//
// INTENT: passing `gate` is the entire contract. A caller cannot attach the
// scope header and forget the abort, or clear the projection and forget the
// request serial, because `useViewerResource` wires all four off the one object.
// There is no per-call knob left to get wrong, and the omission was the bug.
//
// INVARIANT: the scope header goes out only for a signed-in viewer. `dispatchV1`
// reads the header's mere presence as "there is a user" and rejects an anonymous
// request carrying it, so sending it unconditionally would break every public
// read this gate also guards.

export type ViewerIdentity =
  | { kind: "user"; userId: string; scope: string }
  | { kind: "anonymous" };

const ANONYMOUS: ViewerIdentity = { kind: "anonymous" };

export type ViewerSession = {
  /** `null` until the server has answered once. */
  identity: ViewerIdentity | null;
  /** Set only while no viewer has ever been confirmed. */
  error: string | null;
  /** Bumped whenever admitted reads have to run again. */
  revalidation: number;
};

export type ViewerSessionStore = {
  read: () => ViewerSession;
  subscribe: (listener: () => void) => () => void;
  /** Re-reads the viewer. Resolves with the confirmed identity, or null if it could not be read. */
  revalidate: () => Promise<ViewerIdentity | null>;
  /**
   * Drops the confirmed viewer, so the next subscriber resolves it again.
   *
   * INVARIANT: called when the last gated surface unmounts. A remembered
   * identity outliving every surface that could act on it is not an
   * optimisation — nothing private is on screen to keep consistent, and the
   * next mount deserves a fresh answer rather than one this page started with.
   */
  forget: () => void;
};

const UNRESOLVED: ViewerSession = {
  identity: null,
  error: null,
  revalidation: 0,
};

function identityKey(identity: ViewerIdentity | null): string | null {
  if (identity === null) return null;
  return identity.kind === "user" ? identity.scope : "anonymous";
}

/**
 * The viewer session without React or the DOM, so the rules below can be
 * exercised with an injected resolver — the same split
 * `viewer-resource-client`/`useViewerResource` already uses.
 */
export function createViewerSession(
  resolve: () => Promise<ViewerAuthority>,
): ViewerSessionStore {
  let session = UNRESOLVED;
  let inFlight: Promise<ViewerIdentity | null> | null = null;
  const listeners = new Set<() => void>();

  function publish(next: ViewerSession) {
    session = next;
    for (const listener of [...listeners]) listener();
  }

  function accept(identity: ViewerIdentity): ViewerIdentity {
    // The object is reused when the owner is unchanged: subscribers key their
    // "drop the previous account's projection" effect off its identity, and a
    // fresh object every re-read would fire that effect on every focus.
    const settled =
      session.identity !== null &&
      identityKey(session.identity) === identityKey(identity)
        ? session.identity
        : identity;
    publish({
      identity: settled,
      error: null,
      revalidation: session.revalidation + 1,
    });
    return settled;
  }

  function reject(message: string) {
    // INVARIANT: a confirmed viewer survives a failed re-read. One unlucky
    // `/api/v1/me` must not sign the page out and discard what it is showing;
    // only a viewer that was never confirmed surfaces the failure.
    if (session.identity !== null) return;
    publish({
      identity: null,
      error: message,
      revalidation: session.revalidation + 1,
    });
  }

  function revalidate(): Promise<ViewerIdentity | null> {
    // One tab switch fires focus and visibilitychange together, and every gate
    // on the page asks at once; they share the one read in flight.
    inFlight ??= resolve()
      .then((authority) =>
        accept(
          authority.user
            ? {
                kind: "user",
                userId: authority.user.id,
                scope: `user:${authority.user.id}`,
              }
            : ANONYMOUS,
        ),
      )
      .catch((error: unknown) => {
        reject(
          requestErrorMessage(
            error,
            "Your account could not be checked. Reconnect and try again.",
          ),
        );
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    read: () => session,
    subscribe(listener) {
      listeners.add(listener);
      if (session.identity === null && session.error === null) {
        void revalidate();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    revalidate,
    forget() {
      session = UNRESOLVED;
      inFlight = null;
    },
  };
}

const sharedSession = createViewerSession(() => {
  // INVARIANT: the memoised answer is dropped first. Re-reading the cache would
  // make every re-validation report the identity this page started with.
  invalidateViewerAuthority();
  return resolveViewerAuthority();
});

let domSubscribers = 0;
const onFocus = () => void sharedSession.revalidate();
const onVisibilityChange = () => {
  if (document.visibilityState === "visible") void sharedSession.revalidate();
};

/**
 * INTENT: one focus listener for the whole page. Fifteen components kept their
 * own, each followed by a hand-written list of which private state an account
 * change should clear, and the lists disagreed.
 */
function subscribeSharedSession(listener: () => void): () => void {
  const unsubscribe = sharedSession.subscribe(listener);
  if (domSubscribers++ === 0) {
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    unsubscribe();
    if (--domSubscribers === 0) {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sharedSession.forget();
    }
  };
}

export type ViewerTicket = {
  generation: number;
  scope: string | null;
  controller: AbortController;
};

export type ViewerGate = {
  identity: ViewerIdentity | null;
  /** `user:<id>` while signed in, else null. */
  scope: string | null;
  /** Set only while no viewer has ever been confirmed. */
  error: string | null;
  /** Changes whenever gated reads must run again — put it in the refresh effect's deps. */
  revalidation: number;
  /** Hand to `useViewerResource`. */
  gate: ViewerRequestGate<ViewerTicket>;
  /**
   * SPEC: one request bound to the confirmed owner — scope header attached,
   * aborted when the owner moves, and the reply abandoned if it moved while the
   * request was in the air.
   *
   * INTENT: for the two shapes `useViewerResource` is not: writes, and a paged
   * append where the component owns the running list. Without it those keep
   * hand-writing `x-idream-viewer-scope` next to an owner id they resolved some
   * other way, which is the duplication the gate exists to end.
   */
  fetch: ResourceFetcher;
  /** Re-read the viewer now, for a write that must not act on a remembered identity. */
  revalidate: () => Promise<ViewerIdentity | null>;
};

export type ViewerGateOptions = {
  /**
   * `"user"` (default) refuses to issue a ticket for an anonymous viewer, so a
   * private read is never even attempted; `"any"` admits both and simply omits
   * the scope header when signed out, for a public read whose answer still
   * depends on who is asking.
   */
  require?: "user" | "any";
};

export function useViewerGate(options?: ViewerGateOptions): ViewerGate {
  const requireUser = options?.require !== "any";
  const session = useSyncExternalStore(
    subscribeSharedSession,
    sharedSession.read,
    () => UNRESOLVED,
  );

  // INVARIANT: synced after commit, never during render. The gate object has to
  // keep one identity across re-renders — it feeds effect dependency arrays, and
  // a fresh one each render would turn one refresh into a request loop — so the
  // live values reach it through refs, the same trade `useViewerResource` makes
  // for its options. A ticket issued before this effect runs still carries the
  // generation it was issued under, so the owner check below invalidates it.
  const requireUserRef = useRef(requireUser);
  const identityRef = useRef<ViewerIdentity | null>(session.identity);
  useEffect(() => {
    requireUserRef.current = requireUser;
    identityRef.current = session.identity;
  });

  const generationRef = useRef(0);
  const liveRef = useRef(new Set<ViewerTicket>());
  const resetsRef = useRef(new Set<() => void>());
  const seenRef = useRef<ViewerIdentity | null>(session.identity);

  // INVARIANT: built once and kept. Both objects feed effect dependency arrays
  // in every caller, so a new one per render would re-fire those effects and
  // turn one refresh into a request loop. A lazy `useState` initialiser is how
  // that survives without reading a ref during render.
  const [gate] = useState<ViewerRequestGate<ViewerTicket>>(() => ({
    begin: () => {
      const identity = identityRef.current;
      // INVARIANT: no ticket before the server has named the viewer. The
      // alternative — read now, check later — is the shape every open-coded
      // copy had, and it is what let one account's answer paint another's page.
      if (identity === null) return null;
      if (requireUserRef.current && identity.kind !== "user") return null;
      const ticket: ViewerTicket = {
        generation: generationRef.current,
        scope: identity.kind === "user" ? identity.scope : null,
        controller: new AbortController(),
      };
      liveRef.current.add(ticket);
      return ticket;
    },
    isCurrent: (ticket) => ticket.generation === generationRef.current,
    finish: (ticket) => {
      liveRef.current.delete(ticket);
    },
    signal: (ticket) => ticket.controller.signal,
    headers: (ticket) =>
      ticket.scope ? { "x-idream-viewer-scope": ticket.scope } : undefined,
    onOwnerChange: (reset) => {
      resetsRef.current.add(reset);
      return () => {
        resetsRef.current.delete(reset);
      };
    },
  }));

  const [gatedFetch] = useState<ResourceFetcher>(() => async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const ticket = gate.begin();
    if (ticket === null) throw new ViewerGateError();
    try {
      const headers = new Headers(init?.headers);
      if (ticket.scope) headers.set("x-idream-viewer-scope", ticket.scope);
      const response = await fetch(input, {
        ...init,
        headers,
        signal: init?.signal ?? ticket.controller.signal,
      });
      // INVARIANT: checked again after the await. The cookie can change while a
      // write is in the air, and the reply must not be shown to whoever is
      // signed in by the time it lands.
      if (!gate.isCurrent(ticket)) throw new ViewerGateError();
      return response;
    } finally {
      gate.finish(ticket);
    }
  });

  useEffect(() => {
    const previous = seenRef.current;
    seenRef.current = session.identity;
    // The first answer is not a change: nothing private has been read yet.
    if (previous === null || previous === session.identity) return;
    // INVARIANT: in this order. Bumping the generation first makes every reply
    // still in the air `discarded`, so a reset cannot be overwritten by an
    // answer the previous account asked for.
    generationRef.current += 1;
    for (const ticket of liveRef.current) ticket.controller.abort();
    liveRef.current.clear();
    for (const reset of resetsRef.current) reset();
  }, [session.identity]);

  // INVARIANT: unmounting aborts what this surface still has in the air. The set
  // is read inside the cleanup, not during render, so nothing here depends on
  // when React chose to re-render.
  useEffect(
    () => () => {
      const live = liveRef.current;
      for (const ticket of live) ticket.controller.abort();
      live.clear();
    },
    [],
  );

  return {
    identity: session.identity,
    scope: session.identity?.kind === "user" ? session.identity.scope : null,
    error: session.error,
    revalidation: session.revalidation,
    gate,
    fetch: gatedFetch,
    revalidate: sharedSession.revalidate,
  };
}
