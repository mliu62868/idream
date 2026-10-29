"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CharacterMediaLibraryEntry,
  CharacterMediaLibraryListResponse,
  CharacterMediaLibrarySearchResponse,
} from "@idream/shared/admin";
import { Loader2, MessageCircle, Search, WandSparkles, X } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { createLatestRequestGate } from "@/lib/latest-request";

export type CharacterChatLibrarySource = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
};
type Selection = { source: CharacterChatLibrarySource; entry: CharacterMediaLibraryEntry | null };
type Props = {
  characterId: string;
  mediaType: "image" | "video";
  canWrite: boolean;
  canPublish: boolean;
  source: CharacterChatLibrarySource | null;
  onCloseSource: () => void;
};

export function CharacterChatLibrary({ characterId, mediaType, canWrite, canPublish, source, onCloseSource }: Props) {
  const { t } = useAdminI18n();
  const [library, setLibrary] = useState<CharacterMediaLibraryListResponse | null>(null);
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [loadingSource, setLoadingSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const listGate = useRef(createLatestRequestGate());
  const selectionGate = useRef(createLatestRequestGate());
  const sectionRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (cursor?: string) => {
    const request = listGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const result = await adminV2Operation("GET /api/v2/admin/characters/:id/media-library", {
        path: { id: characterId },
        query: new URLSearchParams({ mediaType, limit: "25", ...(status === "all" ? {} : { status }), ...(cursor ? { cursor } : {}) }),
      });
      if (!request.isCurrent()) return;
      setLibrary(current => ({ ...result, items: cursor && current ? [...current.items, ...result.items] : result.items }));
    } catch (cause) {
      if (request.isCurrent()) setError(errorMessage(cause, t("Chat media could not be loaded")));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [characterId, mediaType, status, t]);

  useEffect(() => {
    const gate = listGate.current;
    const refresh = () => { void load(); };
    const timer = window.setTimeout(refresh, 0);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load]);

  const loadSource = useCallback(async (selectedSource: CharacterChatLibrarySource) => {
    const gate = selectionGate.current;
    const request = gate.begin();
    setLoadingSource(true);
    setSelection(null);
    setError(null);
    sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    try {
      const result = await adminV2Operation("GET /api/v2/admin/characters/:id/media-library", {
        path: { id: characterId }, query: new URLSearchParams({ mediaType, sourceAssetId: selectedSource.id, limit: "1" }),
      });
      if (request.isCurrent()) setSelection({ source: selectedSource, entry: result.items[0] ?? null });
    } catch (cause) {
      if (request.isCurrent()) setError(errorMessage(cause, t("Chat media could not be loaded")));
    } finally { if (request.isCurrent()) setLoadingSource(false); }
  }, [characterId, mediaType, t]);

  useEffect(() => {
    if (!source) return;
    const gate = selectionGate.current;
    const timer = window.setTimeout(() => void loadSource(source), 0);
    return () => { window.clearTimeout(timer); gate.invalidate(); };
  }, [source, loadSource]);

  function openEntry(entry: CharacterMediaLibraryEntry) {
    selectionGate.current.invalidate();
    setLoadingSource(false);
    onCloseSource();
    setSelection({ entry, source: { id: entry.sourceAssetId, url: entry.url, thumbnailUrl: entry.thumbnailUrl } });
  }

  return (
    <section ref={sectionRef} aria-label={t("Chat media library")} className="space-y-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold"><MessageCircle className="h-5 w-5" />{t("Chat media library")}</h3>
          <p className="mt-1 max-w-3xl text-sm text-[var(--ad-text-muted)]">{t("Describe what is actually visible, then enable it for chat. Chat can reuse matching media without generating it again.")}</p>
        </div>
        <label className="text-xs">{t("Chat availability")}
          <select aria-label={t("Chat availability")} className={`${fieldClass} mt-1`} value={status} onChange={event => setStatus(event.target.value)}>
            <option value="all">{t("All")}</option><option value="draft">{t("Draft")}</option>
            <option value="published">{t("Available in chat")}</option><option value="withdrawn">{t("Withdrawn from chat")}</option>
          </select>
        </label>
      </div>
      {error ? <div role="alert" className="text-sm text-[var(--ad-red-text)]">{error}<WorkspaceButton className="ml-3" onClick={() => { void load(); if (source) void loadSource(source); }}>{t("Retry")}</WorkspaceButton></div> : null}
      {message ? <p role="status" className="text-sm text-[var(--ad-green-text)]">{message}</p> : null}
      {loadingSource ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading chat description")}</p> : null}
      {selection && !loadingSource ? (
        <ChatMediaEditor
          key={`${selection.source.id}:${selection.entry?.revision ?? "new"}:${canWrite}:${canPublish}`}
          characterId={characterId} mediaType={mediaType} selection={selection}
          canWrite={canWrite} canPublish={canPublish} canDescribe={library?.capabilities.describe ?? false}
          visualIdentity={library?.visualIdentity ?? null}
          onClose={() => { selectionGate.current.invalidate(); setSelection(null); onCloseSource(); }}
          onReload={() => { void load(); void loadSource(selection.source); }}
          onSaved={entry => {
            setSelection({ entry, source: { id: entry.sourceAssetId, url: entry.url, thumbnailUrl: entry.thumbnailUrl } });
            setMessage(t(entry.status === "published" ? "Media is available in chat" : entry.status === "withdrawn" ? "Media withdrawn from chat" : "Chat description saved"));
            void load();
          }}
        />
      ) : null}
      {loading && !library ? <Loader2 aria-label={t("Loading")} className="h-5 w-5 animate-spin" /> : null}
      {library?.items.length === 0 && !loading && !error ? <p className="text-sm text-[var(--ad-text-muted)]">{t("No chat media in this view. Choose an image or video below to describe it.")}</p> : null}
      {library?.items.length ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {library.items.map(entry => <button key={entry.id} type="button" className="overflow-hidden rounded-lg border border-[var(--ad-border)] text-left hover:border-[var(--ad-text-muted)]" onClick={() => openEntry(entry)}>
            {mediaType === "image" ? <AssetImage asset={{ url: entry.url, thumbnailUrl: entry.thumbnailUrl ?? entry.url }} /> : <video className="aspect-video w-full bg-black object-contain" src={entry.url} poster={entry.thumbnailUrl ?? undefined} preload="metadata" muted />}
            <span className="block p-3"><span className="block text-xs font-semibold">{t(entry.status === "published" ? "Available in chat" : entry.status === "withdrawn" ? "Withdrawn from chat" : "Draft")}</span>
              <span className="mt-1 block line-clamp-3 text-sm">{entry.description}</span>
              <span className="mt-2 block text-xs text-[var(--ad-text-muted)]">{t("Edit chat description")}</span></span>
          </button>)}
        </div>
      ) : null}
      {library?.nextCursor ? <WorkspaceButton disabled={loading} onClick={() => void load(library.nextCursor ?? undefined)}>{t("Load more chat media")}</WorkspaceButton> : null}
      <ChatLibrarySearch key={`${characterId}:${mediaType}:${library?.capabilities.search ?? false}`} characterId={characterId} mediaType={mediaType} enabled={library?.capabilities.search ?? false} onSelect={openEntry} />
    </section>
  );
}

function ChatMediaEditor({ characterId, mediaType, selection, canWrite, canPublish, canDescribe, visualIdentity, onSaved, onClose, onReload }: {
  characterId: string; mediaType: "image" | "video"; selection: Selection; canWrite: boolean; canPublish: boolean;
  canDescribe: boolean; visualIdentity: CharacterMediaLibraryListResponse["visualIdentity"];
  onSaved: (entry: CharacterMediaLibraryEntry) => void; onClose: () => void; onReload: () => void;
}) {
  const { t } = useAdminI18n();
  const { source, entry } = selection;
  const [description, setDescription] = useState(entry?.description ?? "");
  const [facts, setFacts] = useState(entry?.facts.join("\n") ?? "");
  const [absentFacts, setAbsentFacts] = useState(entry?.absentFacts.join("\n") ?? "");
  const [nudity, setNudity] = useState<CharacterMediaLibraryEntry["nudity"]>(entry?.nudity ?? "unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  useEffect(() => { const current = gate.current; return () => current.invalidate(); }, [canWrite, canPublish]);
  const editable = canWrite && (!entry || entry.status === "draft" || canPublish);
  const locked = !editable || busy;
  const valid = description.trim().length >= 3 && description.trim().length <= 2_000 && factsValid(facts) && factsValid(absentFacts);

  async function describe() {
    if (locked || !canDescribe) return;
    const request = gate.current.begin();
    setBusy(true); setError(null);
    try {
      const result = await adminV2Operation("POST /api/v2/admin/characters/:id/media-library/describe", { path: { id: characterId }, body: { sourceAssetId: source.id } });
      if (!request.isCurrent()) return;
      setDescription(result.description); setFacts(result.facts.join("\n")); setAbsentFacts(result.absentFacts.join("\n")); setNudity(result.nudity);
      setSuggestion(t("Content recognition is a draft. Review the preview and correct it before saving."));
    } catch (cause) { if (request.isCurrent()) setError(errorMessage(cause, t("Content recognition failed"))); }
    finally { if (request.isCurrent()) setBusy(false); }
  }

  async function save(status?: CharacterMediaLibraryEntry["status"]) {
    if (locked || (status !== "withdrawn" && !valid) || (!entry && !visualIdentity) || (status && status !== "draft" && !canPublish)) return;
    const request = gate.current.begin();
    setBusy(true); setError(null);
    const descriptor = { description: description.trim(), facts: splitFacts(facts), absentFacts: splitFacts(absentFacts), nudity };
    try {
      const result = entry
        ? await adminV2Operation("PATCH /api/v2/admin/characters/:id/media-library/:entryId", {
          path: { id: characterId, entryId: entry.id }, body: { expectedRevision: entry.revision, ...(status === "withdrawn" ? { status } : { ...descriptor, ...(status ? { status } : {}) }) },
        })
        : await adminV2Operation("POST /api/v2/admin/characters/:id/media-library", {
          path: { id: characterId }, body: { sourceAssetId: source.id, expectedVisualProfileId: visualIdentity!.visualProfileId,
            expectedVisualProfileVersion: visualIdentity!.visualProfileVersion, ...descriptor, status: status === "published" ? "published" : "draft" },
        });
      if (request.isCurrent()) onSaved(result.entry);
    } catch (cause) { if (request.isCurrent()) setError(errorMessage(cause, t("Chat description could not be saved"))); }
    finally { if (request.isCurrent()) setBusy(false); }
  }

  const previewUrl = entry?.url ?? source.url;
  return (
    <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.015] p-4" aria-label={t("Chat description editor")}>
      <div className="mb-4 flex items-center justify-between gap-3"><h4 className="font-semibold">{t("Edit chat description")}</h4><WorkspaceButton disabled={busy} onClick={onClose}><X className="h-4 w-4" />{t("Close")}</WorkspaceButton></div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div>{mediaType === "image" ? <AssetImage preview asset={{ url: previewUrl, thumbnailUrl: entry?.thumbnailUrl ?? source.thumbnailUrl ?? previewUrl }} /> : <video controls className="max-h-[28rem] w-full bg-black object-contain" src={previewUrl} poster={entry?.thumbnailUrl ?? source.thumbnailUrl ?? undefined} preload="metadata" />}</div>
        <div className="space-y-3">
          <label className="block text-sm">{t("Visible content description")}<textarea className={`${fieldClass} mt-1 min-h-28`} disabled={locked} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">{t("Visible facts, one per line")}<textarea className={`${fieldClass} mt-1 min-h-24`} disabled={locked} value={facts} onChange={event => setFacts(event.target.value)} /></label>
            <label className="block text-sm">{t("Confirmed absent facts, one per line")}<textarea className={`${fieldClass} mt-1 min-h-24`} disabled={locked} value={absentFacts} onChange={event => setAbsentFacts(event.target.value)} /></label>
          </div>
          <p className="text-xs text-[var(--ad-text-muted)]">{t("Only record verified content. Each list allows 48 facts of up to 160 characters.")}</p>
          <label className="block text-sm">{t("Visible nudity")}<select className={`${fieldClass} mt-1`} disabled={locked} value={nudity} onChange={event => setNudity(event.target.value as CharacterMediaLibraryEntry["nudity"])}>
            <option value="unknown">{t("Not verified")}</option><option value="none">{t("No nudity")}</option><option value="partial">{t("Partial nudity")}</option><option value="full">{t("Full nudity")}</option>
          </select></label>
          {!visualIdentity && !entry ? <p role="alert" className="text-sm text-[var(--ad-yellow-text)]">{t("Set the Character visual identity before adding chat media.")}</p> : null}
          {entry && entry.status !== "draft" && !canPublish ? <p className="text-sm text-[var(--ad-text-muted)]">{t("Editing published or withdrawn chat media requires publish permission.")}</p> : null}
          {!canDescribe ? <p className="text-xs text-[var(--ad-text-muted)]">{t("Content recognition is unavailable. Enter a verified description manually.")}</p> : null}
          {suggestion ? <p role="status" className="text-sm text-[var(--ad-text-muted)]">{suggestion}</p> : null}
          {error ? <div role="alert" className="text-sm text-[var(--ad-red-text)]"><p>{error}</p><WorkspaceButton className="mt-2" disabled={busy} onClick={onReload}>{t("Discard edits and reload")}</WorkspaceButton></div> : null}
          <div className="flex flex-wrap gap-2">
            <WorkspaceButton disabled={locked || !canDescribe} onClick={() => void describe()}><WandSparkles className="h-4 w-4" />{t("Recognize visible content")}</WorkspaceButton>
            <WorkspaceButton disabled={locked || !valid || (!entry && !visualIdentity)} onClick={() => void save()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{t(entry ? "Save description" : "Save draft")}</WorkspaceButton>
            {entry?.status === "published"
              ? <WorkspaceButton disabled={locked || !canPublish} onClick={() => void save("withdrawn")}>{t("Withdraw from chat")}</WorkspaceButton>
              : <WorkspaceButton tone="primary" disabled={locked || !valid || !canPublish || (!entry && !visualIdentity)} onClick={() => void save("published")}>{t("Use in chat")}</WorkspaceButton>}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatLibrarySearch({ characterId, mediaType, enabled, onSelect }: { characterId: string; mediaType: "image" | "video"; enabled: boolean; onSelect: (entry: CharacterMediaLibraryEntry) => void }) {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState("");
  const [requiredFacts, setRequiredFacts] = useState("");
  const [excludedFacts, setExcludedFacts] = useState("");
  const [nudity, setNudity] = useState<"unspecified" | "none" | "full">("unspecified");
  const [result, setResult] = useState<CharacterMediaLibrarySearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  useEffect(() => { const current = gate.current; return () => current.invalidate(); }, [characterId, mediaType, enabled]);
  async function search() {
    if (!enabled || busy || !query.trim() || !factsValid(requiredFacts) || !factsValid(excludedFacts)) return;
    const request = gate.current.begin(); setBusy(true); setError(null); setResult(null);
    try {
      const response = await adminV2Operation("POST /api/v2/admin/characters/:id/media-library/search-preview", { path: { id: characterId }, body: { mediaType, query: query.trim(), requiredFacts: splitFacts(requiredFacts), excludedFacts: splitFacts(excludedFacts), nudity } });
      if (request.isCurrent()) setResult(response);
    } catch (cause) { if (request.isCurrent()) setError(errorMessage(cause, t("Chat media search failed"))); }
    finally { if (request.isCurrent()) setBusy(false); }
  }
  return <details className="border-t border-[var(--ad-border)] pt-4">
    <summary className="cursor-pointer text-sm font-semibold">{t("Try a chat request")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-[var(--ad-text-muted)]">{t("Test which published media matches a request. This does not send a chat message.")}</p>
      {!enabled ? <p className="text-sm text-[var(--ad-yellow-text)]">{t("Chat media search is unavailable.")}</p> : null}
      <label className="block text-sm">{t("Example chat request")}<input className={`${fieldClass} mt-1`} value={query} maxLength={2000} onChange={event => setQuery(event.target.value)} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t("Required facts, one per line")}<textarea className={`${fieldClass} mt-1`} value={requiredFacts} onChange={event => setRequiredFacts(event.target.value)} /></label><label className="text-sm">{t("Excluded facts, one per line")}<textarea className={`${fieldClass} mt-1`} value={excludedFacts} onChange={event => setExcludedFacts(event.target.value)} /></label></div>
      <label className="block text-sm">{t("Requested nudity")}<select className={`${fieldClass} mt-1`} value={nudity} onChange={event => setNudity(event.target.value as typeof nudity)}><option value="unspecified">{t("Unspecified")}</option><option value="none">{t("No nudity")}</option><option value="full">{t("Full nudity")}</option></select></label>
      <WorkspaceButton disabled={!enabled || busy || !query.trim() || !factsValid(requiredFacts) || !factsValid(excludedFacts)} onClick={() => void search()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}{t("Find matching chat media")}</WorkspaceButton>
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {result ? <div role="status" className="space-y-2"><p className="text-sm">{t("{count} matches in {milliseconds} ms", { count: result.matches.length, milliseconds: Math.round(result.elapsedMs) })}</p>{result.matches.map(match => <button type="button" key={match.entry.id} onClick={() => onSelect(match.entry)} className="block w-full rounded-lg border border-[var(--ad-border)] p-3 text-left text-sm"><span className="block">{match.entry.description}</span><span className="mt-1 block text-xs text-[var(--ad-text-muted)]">{match.reasons.map(reason => t(reason)).join(" · ")}</span></button>)}</div> : null}
    </div>
  </details>;
}

function errorMessage(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
function splitFacts(value: string) { return [...new Set(value.split("\n").map(fact => fact.trim()).filter(Boolean))]; }
function factsValid(value: string) { const facts = splitFacts(value); return facts.length <= 48 && facts.every(fact => fact.length <= 160); }
