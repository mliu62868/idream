"use client";

import { useLayoutEffect, useMemo, useRef } from "react";

// SPEC: Returns an object with the same callable keys as `handlers` whose
//       identity never changes; each call forwards to the latest render's
//       implementation. Memoized children can then skip renders that only
//       recreated closures.
// INVARIANT: the key set is fixed by the first render.
export function useStableHandlers<T extends { readonly [key: string]: (...args: never[]) => unknown }>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => { latest.current = handlers; });
  return useMemo(() => {
    const stable = {} as Record<string, (...args: never[]) => unknown>;
    for (const key of Object.keys(handlers)) {
      stable[key] = (...args: never[]) => (latest.current[key] as (...args: never[]) => unknown)(...args);
    }
    return stable as T;
    // The key set is fixed; calls always read the latest implementation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
