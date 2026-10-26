import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { adminBootstrapResponseSchema } from "@idream/shared/admin";
import { adminPermissionKeySchema, type AdminPermissionKey } from "@idream/shared/admin/permissions";
import {
  ADMIN_AUTHORITY_REJECTED_EVENT,
  adminV2Request,
  type AdminAuthorityRejection,
} from "@/lib/admin-v2-api";
import { createLatestRequestGate } from "@/lib/latest-request";

type Authority = {
  actor: { id: string; role: string } | null;
  permissions: AdminPermissionKey[];
  canCreateCharacters: boolean;
};
type State = Authority & { error: unknown; dataRefreshVersion: number };

export function useAdminAuthority(initial: Authority) {
  const sourceKey = JSON.stringify(initial);
  const [source, setSource] = useState(sourceKey);
  const [state, setState] = useState<State>(() => ({ ...initial, error: null, dataRefreshVersion: 0 }));
  const gate = useRef(createLatestRequestGate());
  const controller = useRef<AbortController | null>(null);
  if (source !== sourceKey) {
    setSource(sourceKey);
    setState({ ...initial, error: null, dataRefreshVersion: 0 });
  }

  const actorId = initial.actor?.id;
  const refresh = useCallback(async (refreshData = true, rejection?: AdminAuthorityRejection) => {
    const request = gate.current.begin();
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    if (rejection) {
      const denied = adminPermissionKeySchema.safeParse(rejection.permission);
      if (rejection.status === 401 || rejection.unverified) {
        flushSync(() => setState(current => ({ ...current, permissions: [], canCreateCharacters: false })));
      } else if (denied.success) {
        // Retire the denied intent immediately while preserving unrelated read access.
        // Commit before awaiting bootstrap: React batching must not merge revoke/regrant
        // into unchanged props and leave the rejected confirmation alive.
        flushSync(() => setState(current => ({ ...current, permissions: current.permissions.filter(key => key !== denied.data), canCreateCharacters: false })));
      }
    }
    try {
      const { bootstrap } = await adminV2Request("/api/v2/admin/bootstrap", {
        schema: adminBootstrapResponseSchema, signal: pending.signal,
      });
      if (!request.isCurrent()) return;
      // Never transplant another signed-in actor's capabilities into retained drafts.
      if (!bootstrap.actor || bootstrap.actor.id !== actorId) throw new Error("Admin session changed; reload to sign in again.");
      setState(current => ({
        actor: bootstrap.actor, permissions: bootstrap.permissions, canCreateCharacters: bootstrap.canCreateCharacters,
        error: null, dataRefreshVersion: current.dataRefreshVersion + (refreshData ? 1 : 0),
      }));
    } catch (error) {
      if (!request.isCurrent()) return;
      // A failed authority read cannot keep the last successful write capabilities alive.
      setState(current => ({ ...current, permissions: [], canCreateCharacters: false, error }));
    }
  }, [actorId]);

  useEffect(() => {
    const requests = gate.current;
    const onRejected = (event: Event) => { void refresh(false, (event as CustomEvent<AdminAuthorityRejection>).detail); };
    window.addEventListener(ADMIN_AUTHORITY_REJECTED_EVENT, onRejected);
    return () => {
      window.removeEventListener(ADMIN_AUTHORITY_REJECTED_EVENT, onRejected);
      requests.invalidate();
      controller.current?.abort();
    };
  }, [refresh, sourceKey]);

  return { ...state, refresh };
}
