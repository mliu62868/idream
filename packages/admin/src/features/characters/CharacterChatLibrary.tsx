"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CharacterMediaLibraryBatchReviewItem,
  CharacterMediaLibraryEntry,
  CharacterMediaLibraryListResponse,
  CharacterMediaLibrarySearchResponse,
  CharacterMediaLibraryVisualIdentity,
} from "@idream/shared/admin";
import { CheckSquare, Layers, Loader2, MessageCircle, Search, WandSparkles, X } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { operatorErrorCopy, type OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { createLatestRequestGate } from "@/lib/latest-request";
import { CHARACTER_IMMEDIATE_EFFECT_COPY } from "./character-immediate-effects";
import type { ChatPackProfileOption, ChatPackSourceOption } from "./chat-pack-options";

export type CharacterChatLibrarySource = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
};
type Selection = {
  source: CharacterChatLibrarySource;
  entry: CharacterMediaLibraryEntry | null;
  visualIdentity: VisualIdentity;
  sourceEntries?: CharacterMediaLibraryEntry[];
};
type VisualIdentity = CharacterMediaLibraryVisualIdentity | null;
type VisualIdentityChoice = { pin: CharacterMediaLibraryVisualIdentity; label: string };
type EditorFailure = { action: string; copy: OperatorErrorCopy; versionConflict: boolean };
type LibraryMessage = { text: string; note?: string; href?: string; linkLabel?: string };
type Props = {
  characterId: string;
  mediaType: "image" | "video";
  canWrite: boolean;
  canPublish: boolean;
  source: CharacterChatLibrarySource | null;
  onCloseSource: () => void;
  packProfiles?: readonly ChatPackProfileOption[];
  packSources?: readonly ChatPackSourceOption[];
};

export function CharacterChatLibrary({ characterId, mediaType, canWrite, canPublish, source, onCloseSource, packProfiles = [], packSources = [] }: Props) {
  const { t } = useAdminI18n();
  const [library, setLibrary] = useState<CharacterMediaLibraryListResponse | null>(null);
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [loadingSource, setLoadingSource] = useState(false);
  const [error, setError] = useState<{ cause: unknown; message: string } | null>(null);
  const [message, setMessage] = useState<LibraryMessage | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [batchReviewOpen, setBatchReviewOpen] = useState(false);
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
      if (request.isCurrent()) setError({ cause, message: t("Chat media could not be loaded") });
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

  const loadSource = useCallback(async (selectedSource: CharacterChatLibrarySource, preferredIdentity?: VisualIdentity) => {
    const gate = selectionGate.current;
    const request = gate.begin();
    setLoadingSource(true);
    setSelection(null);
    setError(null);
    sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    try {
      const result = await adminV2Operation("GET /api/v2/admin/characters/:id/media-library", {
        // One source has one entry per identity version, and the newest need not be the current one.
        path: { id: characterId }, query: new URLSearchParams({ mediaType, sourceAssetId: selectedSource.id, limit: "100" }),
      });
      if (request.isCurrent()) {
        const live = result.serving?.visualIdentity ?? null;
        const current = result.visualIdentity ?? live;
        const preferred = preferredIdentity ?? null;
        const preferredIsCurrent = sameVisualIdentity(preferred, result.visualIdentity) || sameVisualIdentity(preferred, live);
        let entry: CharacterMediaLibraryEntry | undefined;
        if (preferredIsCurrent || (!current && preferred !== null)) {
          entry = result.items.find(item => sameVisualIdentity(item, preferred));
        } else {
          entry = result.items.find(item => sameVisualIdentity(item, result.visualIdentity))
            ?? result.items.find(item => sameVisualIdentity(item, live));
          // Only opening a source may default to a historical entry while a current identity exists.
          if (!entry && preferredIdentity === undefined) entry = result.items[0];
        }
        setSelection({ source: selectedSource, entry: entry ?? null, sourceEntries: result.items,
          visualIdentity: entry ? entryVisualIdentity(entry) : preferredIsCurrent ? preferred : current });
      }
    } catch (cause) {
      if (request.isCurrent()) setError({ cause, message: t("Chat media could not be loaded") });
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
    const source = { id: entry.sourceAssetId, url: entry.url, thumbnailUrl: entry.thumbnailUrl };
    setSelection({ entry, source, visualIdentity: entryVisualIdentity(entry) });
  }

  const liveIdentity = library?.serving?.visualIdentity ?? null;
  const productionIdentity = library?.visualIdentity ?? null;
  const choices = distinctVisualIdentities([liveIdentity, productionIdentity]);
  const describeIdentity = (pin: CharacterMediaLibraryVisualIdentity) => t(
    sameVisualIdentity(pin, liveIdentity) ? "Live Release identity (v{version})"
      : sameVisualIdentity(pin, productionIdentity) ? "Production identity (v{version})" : "From a previous identity (v{version})",
    { version: pin.visualProfileVersion },
  );
  const previewChoices = choices.map(pin => ({ pin, label: describeIdentity(pin) }));
  const editorChoices = selection?.sourceEntries
    ? distinctVisualIdentities([...choices, ...selection.sourceEntries.map(entryVisualIdentity)]).map(pin => ({ pin, label: describeIdentity(pin) })) : [];
  const previewIdentity = library?.serving ? liveIdentity : productionIdentity;
  const draftEntries = (library?.items ?? []).filter(item => item.status === "draft");

  return (
    <section ref={sectionRef} aria-label={t("Chat media library")} className="space-y-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold"><MessageCircle className="h-5 w-5" />{t("Chat media library")}</h3>
          <p className="mt-1 max-w-3xl text-sm text-[var(--ad-text-muted)]">{t("Describe what is actually visible, then enable it for chat. Chat can reuse matching media without generating it again.")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {canWrite && canPublish && draftEntries.length > 0 ? (
            <WorkspaceButton
              tone={batchReviewOpen ? "primary" : "default"}
              onClick={() => setBatchReviewOpen(open => !open)}
            >
              <CheckSquare className="h-4 w-4" />
              {batchReviewOpen ? t("Close batch review") : t("Batch review drafts ({count})", { count: draftEntries.length })}
            </WorkspaceButton>
          ) : null}
          <label className="text-xs">{t("Chat availability")}
            <select aria-label={t("Chat availability")} className={`${fieldClass} mt-1`} value={status} onChange={event => setStatus(event.target.value)}>
              <option value="all">{t("All")}</option><option value="draft">{t("Draft")}</option>
              <option value="published">{t("Published")}</option><option value="withdrawn">{t("Withdrawn from chat")}</option>
            </select>
          </label>
        </div>
      </div>
      {error ? <AuthorityRequestError cause={error.cause} message={error.message} requestKind="read" onRetry={() => { void load(); if (source) void loadSource(source); }} /> : null}
      {message ? <p role="status" className="text-sm text-[var(--ad-green-text)]">
        {message.text}
        {message.note ? <span className="block text-xs font-semibold text-[var(--ad-yellow-text)]">{message.note}</span> : null}
        {message.href ? <> <a className="font-semibold underline" href={message.href}>{message.linkLabel ?? message.href}</a></> : null}
      </p> : null}
      {batchReviewOpen && canWrite && canPublish && draftEntries.length > 0 ? (
        <BatchReviewGrid
          characterId={characterId}
          mediaType={mediaType}
          entries={draftEntries}
          canIndex={library?.capabilities.search ?? false}
          onClose={() => setBatchReviewOpen(false)}
          onReviewed={(count) => {
            setBatchReviewOpen(false);
            setMessage({ text: t("Batch review saved for {count} items", { count }) });
            void load();
          }}
        />
      ) : null}
      {library ? <div className="space-y-1 text-sm text-[var(--ad-text-muted)]">
        {previewChoices.map(({ pin, label }) => {
          const coverage = sameVisualIdentity(pin, liveIdentity) ? library.coverage.serving : library.coverage.production;
          return coverage ? <p key={pin.visualProfileId}><strong>{label}</strong> · {t("{count} published", { count: coverage.published })}
            {!coverage.hasEligibleMedia ? ` · ${t("No eligible indexed media")}` : null}</p> : null;
        })}
        {library.serving && !liveIdentity ? <p>{t("The live Release has no verified visual identity.")}</p> : null}
      </div> : null}
      {loadingSource ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading chat description")}</p> : null}
      {selection && !loadingSource ? (
        <ChatMediaEditor
          key={`${characterId}:${selection.source.id}:${selection.visualIdentity?.visualProfileId}:${selection.entry?.revision ?? "new"}:${canWrite}:${canPublish}`}
          characterId={characterId} mediaType={mediaType} selection={selection}
          canWrite={canWrite} canPublish={canPublish} canDescribe={library?.capabilities.describe ?? false}
          canIndex={library?.capabilities.search ?? false}
          canEditIdentity={choices.some(pin => sameVisualIdentity(pin, selection.visualIdentity))}
          identityLabel={selection.visualIdentity ? describeIdentity(selection.visualIdentity) : null}
          identityChoices={editorChoices}
          onIdentityChange={pin => setSelection({ ...selection, visualIdentity: pin,
            entry: selection.sourceEntries?.find(item => sameVisualIdentity(item, pin)) ?? null })}
          onClose={() => { selectionGate.current.invalidate(); setSelection(null); onCloseSource(); }}
          onReload={() => { void load(); void loadSource(selection.source, selection.visualIdentity); }}
          onSaved={entry => {
            setSelection({ ...selection, entry, visualIdentity: entryVisualIdentity(entry),
              ...(selection.sourceEntries ? { sourceEntries: [entry, ...selection.sourceEntries.filter(item => item.id !== entry.id)] } : {}) });
            setMessage({
              text: t(entry.status === "published" ? "Chat media enabled for this identity" : entry.status === "withdrawn" ? "Media withdrawn from chat" : "Chat description saved"),
              // SPEC: 进入 / 撤出聊天都绕过 Release，成功提示也要说出它已经在线上生效。
              ...(entry.status === "draft" ? {} : { note: t(CHARACTER_IMMEDIATE_EFFECT_COPY) }),
            });
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
            <span className="block p-3"><span className="block text-xs font-semibold">{describeIdentity(entry)}</span>
              <span className="mt-1 block line-clamp-3 text-sm">{entry.description}</span>
              <span className="mt-2 block text-xs text-[var(--ad-text-muted)]">{t(entry.status === "published" ? "Published" : entry.status === "withdrawn" ? "Withdrawn from chat" : "Draft")}</span></span>
          </button>)}
        </div>
      ) : null}
      {library?.nextCursor ? <WorkspaceButton disabled={loading} onClick={() => void load(library.nextCursor ?? undefined)}>{t("Load more chat media")}</WorkspaceButton> : null}
      {canWrite && productionIdentity ? (
        <BatchPregenPackPanel
          characterId={characterId}
          mediaType={mediaType}
          visualIdentity={productionIdentity}
          profiles={packProfiles}
          sources={packSources}
          onCreated={(runId, count) => {
            setMessage({
              text: t("Started a pre-generation pack of {count} items.", { count }),
              href: `/admin/creative/runs/${encodeURIComponent(runId)}`,
              linkLabel: t("View Creative Run"),
            });
          }}
        />
      ) : null}
      <ChatLibrarySearch key={`${characterId}:${mediaType}:${library?.serving?.releaseId}:${productionIdentity?.visualProfileId}:${previewIdentity?.visualProfileId}:${library?.capabilities.search ?? false}`}
        characterId={characterId} mediaType={mediaType} enabled={library?.capabilities.search ?? false}
        defaultIdentity={previewIdentity} identityChoices={previewChoices} onSelect={openEntry} />
    </section>
  );
}

function ChatMediaEditor({ characterId, mediaType, selection, canWrite, canPublish, canDescribe, canIndex, canEditIdentity, identityLabel, identityChoices, onIdentityChange, onSaved, onClose, onReload }: {
  characterId: string; mediaType: "image" | "video"; selection: Selection; canWrite: boolean; canPublish: boolean;
  canDescribe: boolean; canIndex: boolean; canEditIdentity: boolean; identityLabel: string | null; identityChoices: VisualIdentityChoice[];
  onIdentityChange: (pin: CharacterMediaLibraryVisualIdentity) => void;
  onSaved: (entry: CharacterMediaLibraryEntry) => void; onClose: () => void; onReload: () => void;
}) {
  const { t } = useAdminI18n();
  const { source, entry, visualIdentity } = selection;
  const [description, setDescription] = useState(entry?.description ?? "");
  const [facts, setFacts] = useState(entry?.facts.join("\n") ?? "");
  const [absentFacts, setAbsentFacts] = useState(entry?.absentFacts.join("\n") ?? "");
  const [nudity, setNudity] = useState<CharacterMediaLibraryEntry["nudity"]>(entry?.nudity ?? "unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EditorFailure | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  useEffect(() => { const current = gate.current; return () => current.invalidate(); }, [canWrite, canPublish]);
  const editable = canWrite && canEditIdentity && (!entry || entry.status === "draft" || canPublish);
  const canWithdraw = canWrite && canPublish && entry?.status === "published";
  const locked = !editable || busy;
  const valid = description.trim().length >= 3 && description.trim().length <= 2_000 && factsValid(facts) && factsValid(absentFacts);

  async function describe() {
    if (locked || !canDescribe || !visualIdentity) return;
    const request = gate.current.begin();
    setBusy(true); setError(null);
    try {
      const result = await adminV2Operation("POST /api/v2/admin/characters/:id/media-library/describe", {
        path: { id: characterId }, body: { sourceAssetId: source.id, visualIdentity },
      });
      if (!request.isCurrent()) return;
      setDescription(result.description); setFacts(result.facts.join("\n")); setAbsentFacts(result.absentFacts.join("\n")); setNudity(result.nudity);
      setSuggestion(t("Content recognition is a draft. Review the preview and correct it before saving."));
    } catch (cause) { if (request.isCurrent()) setError(editorFailure(cause, t("Content recognition failed"))); }
    finally { if (request.isCurrent()) setBusy(false); }
  }

  async function save(status?: CharacterMediaLibraryEntry["status"]) {
    if (!visualIdentity || busy || (status === "withdrawn" ? !canWithdraw : !editable || !valid || (status === "published" && !canPublish))) return;
    const request = gate.current.begin();
    setBusy(true); setError(null);
    const descriptor = { description: description.trim(), facts: splitFacts(facts), absentFacts: splitFacts(absentFacts), nudity };
    try {
      const result = entry
        ? await adminV2Operation("PATCH /api/v2/admin/characters/:id/media-library/:entryId", {
          path: { id: characterId, entryId: entry.id }, body: { expectedRevision: entry.revision, ...(status === "withdrawn" ? { status } : { ...descriptor, ...(status ? { status } : {}) }) },
        })
        : await adminV2Operation("POST /api/v2/admin/characters/:id/media-library", {
          path: { id: characterId }, body: { sourceAssetId: source.id, expectedVisualProfileId: visualIdentity.visualProfileId,
            expectedVisualProfileVersion: visualIdentity.visualProfileVersion, ...descriptor, status: status === "published" ? "published" : "draft" },
        });
      if (request.isCurrent()) onSaved(result.entry);
    } catch (cause) { if (request.isCurrent()) setError(editorFailure(cause, t("Chat description could not be saved"))); }
    finally { if (request.isCurrent()) setBusy(false); }
  }

  const previewUrl = entry?.url ?? source.url;
  return (
    <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.015] p-4" aria-label={t("Chat description editor")}>
      <div className="mb-4 flex items-center justify-between gap-3"><h4 className="font-semibold">{t("Edit chat description")}</h4><WorkspaceButton disabled={busy} onClick={onClose}><X className="h-4 w-4" />{t("Close")}</WorkspaceButton></div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div>{mediaType === "image" ? <AssetImage preview asset={{ url: previewUrl, thumbnailUrl: entry?.thumbnailUrl ?? source.thumbnailUrl ?? previewUrl }} /> : <video controls className="max-h-[28rem] w-full bg-black object-contain" src={previewUrl} poster={entry?.thumbnailUrl ?? source.thumbnailUrl ?? undefined} preload="metadata" />}</div>
        <div className="space-y-3">
          {identityChoices.length > 1 ? <label className="block text-sm">{t("Visual identity for this media")}
            <select className={`${fieldClass} mt-1`} value={visualIdentity?.visualProfileId ?? ""} disabled={busy} onChange={event => {
              const selected = identityChoices.find(choice => choice.pin.visualProfileId === event.target.value);
              if (selected) onIdentityChange(selected.pin);
            }}>
              {identityChoices.map(({ pin, label }) => <option key={pin.visualProfileId} value={pin.visualProfileId}>{label}</option>)}
            </select>
          </label> : identityLabel ? <p className="text-sm font-semibold">{identityLabel}</p> : null}
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
          {visualIdentity && !canEditIdentity ? <p role="status" className="text-sm text-[var(--ad-yellow-text)]">{t("This identity is outside the live Release and current production. Its chat description is read-only.")}</p> : null}
          {entry && entry.status !== "draft" && !canPublish ? <p className="text-sm text-[var(--ad-text-muted)]">{t("Editing published or withdrawn chat media requires publish permission.")}</p> : null}
          {!canDescribe ? <p className="text-xs text-[var(--ad-text-muted)]">{t("Content recognition is unavailable. Enter a verified description manually.")}</p> : null}
          {suggestion ? <p role="status" className="text-sm text-[var(--ad-text-muted)]">{suggestion}</p> : null}
          {error ? <div role="alert" className="text-sm text-[var(--ad-red-text)]">
            <p className="font-semibold">{error.action}</p>
            <p className="mt-1">{t(error.copy.headline)} {t(error.copy.nextStep, error.copy.nextStepValues)}</p>
            <RequestErrorDetails technical={error.copy.technical} />
            {error.versionConflict ? <WorkspaceButton className="mt-2" disabled={busy} onClick={onReload}>{t("Discard edits and reload")}</WorkspaceButton> : null}
          </div> : null}
          {/* SPEC: Use in chat / Withdraw from chat 直接改线上聊天可发的素材，不进 Release；按钮旁说出来。 */}
          {canPublish && (entry?.status === "published" ? canWithdraw : editable) ? (
            <p className="text-xs font-semibold text-[var(--ad-yellow-text)]" data-testid="chat-media-effect-note">
              {t(CHARACTER_IMMEDIATE_EFFECT_COPY)}
            </p>
          ) : null}
          {/* SPEC: 启用聊天素材必须先写入媒体索引；索引未配置时事前说明，而不是让运营点了才收到「结果未知」。 */}
          {canPublish && !canIndex && entry?.status !== "published" ? (
            <p className="text-xs text-[var(--ad-yellow-text)]" data-testid="chat-media-index-unavailable">
              {t(CHAT_MEDIA_INDEX_UNAVAILABLE_COPY)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <WorkspaceButton disabled={locked || !canDescribe} onClick={() => void describe()}><WandSparkles className="h-4 w-4" />{t("Recognize visible content")}</WorkspaceButton>
            <WorkspaceButton disabled={locked || !valid} onClick={() => void save()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{t(entry ? "Save description" : "Save draft")}</WorkspaceButton>
            {entry?.status === "published"
              ? <WorkspaceButton disabled={busy || !canWithdraw} onClick={() => void save("withdrawn")}>{t("Withdraw from chat")}</WorkspaceButton>
              : <WorkspaceButton tone="primary" disabled={locked || !valid || !canPublish || !canIndex} onClick={() => void save("published")}>{t("Use in chat")}</WorkspaceButton>}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatLibrarySearch({ characterId, mediaType, enabled, defaultIdentity, identityChoices, onSelect }: {
  characterId: string; mediaType: "image" | "video"; enabled: boolean; defaultIdentity: VisualIdentity;
  identityChoices: VisualIdentityChoice[]; onSelect: (entry: CharacterMediaLibraryEntry) => void;
}) {
  const { t } = useAdminI18n();
  const [visualIdentity, setVisualIdentity] = useState(defaultIdentity);
  const [query, setQuery] = useState("");
  const [requiredFacts, setRequiredFacts] = useState("");
  const [excludedFacts, setExcludedFacts] = useState("");
  const [nudity, setNudity] = useState<"unspecified" | "none" | "full">("unspecified");
  const [result, setResult] = useState<CharacterMediaLibrarySearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ cause: unknown; message: string } | null>(null);
  const gate = useRef(createLatestRequestGate());
  useEffect(() => { const current = gate.current; return () => current.invalidate(); }, [characterId, mediaType, enabled]);
  const canSearch = enabled && Boolean(visualIdentity);
  async function search() {
    if (!enabled || !visualIdentity || busy || !query.trim() || !factsValid(requiredFacts) || !factsValid(excludedFacts)) return;
    const request = gate.current.begin(); setBusy(true); setError(null); setResult(null);
    try {
      const response = await adminV2Operation("POST /api/v2/admin/characters/:id/media-library/search-preview", {
        path: { id: characterId }, body: { mediaType, visualIdentity, query: query.trim(), requiredFacts: splitFacts(requiredFacts), excludedFacts: splitFacts(excludedFacts), nudity },
      });
      if (request.isCurrent()) setResult(response);
    } catch (cause) { if (request.isCurrent()) setError({ cause, message: t("Chat media search failed") }); }
    finally { if (request.isCurrent()) setBusy(false); }
  }
  return <details className="border-t border-[var(--ad-border)] pt-4">
    <summary className="cursor-pointer text-sm font-semibold">{t("Try a chat request")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-[var(--ad-text-muted)]">{t("Test which published media matches a request. This does not send a chat message.")}</p>
      {identityChoices.length > 1 || (!defaultIdentity && identityChoices.length) ? <label className="block text-sm">{t("Visual identity to search")}
        <select className={`${fieldClass} mt-1`} disabled={busy} value={visualIdentity?.visualProfileId ?? ""} onChange={event => {
          setVisualIdentity(identityChoices.find(choice => choice.pin.visualProfileId === event.target.value)?.pin ?? null);
          setResult(null);
          setError(null);
        }}>
          {!defaultIdentity ? <option value="">{t("Live Release has no verified identity")}</option> : null}
          {identityChoices.map(({ pin, label }) => <option key={pin.visualProfileId} value={pin.visualProfileId}>{label}</option>)}
        </select>
      </label> : null}
      {!canSearch ? <p className="text-sm text-[var(--ad-yellow-text)]">{t("Chat media search is unavailable.")}</p> : null}
      <label className="block text-sm">{t("Example chat request")}<input className={`${fieldClass} mt-1`} value={query} maxLength={2000} onChange={event => setQuery(event.target.value)} /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t("Required facts, one per line")}<textarea className={`${fieldClass} mt-1`} value={requiredFacts} onChange={event => setRequiredFacts(event.target.value)} /></label><label className="text-sm">{t("Excluded facts, one per line")}<textarea className={`${fieldClass} mt-1`} value={excludedFacts} onChange={event => setExcludedFacts(event.target.value)} /></label></div>
      <label className="block text-sm">{t("Requested nudity")}<select className={`${fieldClass} mt-1`} value={nudity} onChange={event => setNudity(event.target.value as typeof nudity)}><option value="unspecified">{t("Unspecified")}</option><option value="none">{t("No nudity")}</option><option value="full">{t("Full nudity")}</option></select></label>
      <WorkspaceButton disabled={!canSearch || busy || !query.trim() || !factsValid(requiredFacts) || !factsValid(excludedFacts)} onClick={() => void search()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}{t("Find matching chat media")}</WorkspaceButton>
      {error ? <AuthorityRequestError cause={error.cause} message={error.message} requestKind="read" onRetry={() => void search()} /> : null}
      {result ? <div role="status" className="space-y-2"><p className="text-sm">{t("{count} matches in {milliseconds} ms", { count: result.matches.length, milliseconds: Math.round(result.elapsedMs) })}</p>{result.matches.map(match => <button type="button" key={match.entry.id} onClick={() => onSelect(match.entry)} className="block w-full rounded-lg border border-[var(--ad-border)] p-3 text-left text-sm"><span className="block">{match.entry.description}</span><span className="mt-1 block text-xs text-[var(--ad-text-muted)]">{match.reasons.map(reason => t(reason)).join(" · ")}</span></button>)}</div> : null}
    </div>
  </details>;
}

function entryVisualIdentity({ visualProfileId, visualProfileVersion }: CharacterMediaLibraryEntry) {
  return { visualProfileId, visualProfileVersion };
}
function sameVisualIdentity(left: VisualIdentity, right: VisualIdentity) {
  return left !== null && right !== null && left.visualProfileId === right.visualProfileId && left.visualProfileVersion === right.visualProfileVersion;
}
function distinctVisualIdentities(identities: VisualIdentity[]): CharacterMediaLibraryVisualIdentity[] {
  return [...new Map(identities.flatMap(pin => pin ? [[pin.visualProfileId, pin] as const] : [])).values()];
}
// SPEC: Discarding edits only helps when the editor is behind the server.
// INTENT: Main reports these conflicts with no structured blocker, so its exact messages are the
//         only positive evidence. Every other 409 stays a precondition that a reload cannot fix.
const STALE_EDITOR_CONFLICTS: ReadonlySet<string> = new Set([
  "This chat library item has changed; reload it before saving",
  "The Character visual identity changed; reload before preparing chat media",
  "Source media changed during preparation; reload it before trying again",
]);
// INTENT: Main reports this as 403, whose generic copy tells the operator to go and request a
//         permission that would change nothing. Only a new asset under this identity can enter.
const SOURCE_FROM_OTHER_IDENTITY = "Only platform Character production with this visual identity may enter the shared chat library";
// SPEC: 服务端在写入前就拒绝了启用（未配置媒体索引）：这是确定的「没有启用」，不是「结果未知」。
const MEDIA_INDEX_NOT_CONFIGURED = "Configure character media embeddings before publishing chat library items";
const CHAT_MEDIA_INDEX_UNAVAILABLE_COPY = "The chat media index is not configured, so media cannot be used in chat yet. Save the description as a draft for now.";
function editorFailure(cause: unknown, action: string): EditorFailure {
  const answered = cause instanceof AdminV2RequestError && cause.outcome === "answered";
  const versionConflict = answered && cause.status === 409 && (
    STALE_EDITOR_CONFLICTS.has(cause.message) ||
    (typeof cause.details === "object" && cause.details !== null && "blocker" in cause.details && cause.details.blocker === "version_mismatch")
  );
  const copy = operatorErrorCopy(cause);
  return {
    action, versionConflict,
    copy: answered && cause.status === 403 && cause.message === SOURCE_FROM_OTHER_IDENTITY
      ? { ...copy, headline: "This media was produced under a different visual identity.", nextStep: "Generate it again under the current identity, then add the new media to chat." }
      // INVARIANT: 服务端在 prepare 阶段（写文件与事务之前）抛出这条错误，所以即使 503 的
      //            outcome 记为 unknown，这一条也能确定「什么都没写入」。
      : cause instanceof AdminV2RequestError && cause.code === "unavailable" && cause.message.includes(MEDIA_INDEX_NOT_CONFIGURED)
        ? { ...copy, headline: "The chat media index is not configured, so nothing was enabled.", nextStep: "The saved draft is unchanged. Configure the media index, then use it in chat." }
        : copy,
  };
}
type BatchDraftDecision = {
  action: "skip" | "published" | "withdrawn";
  nudity: CharacterMediaLibraryEntry["nudity"];
  attireLevel: string;
  distributionScope: "chat_library" | "teaser" | "both";
};

function BatchReviewGrid({ characterId, mediaType, entries, canIndex, onClose, onReviewed }: {
  characterId: string;
  mediaType: "image" | "video";
  entries: CharacterMediaLibraryEntry[];
  canIndex: boolean;
  onClose: () => void;
  onReviewed: (count: number) => void;
}) {
  const { t } = useAdminI18n();
  const [decisions, setDecisions] = useState<Record<string, BatchDraftDecision>>(() =>
    Object.fromEntries(entries.map(entry => [entry.id, {
      action: "skip",
      nudity: entry.nudity,
      attireLevel: entry.attireLevel ?? "",
      distributionScope: entry.distributionScope ?? "chat_library",
    }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const selectedItems = entries.flatMap(entry => {
    const decision = decisions[entry.id];
    if (!decision || decision.action === "skip") return [];
    return [{ entry, decision }];
  });
  const missingNudityCount = selectedItems.filter(
    ({ decision }) => decision.action === "published" && decision.nudity === "unknown",
  ).length;

  function update(entryId: string, patch: Partial<BatchDraftDecision>) {
    setDecisions(current => ({
      ...current,
      [entryId]: { ...(current[entryId] ?? { action: "skip", nudity: "unknown", attireLevel: "", distributionScope: "chat_library" }), ...patch },
    }));
  }

  function applyQuickShortcut(index: number, key: string) {
    const entry = entries[index];
    if (!entry || busy) return;
    // 索引未配置时不能发布：发布类快捷键不生效，驳回仍可用。
    if (!canIndex && ["1", "2", "3"].includes(key)) return;
    if (key === "1") {
      update(entry.id, { action: "published", nudity: "none", attireLevel: "clothed" });
    } else if (key === "2") {
      update(entry.id, { action: "published", nudity: "partial", attireLevel: "lingerie" });
    } else if (key === "3") {
      update(entry.id, { action: "published", nudity: "full", attireLevel: "nude" });
    } else if (key === "r" || key === "R") {
      update(entry.id, { action: "withdrawn" });
    } else {
      return;
    }
    setActiveIndex(Math.min(entries.length - 1, index + 1));
  }

  function approveAllClothed() {
    if (!canIndex) return;
    setDecisions(current =>
      Object.fromEntries(entries.map(entry => {
        const prev = current[entry.id];
        return [entry.id, {
          action: "published" as const,
          nudity: prev && prev.nudity !== "unknown" ? prev.nudity : "none",
          attireLevel: prev?.attireLevel || "clothed",
          distributionScope: prev?.distributionScope ?? "chat_library",
        }];
      })),
    );
  }

  async function submit() {
    if (busy || selectedItems.length === 0 || missingNudityCount > 0) return;
    setBusy(true);
    setError(null);
    try {
      const items: CharacterMediaLibraryBatchReviewItem[] = selectedItems.map(({ entry, decision }) => ({
        entryId: entry.id,
        expectedRevision: entry.revision,
        status: decision.action === "withdrawn" ? "withdrawn" : "published",
        nudity: decision.nudity,
        ...(decision.attireLevel ? { attireLevel: decision.attireLevel } : {}),
        distributionScope: decision.distributionScope,
      }));
      const result = await adminV2Operation("POST /api/v2/admin/characters/:id/media-library/batch-review", {
        path: { id: characterId },
        body: { items },
      });
      onReviewed(result.entries.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Batch review could not be saved"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      aria-label={t("Batch review drafts")}
      tabIndex={-1}
      onKeyDown={event => {
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (["1", "2", "3", "r", "R"].includes(event.key)) {
          event.preventDefault();
          applyQuickShortcut(activeIndex, event.key);
        }
      }}
      className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-black/[0.02] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold">{t("3-Field Batch Review")}</h4>
          <p className="text-xs text-[var(--ad-text-muted)]">{t("Confirm decision, nudity rating, and attire level. Shortcuts on active card: 1 = Clothed, 2 = Partial, 3 = Full, R = Reject.")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <WorkspaceButton disabled={busy || !canIndex} onClick={approveAllClothed}>{t("Mark all clothed & approve")}</WorkspaceButton>
          {!canIndex ? <span className="text-xs text-[var(--ad-yellow-text)]">{t(CHAT_MEDIA_INDEX_UNAVAILABLE_COPY)}</span> : null}
          <WorkspaceButton
            tone="primary"
            disabled={busy || selectedItems.length === 0 || missingNudityCount > 0}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("Submit batch review ({count})", { count: selectedItems.length })}
          </WorkspaceButton>
          <WorkspaceButton disabled={busy} onClick={onClose}><X className="h-4 w-4" />{t("Cancel")}</WorkspaceButton>
        </div>
      </div>
      {missingNudityCount > 0 ? (
        <p role="alert" className="text-xs text-[var(--ad-yellow-text)]">
          {t("{count} approved items still have unverified nudity. Select No/Partial/Full nudity before submitting.", { count: missingNudityCount })}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry, index) => {
          const decision = decisions[entry.id] ?? { action: "skip", nudity: entry.nudity, attireLevel: "", distributionScope: "chat_library" };
          const isActive = index === activeIndex;
          return (
            <div
              key={entry.id}
              data-batch-entry-id={entry.id}
              data-batch-active={isActive ? "true" : "false"}
              onClick={() => setActiveIndex(index)}
              className={`overflow-hidden rounded-lg border bg-[var(--ad-surface)] p-3 ${isActive ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]" : "border-[var(--ad-border)]"}`}
            >
              <div className="mb-2">
                {mediaType === "image"
                  ? <AssetImage asset={{ url: entry.url, thumbnailUrl: entry.thumbnailUrl ?? entry.url }} />
                  : <video className="aspect-video w-full bg-black object-contain" src={entry.url} poster={entry.thumbnailUrl ?? undefined} preload="metadata" muted controls />}
              </div>
              <p className="mb-2 line-clamp-2 text-xs text-[var(--ad-text-muted)]">{entry.description}</p>
              <div className="grid gap-2 text-xs">
                <label className="block">{t("Decision")}
                  <select aria-label={`${t("Decision")} ${entry.id}`} className={`${fieldClass} mt-1`} disabled={busy} value={decision.action} onChange={event => update(entry.id, { action: event.target.value as BatchDraftDecision["action"] })}>
                    <option value="skip">{t("Skip")}</option>
                    <option disabled={!canIndex} value="published">{t("Approve & publish")}</option>
                    <option value="withdrawn">{t("Reject (withdraw)")}</option>
                  </select>
                </label>
                <label className="block">{t("Nudity")}
                  <select aria-label={`${t("Nudity")} ${entry.id}`} className={`${fieldClass} mt-1`} disabled={busy} value={decision.nudity} onChange={event => update(entry.id, { nudity: event.target.value as CharacterMediaLibraryEntry["nudity"] })}>
                    <option value="unknown">{t("Not verified")}</option>
                    <option value="none">{t("No nudity")}</option>
                    <option value="partial">{t("Partial nudity")}</option>
                    <option value="full">{t("Full nudity")}</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">{t("Attire")}
                    <select aria-label={`${t("Attire")} ${entry.id}`} className={`${fieldClass} mt-1`} disabled={busy} value={decision.attireLevel} onChange={event => update(entry.id, { attireLevel: event.target.value })}>
                      <option value="">{t("Unspecified")}</option>
                      <option value="clothed">{t("Clothed")}</option>
                      <option value="swimwear">{t("Swimwear")}</option>
                      <option value="lingerie">{t("Lingerie")}</option>
                      <option value="topless">{t("Topless")}</option>
                      <option value="nude">{t("Nude")}</option>
                    </select>
                  </label>
                  <label className="block">{t("Scope")}
                    <select aria-label={`${t("Scope")} ${entry.id}`} className={`${fieldClass} mt-1`} disabled={busy} value={decision.distributionScope} onChange={event => update(entry.id, { distributionScope: event.target.value as BatchDraftDecision["distributionScope"] })}>
                      <option value="chat_library">{t("Chat library")}</option>
                      <option value="teaser">{t("Teaser only")}</option>
                      <option value="both">{t("Chat + Teaser")}</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BatchPregenPackPanel({ characterId, mediaType, visualIdentity, profiles, sources, onCreated }: {
  characterId: string;
  mediaType: "image" | "video";
  visualIdentity: CharacterMediaLibraryVisualIdentity;
  profiles: readonly ChatPackProfileOption[];
  sources: readonly ChatPackSourceOption[];
  onCreated: (runId: string, count: number) => void;
}) {
  const { t } = useAdminI18n();
  // SPEC: profile 与源图都从角色已有的权威里选，不再手填 —— 手填的 key / ID 只有提交后才会被服务端拒绝。
  const [profileChoice, setProfileChoice] = useState<string | null>(null);
  const profileId = profiles.some(option => option.key === profileChoice) ? profileChoice! : profiles[0]?.key ?? "";
  const [brief, setBrief] = useState("");
  const [directionsText, setDirectionsText] = useState("");
  const [outputsPerDirection, setOutputsPerDirection] = useState(2);
  const [selectedSourceIds, setSelectedSourceIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRunId, setCreatedRunId] = useState<string | null>(null);

  const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
  const directionLines = lines(directionsText);
  // A source that is no longer available drops out instead of being submitted blind.
  const sourceIds = selectedSourceIds.filter(id => sources.some(option => option.assetId === id));
  const MAX_VIDEO_SOURCES = 10;

  const canSubmit = !busy && Boolean(profileId) && brief.trim().length >= 3 && (
    mediaType === "image"
      ? directionLines.length >= 1 && directionLines.length <= 12 && directionLines.length * outputsPerDirection <= 30
      : sourceIds.length >= 1 && sourceIds.length <= MAX_VIDEO_SOURCES
  );

  function toggleSource(assetId: string) {
    setSelectedSourceIds(current => current.includes(assetId)
      ? current.filter(id => id !== assetId)
      : current.length >= MAX_VIDEO_SOURCES ? current : [...current, assetId]);
  }

  async function launchPack() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setCreatedRunId(null);
    try {
      const count = mediaType === "image" ? directionLines.length * outputsPerDirection : sourceIds.length;
      const body = mediaType === "image"
        ? {
            purpose: "character_library_image_pack" as const,
            targetType: "character" as const,
            targetId: characterId,
            profileId,
            count,
            brief: brief.trim(),
            outputsPerDirection,
            directions: directionLines.map((scene, index) => ({
              id: `dir-${index + 1}`,
              title: `Scene ${index + 1}`,
              scenePrompt: scene.length >= 12 ? scene : `${scene} natural portrait scene`,
              mood: "natural",
              setting: "editorial",
              outfit: "matching scene",
              camera: "medium portrait",
              lighting: "natural light",
            })),
            reason: `Batch pre-generate chat library image pack for visual v${visualIdentity.visualProfileVersion}`,
          }
        : {
            purpose: "character_library_video_pack" as const,
            targetType: "character" as const,
            targetId: characterId,
            profileId,
            count,
            brief: brief.trim(),
            referenceAssetIds: [...sourceIds],
            reason: `Batch pre-generate chat library video pack for visual v${visualIdentity.visualProfileVersion}`,
          };
      const result = await adminV2Operation("POST /api/v2/admin/creative/runs", { body });
      if ("skip" in result) throw new Error(t("Pre-generation pack could not be started"));
      const runId = result.batch.id;
      setCreatedRunId(runId);
      onCreated(runId, count);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Pre-generation pack could not be started"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details data-testid="batch-pregen-panel" className="border-t border-[var(--ad-border)] pt-4">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
        <Layers className="h-4 w-4" />
        {mediaType === "image" ? t("Batch pre-generate image pack (up to 30)") : t("Batch pre-generate video pack (up to 10)")}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-[var(--ad-text-muted)]">
          {mediaType === "image"
            ? t("Queue up to 12 scene directions (max 30 total outputs) under visual identity v{version}.", { version: visualIdentity.visualProfileVersion })
            : t("Choose 1–10 Character images (1 video clip per image) under visual identity v{version}.", { version: visualIdentity.visualProfileVersion })}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {mediaType === "video" ? (
            <div className="text-sm">
              <span className="block">{t("Generation profile")}</span>
              <span className="mt-1 block font-semibold" data-testid="pack-fixed-profile">{profiles[0] ? t(profiles[0].label) : "—"}</span>
              <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">{t("Character video packs always use the default video production route.")}</span>
            </div>
          ) : profiles.length > 0 ? (
            <label className="block text-sm">{t("Generation profile")}
              <select className={`${fieldClass} mt-1`} disabled={busy} value={profileId} onChange={event => setProfileChoice(event.target.value)}>
                {profiles.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
          ) : (
            <p role="status" className="text-sm text-[var(--ad-yellow-text)]">
              {t("No qualified, unexpired image route is available. Qualify a generation route in Visual identity first.")}
            </p>
          )}
          <label className="block text-sm">{t("Pack brief")}
            <input className={`${fieldClass} mt-1`} value={brief} onChange={event => setBrief(event.target.value)} placeholder={mediaType === "image" ? "Everyday lifestyle chat photos" : "Subtle smile and natural motion"} />
          </label>
        </div>
        {mediaType === "image" ? (
          <>
            <label className="block text-sm">{t("Scene directions (one per line, 1–12 lines)")}
              <textarea className={`${fieldClass} mt-1 min-h-24`} value={directionsText} onChange={event => setDirectionsText(event.target.value)} placeholder={"Morning coffee beside a sunny kitchen window\nEvening rooftop cocktail dress with warm bokeh lights"} />
            </label>
            <label className="block text-sm">{t("Outputs per direction")}
              <input type="number" min={1} max={10} className={`${fieldClass} mt-1 w-28`} value={outputsPerDirection} onChange={event => setOutputsPerDirection(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} />
            </label>
          </>
        ) : sources.length === 0 ? (
          <p role="status" className="text-sm text-[var(--ad-yellow-text)]">{t("This Character has no available images to animate yet.")}</p>
        ) : (
          <fieldset>
            <legend className="text-sm">{t("Source images ({selected} of up to {max} selected)", { selected: sourceIds.length, max: MAX_VIDEO_SOURCES })}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
              {sources.map(option => {
                const checked = sourceIds.includes(option.assetId);
                return (
                  <label key={option.assetId} className={`flex cursor-pointer flex-col gap-1 rounded-md border p-1.5 text-xs ${checked ? "border-[var(--ad-ink)] ring-1 ring-[var(--ad-ink)]" : "border-[var(--ad-border)]"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- the source is an authorized media render URL */}
                    <img alt="" className="aspect-square w-full rounded object-cover" src={option.thumbnailUrl ?? option.url} />
                    <span className="flex items-center gap-1.5">
                      <input
                        checked={checked}
                        disabled={busy || (!checked && sourceIds.length >= MAX_VIDEO_SOURCES)}
                        onChange={() => toggleSource(option.assetId)}
                        type="checkbox"
                        value={option.assetId}
                      />
                      <span className="truncate">{t(option.label, option.labelValues)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <WorkspaceButton tone="primary" disabled={!canSubmit} onClick={() => void launchPack()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
            {t("Start batch pack")}
          </WorkspaceButton>
          {createdRunId ? (
            <a className="text-sm font-semibold underline" href={`/admin/creative/runs/${encodeURIComponent(createdRunId)}`}>
              {t("View Creative Run")}
            </a>
          ) : null}
        </div>
        {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      </div>
    </details>
  );
}

function splitFacts(value: string) { return [...new Set(value.split("\n").map(fact => fact.trim()).filter(Boolean))]; }
function factsValid(value: string) { const facts = splitFacts(value); return facts.length <= 48 && facts.every(fact => fact.length <= 160); }
