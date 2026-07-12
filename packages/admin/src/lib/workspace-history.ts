import type { WorkspaceHistoryMode } from "./admin-v2-api";

export type WorkspaceHistoryWriter<T> = (state: T, mode: WorkspaceHistoryMode) => void;

export type WorkspaceHistoryController<T> = {
  current(): T;
  draft(next: T, write: WorkspaceHistoryWriter<T>): void;
  navigate(next: T, write: WorkspaceHistoryWriter<T>): void;
  replace(next: T, write: WorkspaceHistoryWriter<T>): void;
  restore(next: T): void;
};

export function createWorkspaceHistoryController<T>(initial: T): WorkspaceHistoryController<T> {
  let committed = initial;
  let drafting = false;
  return {
    current: () => committed,
    draft(next, write) {
      if (!drafting) {
        write(committed, "push");
        drafting = true;
      }
      write(next, "replace");
    },
    navigate(next, write) {
      write(next, drafting ? "replace" : "push");
      committed = next;
      drafting = false;
    },
    replace(next, write) {
      write(next, "replace");
      committed = next;
      drafting = false;
    },
    restore(next) {
      committed = next;
      drafting = false;
    },
  };
}

export function observeWorkspacePopState<T>(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  read: () => T,
  restore: (state: T) => void,
) {
  const onPopState = () => restore(read());
  target.addEventListener("popstate", onPopState);
  return () => target.removeEventListener("popstate", onPopState);
}

export function workspaceDetailId(pathname: string, listPath: string) {
  const prefix = `${listPath}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
