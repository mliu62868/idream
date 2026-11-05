"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CharacterCommandJournal } from "./character-command-journal";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

type CharacterWorkspaceActions = {
  readonly journal: CharacterCommandJournal;
  readonly permissions: CharacterWorkspacePermissions;
  readonly writesLocked: boolean;
  readonly runCommittedMutation: RunCommittedCharacterMutation;
};

const CharacterWorkspaceActionsContext = createContext<CharacterWorkspaceActions | null>(null);

/**
 * SPEC: 让挂在各面板里的一行小组件拿到写入通道，面板本身不必多传 props。
 * INVARIANT: 没有 Provider 时返回 null，组件自己不渲染，面板可以脱离工作区单独使用。
 */
export function CharacterWorkspaceActionsProvider({
  children,
  journal,
  permissions,
  runCommittedMutation,
  writesLocked,
}: CharacterWorkspaceActions & { readonly children: ReactNode }) {
  const value = useMemo(
    () => ({ journal, permissions, runCommittedMutation, writesLocked }),
    [journal, permissions, runCommittedMutation, writesLocked],
  );
  return (
    <CharacterWorkspaceActionsContext.Provider value={value}>
      {children}
    </CharacterWorkspaceActionsContext.Provider>
  );
}

export function useCharacterWorkspaceActions() {
  return useContext(CharacterWorkspaceActionsContext);
}
