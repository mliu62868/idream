import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { adminBootstrapResponseSchema } from "@idream/shared/admin";
import { adminPermissionKeySchema, type AdminPermissionKey } from "@idream/shared/admin/permissions";
import {
  ADMIN_AUTHORITY_REJECTED_EVENT,
  AdminV2RequestError,
  adminV2Request,
  type AdminAuthorityRejection,
} from "@/lib/admin-v2-api";
import { createLatestRequestGate } from "@/lib/latest-request";

type Authority = {
  actor: { id: string; role: string } | null;
  permissions: AdminPermissionKey[];
  canCreateCharacters: boolean;
};
type State = Authority & {
  error: unknown;
  dataRefreshVersion: number;
  // SPEC: 权威暂时读不到时最后一次成功读到的权限，只用来冻结（inert）当前工作台，不授予任何写能力。
  // INTENT: 外壳刷新碰上一次 5xx 就卸载工作台，运营写到一半的复盘、理由全部丢失，而且离开保护
  //         根本不会触发。权限收回不等于要销毁本地草稿。会话失效时这里是 null，页面照旧收起。
  retainedPermissions: AdminPermissionKey[] | null;
};

// bootstrap 刚说「你还有这个权限」之后，同样的拒绝在这段时间内不再收权限——再收一次也只会被还回来。
const CONTRADICTED_REJECTION_TTL_MS = 30_000;

function rejectionKey(rejection: AdminAuthorityRejection) {
  return `${rejection.status}:${rejection.unverified ? "unverified" : String(rejection.permission)}`;
}

// 只有明确的服务端故障或断网才算暂时。401/403、换账号都要真的收起页面。
function isTransientAuthorityFailure(error: unknown) {
  if (error instanceof AdminV2RequestError) return error.status >= 500;
  return error instanceof TypeError;
}

export function useAdminAuthority(initial: Authority) {
  const sourceKey = JSON.stringify(initial);
  const [source, setSource] = useState(sourceKey);
  const [state, setState] = useState<State>(() => ({ ...initial, error: null, dataRefreshVersion: 0, retainedPermissions: null }));
  const gate = useRef(createLatestRequestGate());
  const controller = useRef<AbortController | null>(null);
  const contradictedRejections = useRef(new Map<string, number>());
  if (source !== sourceKey) {
    setSource(sourceKey);
    setState({ ...initial, error: null, dataRefreshVersion: 0, retainedPermissions: null });
  }

  const actorId = initial.actor?.id;
  const refresh = useCallback(async (refreshData = true, rejection?: AdminAuthorityRejection) => {
    // INVARIANT: 这是防 卸载/重新挂载 死循环的总闸。按资源拒绝已经在请求层过滤，这里兜住其它形态
    //            （上游 WAF 的非 JSON 403、某个端点自己的 401）：bootstrap 认为权限还在，工作台就
    //            留着显示自己的错误，不再为同一次拒绝重新卸载。
    if (rejection) {
      const contradictedAt = contradictedRejections.current.get(rejectionKey(rejection));
      if (contradictedAt !== undefined && Date.now() - contradictedAt < CONTRADICTED_REJECTION_TTL_MS) return;
    }
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
      if (rejection) {
        const denied = adminPermissionKeySchema.safeParse(rejection.permission);
        const stillGranted = denied.success
          ? bootstrap.permissions.includes(denied.data)
          : bootstrap.permissions.length > 0;
        if (stillGranted) contradictedRejections.current.set(rejectionKey(rejection), Date.now());
      }
      setState(current => ({
        actor: bootstrap.actor, permissions: bootstrap.permissions, canCreateCharacters: bootstrap.canCreateCharacters,
        error: null, dataRefreshVersion: current.dataRefreshVersion + (refreshData ? 1 : 0), retainedPermissions: null,
      }));
    } catch (error) {
      if (!request.isCurrent()) return;
      // A failed authority read cannot keep the last successful write capabilities alive.
      setState(current => ({
        ...current,
        permissions: [],
        canCreateCharacters: false,
        error,
        retainedPermissions: isTransientAuthorityFailure(error)
          ? current.retainedPermissions ?? current.permissions
          : null,
      }));
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
