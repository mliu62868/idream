import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  characterWorkspaceTabFromSearch,
  type CharacterWorkspaceTab,
} from "@/features/image-workflow-transport";
import { setWorkspaceUrl } from "@/lib/admin-v2-api";
import type { createCharacterCommandJournal } from "./character-command-journal";
import { characterPortfolioQuery, parseCharacterPortfolioUrl } from "./portfolio-query";

type Tab = CharacterWorkspaceTab;
type WorkspaceUrlOptions = Parameters<typeof setWorkspaceUrl>[1];

function setCharacterWorkspaceTabUrl(tab: Tab, options: WorkspaceUrlOptions) {
  const roster = new URLSearchParams(window.location.search).get("roster");
  const params = new URLSearchParams({ tab });
  if (roster !== null) params.set("roster", roster);
  setWorkspaceUrl(params, options);
}

// SPEC: 角色工作区的 tab 与地址栏同步：首帧水合、push / replace 导航、popstate / hashchange、
// 同页 ?tab= 链接拦截，以及深链 hash 的滚动聚焦。
// INVARIANT: 写入锁仍归 journal（事件发生时读 journal 快照，journal 由调用方传入），
//            这里只在锁住时拒绝切页，不持有任何锁状态。
export function useCharacterWorkspaceTabRoute({
  id,
  data,
  journal,
}: {
  id: string;
  data: CharacterWorkspaceDetail | null;
  journal: Pick<ReturnType<typeof createCharacterCommandJournal>, "getSnapshot" | "hasPersistedCommand">;
}) {
  // INVARIANT: 初值不许读地址栏或 journal 快照 —— 服务端得出 "project"、客户端首帧
  // 得出 URL 里的 tab，两边分叉就是 hydration mismatch。真实 tab 在挂载 effect 里对齐。
  const [tab, setTab] = useState<Tab>("project");
  const [locationHash, setLocationHash] = useState("");
  const navigateToWorkspaceTab = useCallback((next: Tab, options: WorkspaceUrlOptions) => {
    setTab(next);
    setLocationHash(options?.hash ?? "");
    setCharacterWorkspaceTabUrl(next, options);
  }, []);
  const [returnQuery, setReturnQuery] = useState<string | null>(null);
  const tabRef = useRef(tab);
  const activeCommand = data?.activeCommand;

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    // 水合完成后把 tab 对齐到外部状态（地址栏 + 持久化命令）：初值必须与服务端一致，
    // 真实 tab 只能在这里读。一次性对齐，之后由用户操作与 popstate 驱动。
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydration from the address bar */
    setTab(
      journal.hasPersistedCommand()
        ? "release"
        : characterWorkspaceTabFromSearch(window.location.search),
    );
    setLocationHash(window.location.hash);
    const roster = new URLSearchParams(window.location.search).get("roster");
    if (roster !== null) setReturnQuery(characterPortfolioQuery(parseCharacterPortfolioUrl(roster)));
    /* eslint-enable react-hooks/set-state-in-effect */
    // 只在挂载时跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const targetId = locationHash.replace(/^#/, "");
    const isVisualTarget = tab === "visual" && [
        "visual-production-readiness",
        "visual-identity-version",
        "visual-reference-set",
        "route-qualification-workbench",
      ].includes(targetId);
    const isImagePlacement = tab === "assets" && /^character-image-placement-character_(cover|hero|chat)$/.test(targetId);
    if (!isVisualTarget && !isImagePlacement) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ block: "start" });
      const focusTarget = target?.hasAttribute("tabindex")
        ? target
        : target?.querySelector<HTMLElement>(isVisualTarget ? "summary" : "button:not([disabled])");
      focusTarget?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tab, locationHash, data?.visual.imageReadiness?.state, data?.visual.readiness.ready]);
  useEffect(() => {
    const restoreTab = () => {
      if (journal.getSnapshot().writesLocked || activeCommand) {
        navigateToWorkspaceTab(tabRef.current, { mode: "replace" });
        return;
      }
      setTab(characterWorkspaceTabFromSearch(window.location.search));
      setLocationHash(window.location.hash);
    };
    const syncHash = () => setLocationHash(window.location.hash);
    window.addEventListener("popstate", restoreTab);
    window.addEventListener("hashchange", syncHash);
    return () => {
      window.removeEventListener("popstate", restoreTab);
      window.removeEventListener("hashchange", syncHash);
    };
  }, [activeCommand, id, journal, navigateToWorkspaceTab]);

  const selectTab = (next: Tab, targetHash?: string) => {
    if ((journal.getSnapshot().writesLocked || activeCommand) && next !== tab) return;
    navigateToWorkspaceTab(next, { ...(targetHash ? { hash: targetHash } : {}), mode: "push" });
  };
  const onWorkspaceLinkClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target;
    const anchor =
      target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || anchor.target === "_blank" || anchor.getAttribute("href")?.startsWith("#")) return;
    const destination = new URL(anchor.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      destination.pathname !== window.location.pathname ||
      !destination.searchParams.has("tab")
    ) {
      return;
    }
    const next = characterWorkspaceTabFromSearch(destination.search);
    event.preventDefault();
    if ((journal.getSnapshot().writesLocked || activeCommand) && next !== tab) {
      return;
    }
    navigateToWorkspaceTab(next, { hash: destination.hash, mode: "push" });
  };

  return {
    tab,
    locationHash,
    returnQuery,
    navigateToWorkspaceTab,
    selectTab,
    onWorkspaceLinkClick,
  };
}
