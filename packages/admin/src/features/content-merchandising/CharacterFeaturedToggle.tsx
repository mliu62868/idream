"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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

const FEATURED_PATH = "/api/v2/admin/content/featured";

/**
 * SPEC: 单个角色的「加入 / 移出精选」，带当前位置和实际上线状态。可挂到角色工作区和表现页。
 * INVARIANT: 只改这一个角色的成员关系，其余顺序原样保留；版本冲突时重新读取，不盲写。
 */
export function CharacterFeaturedToggle({
  canWrite,
  characterId,
}: {
  readonly canWrite: boolean;
  readonly characterId: string;
}) {
  const { t } = useAdminI18n();
  const [authority, setAuthority] = useState<FeaturedAuthority | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => apiGet<FeaturedAuthority>(FEATURED_PATH), []);

  useEffect(() => {
    let current = true;
    load().then(
      (next) => { if (current) setAuthority(next); },
      (cause: unknown) => {
        if (current) setNotice(cause instanceof Error ? cause.message : "Featured content could not be loaded");
      },
    );
    return () => { current = false; };
  }, [load]);

  if (!authority) {
    return notice
      ? <p className="text-xs text-[var(--ad-red-text)]" role="alert">{t(notice)}</p>
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
      setAuthority(await load());
    } catch (cause) {
      if (featuredVersionConflictFromError(cause)) {
        setAuthority(await load());
        setNotice("Featured changed elsewhere. The latest list is loaded; click again to apply.");
      } else {
        setNotice(cause instanceof Error ? cause.message : "Featured could not be saved");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="character-featured-toggle">
      <span>
        {featured
          ? t("Featured · position {position}", { position: position + 1 })
          : t("Not featured")}
      </span>
      {item ? (
        <span className={`text-xs font-semibold ${item.effective ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]"}`}>
          {t(item.effective ? "Live featured" : "Configured · not live")}
        </span>
      ) : null}
      {item && !item.effective && item.blockers[0] ? (
        <Link className="text-xs underline" href={item.blockers[0].repairDeepLink} title={t(item.blockers[0].message)}>
          {t("Resolve blocker")}
        </Link>
      ) : null}
      <button
        className="min-h-9 rounded border border-[var(--ad-border)] px-3 text-xs font-semibold disabled:opacity-50"
        disabled={!canWrite || busy || full}
        onClick={() => void toggle()}
        type="button"
      >
        {t(featured ? "Remove from Featured" : "Add to Featured")}
      </button>
      {full ? <span className="text-xs text-[var(--ad-text-muted)]">{t("Featured is full ({max})", { max: FEATURED_MAX_CHARACTERS })}</span> : null}
      {notice ? <p className="w-full text-xs text-[var(--ad-yellow-text)]" role="alert">{t(notice)}</p> : null}
    </div>
  );
}
