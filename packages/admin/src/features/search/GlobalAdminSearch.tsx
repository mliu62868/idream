"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { adminV2Request } from "@/lib/admin-v2-api";

type SearchResult = {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  status: string;
  updatedAt: string;
};

export function GlobalAdminSearch() {
  const listboxId = useId();
  const requestId = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (query.trim().length < 2) return;
    const currentRequest = ++requestId.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void adminV2Request<{ items: SearchResult[] }>(`/api/v2/admin/search?q=${encodeURIComponent(query.trim())}&limit=8`)
        .then((response) => {
          if (requestId.current !== currentRequest) return;
          setItems(response.items);
          setOpen(true);
          setActiveIndex(response.items.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (requestId.current === currentRequest) {
            setItems([]);
            setOpen(true);
            setActiveIndex(-1);
          }
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 lg:w-[320px]">
        {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ad-text-muted)]" /> : <Search className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />}
        <input
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-label="Global admin search"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ad-text-muted)]"
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            if (next.trim().length < 2) {
              requestId.current += 1;
              setItems([]);
              setOpen(false);
              setLoading(false);
              setActiveIndex(-1);
            }
          }}
          onFocus={() => { if (query.trim().length >= 2) setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setOpen(false); return; }
            if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((current) => items.length ? (current + 1) % items.length : -1); }
            if (event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActiveIndex((current) => items.length ? (current <= 0 ? items.length - 1 : current - 1) : -1); }
            if (event.key === "Enter" && activeIndex >= 0 && items[activeIndex]) { event.preventDefault(); window.location.assign(items[activeIndex].href); }
          }}
          placeholder="Search customers, characters, Cases, Incidents…"
          role="combobox"
          value={query}
        />
      </div>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[min(92vw,520px)] overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-xl">
          <ul aria-label="Global search results" className="max-h-[min(60vh,440px)] overflow-y-auto p-1" id={listboxId} role="listbox">
            {items.map((item, index) => (
              <li aria-selected={activeIndex === index} id={`${listboxId}-${index}`} key={`${item.kind}:${item.id}`} role="option">
                <Link className={`grid gap-1 rounded-md px-3 py-2.5 ${activeIndex === index ? "bg-black/[0.06]" : "hover:bg-black/[0.04]"}`} href={item.href} onMouseEnter={() => setActiveIndex(index)}>
                  <span className="flex items-center justify-between gap-3"><strong className="truncate text-sm">{item.title}</strong><span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] uppercase text-[var(--ad-text-muted)]">{item.kind.replaceAll("_", " ")}</span></span>
                  <span className="truncate text-xs text-[var(--ad-text-muted)]">{item.subtitle} · {item.status}</span>
                </Link>
              </li>
            ))}
            {!loading && items.length === 0 ? <li className="px-3 py-5 text-center text-sm text-[var(--ad-text-muted)]">No permitted records match this search.</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
