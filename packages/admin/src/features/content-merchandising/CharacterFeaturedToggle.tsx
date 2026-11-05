"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  FEATURED_MAX_CHARACTERS,
  featuredSaveBody,
  featuredVersionConflictFromError,
} from "./featured-save";
import type { FeaturedItem } from "./ContentMerchandisingWorkspace";

type FeaturedAuthority = {
  readonly items: readonly FeaturedItem[];
  readonly configuredCharacterIds: readonly string[];
  readonly settingVersion: number;
};

type FeaturedStore = {
  readonly authority: FeaturedAuthority | null;
  readonly loadError: string | null;
  readonly reload: () => Promise<void>;
};

const FEATURED_PATH = "/api/v2/admin/content/featured";

function useFeaturedStore(enabled: boolean): FeaturedStore {
  const [authority, setAuthority] = useState<FeaturedAuthority | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setAuthority(await apiGet<FeaturedAuthority>(FEATURED_PATH));
    setLoadError(null);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    apiGet<FeaturedAuthority>(FEATURED_PATH).then(
      (next) => { if (current) setAuthority(next); },
      (cause: unknown) => {
        if (current) setLoadError(cause instanceof Error ? cause.message : "Featured content could not be loaded");
      },
    );
    return () => { current = false; };
  }, [enabled]);
  return useMemo(() => ({ authority, loadError, reload }), [authority, loadError, reload]);
}

const FeaturedStoreContext = createContext<FeaturedStore | null>(null);

// SPEC: 一屏多行开关时共用一次读取。没有它，25 行表格就是 25 个相同请求，
// 而且一行保存后其他行的位置和版本都是旧的。
export function FeaturedAuthorityProvider({ children }: { readonly children: ReactNode }) {
  const store = useFeaturedStore(true);
  return <FeaturedStoreContext.Provider value={store}>{children}</FeaturedStoreContext.Provider>;
}

/**
 * SPEC: 单个角色的「加入 / 移出精选」，带当前位置和实际上线状态。可挂到角色工作区和表现页。
 * INVARIANT: 只改这一个角色的成员关系，其余顺序原样保留；版本冲突时重新读取，不盲写。
 */
export function CharacterFeaturedToggle({
  canWrite,
  characterId,
  compact = false,
}: {
  readonly canWrite: boolean;
  readonly characterId: string;
  /** Table rows: position and button only; a failed shared read stays silent per row. */
  readonly compact?: boolean;
}) {
  const { t } = useAdminI18n();
  const shared = useContext(FeaturedStoreContext);
  const own = useFeaturedStore(shared === null);
  const { authority, loadError, reload } = shared ?? own;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!authority) {
    if (compact) return null;
    return loadError
      ? <p className="text-xs text-[var(--ad-red-text)]" role="alert">{t(loadError)}</p>
      : <p className="text-xs text-[var(--ad-text-muted)]" role="status">{t("Loading featured content…")}</p>;
  }

  const ids = authority.configuredCharacterIds;
  const position = ids.indexOf(characterId);
  const featured = position >= 0;
  const item = authority.items.find(({ id }) => id === characterId);
  const full = !featured && ids.length >= FEATURED_MAX_CHARACTERS;

  async function toggle() {
    if (!authority || busy) return;
    const next = featured ? ids.filter((id) => id !== characterId) : [...ids, characterId];
    setBusy(true);
    setNotice(null);
    try {
      await apiWrite(FEATURED_PATH, "PUT", featuredSaveBody(ids, next, authority.settingVersion));
      await reload();
    } catch (cause) {
      if (featuredVersionConflictFromError(cause)) {
        await reload();
        setNotice("Featured changed elsewhere. The latest list is loaded; click again to apply.");
      } else {
        setNotice(cause instanceof Error ? cause.message : "Featured could not be saved");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-wrap items-center ${compact ? "gap-2 text-xs" : "gap-3 text-sm"}`} data-testid="character-featured-toggle">
      {!compact || featured ? (
        <span>
          {featured
            ? t("Featured · position {position}", { position: position + 1 })
            : t("Not featured")}
        </span>
      ) : null}
      {!compact && item ? (
        <span className={`text-xs font-semibold ${item.effective ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]"}`}>
          {t(item.effective ? "Live featured" : "Configured · not live")}
        </span>
      ) : null}
      {!compact && item && !item.effective && item.blockers[0] ? (
        <Link className="text-xs underline" href={item.blockers[0].repairDeepLink} title={t(item.blockers[0].message)}>
          {t("Resolve blocker")}
        </Link>
      ) : null}
      {!compact || canWrite ? (
        <button
          className="min-h-9 rounded border border-[var(--ad-border)] px-3 text-xs font-semibold disabled:opacity-50"
          disabled={!canWrite || busy || full}
          onClick={() => void toggle()}
          type="button"
        >
          {t(featured ? "Remove from Featured" : "Add to Featured")}
        </button>
      ) : null}
      {full ? <span className="text-xs text-[var(--ad-text-muted)]">{t("Featured is full ({max})", { max: FEATURED_MAX_CHARACTERS })}</span> : null}
      {notice ? <p className="w-full text-xs text-[var(--ad-yellow-text)]" role="alert">{t(notice)}</p> : null}
    </div>
  );
}
