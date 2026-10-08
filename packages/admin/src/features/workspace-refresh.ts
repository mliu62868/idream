import { useEffect } from "react";

export const ADMIN_WORKSPACE_REFRESH_EVENT = "idream:admin-workspace-refresh";

// Refresh data in place; the owner keeps its drafts, URL, and request gates.
// Call with no event argument: optional loader flags must retain their defaults.
export function useWorkspaceRefresh(refresh: () => void | Promise<unknown>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onRefresh = () => { void refresh(); };
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onRefresh);
  }, [enabled, refresh]);
}
