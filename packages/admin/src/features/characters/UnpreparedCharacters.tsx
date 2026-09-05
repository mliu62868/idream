"use client";

import Link from "next/link";
import { useState } from "react";
import { contentCharacterListResponseSchema, type ContentCharacterListItem } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { adminV2Request } from "@/lib/admin-v2-api";
import { fieldClass, WorkspaceButton } from "@/features/operations/WorkspaceUi";

// Historical shared submissions predate Project authority. Keep them discoverable
// from the character workspace until automatic publication preparation succeeds.
export function UnpreparedCharacters() {
  const { t, value } = useAdminI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [items, setItems] = useState<readonly ContentCharacterListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function load(query: string, nextCursor?: string) {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: "pending_review", sort: "recent", limit: "25" });
      if (query.trim()) params.set("search", query.trim());
      if (nextCursor) params.set("cursor", nextCursor);
      const result = contentCharacterListResponseSchema.parse(await adminV2Request(`/api/v2/admin/content/characters?${params}`));
      setItems((current) => nextCursor ? [...current, ...result.items] : result.items);
      setCursor(result.pageInfo.hasNextPage ? result.pageInfo.endCursor : null);
      setAppliedSearch(query);
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }

  return <section className="mt-5 border-b border-[var(--ad-border)] pb-5">
    <button disabled={busy} aria-expanded={open} className="min-h-11 text-sm font-semibold underline underline-offset-4" onClick={() => { setOpen(!open); if (!open) void load(search); }} type="button">{t("Shared characters awaiting preparation")}</button>
    {open ? <div className="mt-3 space-y-4">
      <p className="text-sm text-[var(--ad-text-muted)]">{t("Earlier shared characters can continue here. Open a character to run automatic checks and prepare its publishing workspace.")}</p>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (!busy) void load(search); }}>
        <input aria-label={t("Search characters awaiting preparation")} className={`${fieldClass} min-w-0 flex-1`} value={search} onChange={(event) => setSearch(event.target.value)} />
        <WorkspaceButton disabled={busy} type="submit">{t("Search")}</WorkspaceButton>
      </form>
      {error ? <AuthorityRequestError cause={error} message={error instanceof Error ? error.message : t("Request failed")} onRetry={() => void load(appliedSearch)} /> : null}
      {!busy && !error && items.length === 0 ? <p className="text-sm text-[var(--ad-text-muted)]">{t("No characters are awaiting preparation.")}</p> : null}
      <ul className="divide-y divide-[var(--ad-border)]">
        {items.map((character) => <li className="flex items-center gap-3 py-3" key={character.id}>
          {/* eslint-disable-next-line @next/next/no-img-element -- operator source URLs are served by the authenticated Main proxy */}
          {character.imageAsset ? <img alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" src={character.imageAsset.thumbnailUrl ?? character.imageAsset.url} /> : null}
          <div className="min-w-0 flex-1"><p className="break-words font-semibold">{character.name}</p><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{value(character.gender)} · {value(character.style)} · {value(character.visibility)}</p></div>
          <Link className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold underline underline-offset-4" href={`/admin/characters/${encodeURIComponent(character.id)}`}>{t("Prepare publication workspace")}</Link>
        </li>)}
      </ul>
      {busy ? <p aria-live="polite" className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p> : null}
      {cursor ? <WorkspaceButton disabled={busy} onClick={() => void load(appliedSearch, cursor)}>{t("Load more characters")}</WorkspaceButton> : null}
    </div> : null}
  </section>;
}
