"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type HistoryMode = "push" | "replace";

export type UrlFilterOptions<Q> = {
  /** Server-render value. The address bar is only read after mount, so SSR and hydration agree. */
  initial: Q;
  parse: (params: URLSearchParams) => Q;
  toUrl: (query: Q, location: { pathname: string; search: string }) => string;
  /** Runs on mount, on apply, and on browser back/forward. `params` carries adjacent URL state. */
  load: (query: Q, params: URLSearchParams) => void;
};

// SPEC: 列表筛选状态与地址栏同步 —— 筛选结果可分享，浏览器后退可用。
// INTENT: jobs 自己写了一份（parse / writeUrl / popstate / 自定义刷新事件），audit 又写了一份
//         略有出入的（另一套 key 前缀、没有归一化 replace）。同一件事两份实现，收成一个 hook。
// INVARIANT: query 永远等于地址栏里的已生效条件；draft 是编辑中的副本，apply 才把两者对齐。
export function useUrlFilters<Q>({ initial, parse, toUrl, load }: UrlFilterOptions<Q>) {
  const [query, setQuery] = useState<Q>(initial);
  const [draft, setDraftState] = useState<Q>(initial);

  // 回调每次渲染都会换引用；放进 ref 才不会把「挂载时读一次地址栏」变成每次渲染重读。
  // 这个同步 effect 必须声明在下面的挂载 effect 之前——同一次提交里 effect 按声明顺序执行。
  const options = useRef({ initial, parse, toUrl, load });
  const draftRef = useRef(draft);
  const queryRef = useRef(query);
  useEffect(() => {
    options.current = { initial, parse, toUrl, load };
    draftRef.current = draft;
    queryRef.current = query;
  });

  const apply = useCallback((next: Q = draftRef.current, mode: HistoryMode = "push") => {
    setQuery(next);
    setDraftState(next);
    const href = options.current.toUrl(next, {
      pathname: window.location.pathname,
      search: window.location.search,
    });
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", href);
    options.current.load(next, new URLSearchParams(href.split("?")[1] ?? ""));
  }, []);

  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const restored = options.current.parse(params);
      setQuery(restored);
      setDraftState(restored);
      options.current.load(restored, params);
    };
    // 挂载时用 replace 归一化地址栏：陈旧或半截的查询串换成这一页真正在用的那一套。
    apply(options.current.parse(new URLSearchParams(window.location.search)), "replace");
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [apply]);

  return {
    query,
    draft,
    setDraft: useCallback((patch: Partial<Q>) => setDraftState((current) => ({ ...current, ...patch })), []),
    apply,
    reload: useCallback(() => {
      options.current.load(queryRef.current, new URLSearchParams(window.location.search));
    }, []),
    urlFor: useCallback((next: Q) => options.current.toUrl(next, {
      pathname: window.location.pathname,
      search: window.location.search,
    }), []),
    /** Escape hatch for URL state that sits next to the filters (an opened row, a tab). */
    pushUrl: useCallback((href: string, mode: HistoryMode = "push") => {
      window.history[mode === "push" ? "pushState" : "replaceState"](null, "", href);
    }, []),
  };
}
