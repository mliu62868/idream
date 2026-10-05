"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Flag, Heart, Images, MessageCircle, RefreshCcw, Repeat2, Share2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  parseFeedResponse,
  type PublicFeedItem,
} from "@/lib/public-api-contracts";
import { shouldBypassNextImageOptimizer } from "@/lib/image-delivery";
import { shareOrCopy } from "@/lib/utils";
import { useViewerGate, ViewerGateError, type ViewerGate, type ViewerIdentity } from "@/hooks/useViewerGate";
import { isAbortError, type ResourceFetcher } from "@/lib/viewer-resource-client";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { countLabel } from "./workspace-helpers";
import { feedLoadFailure, shouldApplyFeedResponse } from "./feed-load-state";
import { useReportDialog } from "./ReportDialog";
import { ComicDiscovery } from "./ComicCatalog";
import { VIEWER_UNCONFIRMED_MESSAGE } from "./viewer-auth";

type FeedCharacterItem = Extract<PublicFeedItem, { type: "character" }>;
type FeedCollectionItem = Extract<PublicFeedItem, { type: "collection" }>;
type FeedItem = PublicFeedItem;

const FEED_PAGE_SIZE = 8;

type FeedActionPayload = {
  ok?: boolean;
  data?: {
    items?: FeedItem[];
    nextCursor?: string | null;
    cursor?: string | null;
    focusedItemId?: string | null;
    shareUrl?: string;
    remixUrl?: string;
    liked?: boolean;
  };
  error?: { message?: string };
};

export function FeedWorkspace() {
  const viewer = useViewerGate({ require: "any" });
  // The personalized cards, cursors, optimistic actions and report dialog all
  // belong to one confirmed actor. An account change discards the whole subtree.
  return <FeedViewerWorkspace key={viewer.scope ?? (viewer.identity ? "anonymous" : "unconfirmed")} viewer={viewer} />;
}

function FeedViewerWorkspace({ viewer }: { viewer: ViewerGate }) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const gatedFetch = viewer.fetch;
  const searchParams = useSearchParams();
  const sharedItemId = searchParams.get("item")?.trim() ?? "";
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState("");
  const [loadStatus, setLoadStatus] = useState("");
  const { openReport, reportDialog } = useReportDialog(setStatus);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [likePending, setLikePending] = useState<ReadonlySet<string>>(() => new Set());
  const [snapshotStale, setSnapshotStale] = useState(false);
  const requestSerialRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const loadedScopeRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const likePendingRef = useRef(new Set<string>());

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadFeed = useCallback(async (cursor?: string) => {
    if (!ageGateAccepted) return;
    const requestSerial = requestSerialRef.current + 1;
    requestSerialRef.current = requestSerial;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const requestedItemId = sharedItemId;
    if (
      !cursor &&
      loadedScopeRef.current !== null &&
      loadedScopeRef.current !== requestedItemId
    ) {
      loadedScopeRef.current = null;
      setItems([]);
      setLikedIds(new Set());
      setNextCursor(null);
      setFocusedItemId(null);
    }
    if (cursor) {
      setLoading(false);
      setLoadingMore(true);
    } else {
      setLoadingMore(false);
      setLoading(true);
    }
    try {
      const payload = await fetchFeedPayload(
        cursor,
        requestedItemId,
        controller.signal,
        gatedFetch,
      );
      if (!shouldApplyFeedResponse({
        requestSerial,
        currentSerial: requestSerialRef.current,
        aborted: controller.signal.aborted,
      })) return;
      if (payload.ok === false) {
        throw new FeedLoadError(
          payload.error?.message ?? "Accept the age gate to view feed.",
        );
      }
      const fresh = payload.data.items;
      if (!cursor) {
        loadedScopeRef.current = requestedItemId;
        const nextFocusedItemId = payload.data.focusedItemId;
        setFocusedItemId(nextFocusedItemId);
        setLoadStatus(nextFocusedItemId ? "Showing shared dream." : "");
      }
      setItems((current) => (cursor ? [...current, ...fresh] : fresh));
      setLikedIds((current) => {
        const next = cursor ? new Set(current) : new Set<string>();
        for (const item of fresh) {
          if (item.type === "character" && item.character.liked) next.add(item.id);
        }
        // A confirmation refresh may finish before a like. Keep that optimistic
        // choice until its own authoritative response settles or rolls it back.
        for (const id of likePendingRef.current) {
          if (current.has(id)) next.add(id);
          else next.delete(id);
        }
        return next;
      });
      setNextCursor(payload.data.nextCursor);
      setSnapshotStale(false);
    } catch (error) {
      if (isAbortError(error)) return;
      if (!shouldApplyFeedResponse({
        requestSerial,
        currentSerial: requestSerialRef.current,
        aborted: controller.signal.aborted,
      })) return;
      const message =
        error instanceof FeedLoadError ? error.message : "Feed unavailable.";
      const failure = feedLoadFailure({
        message,
        loadingMore: Boolean(cursor),
        hasSnapshot: loadedScopeRef.current !== null,
      });
      setSnapshotStale(failure.snapshotStale);
      setLoadStatus(failure.status);
    } finally {
      if (!shouldApplyFeedResponse({
        requestSerial,
        currentSerial: requestSerialRef.current,
        aborted: controller.signal.aborted,
      })) return;
      if (cursor) setLoadingMore(false);
      else setLoading(false);
    }
  }, [ageGateAccepted, gatedFetch, sharedItemId]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => void loadFeed(), 0);
    // 接受年龄门后，feed 后端会放行内容：监听事件并重新拉取，避免停留在旧的拦截态。
    function reload() {
      setStatus("");
      void loadFeed();
    }
    window.addEventListener("idream-age-gate-accepted", reload);
    return () => {
      window.clearTimeout(timer);
      requestControllerRef.current?.abort();
      window.removeEventListener("idream-age-gate-accepted", reload);
    };
  }, [ageGateAccepted, loadFeed, viewer.revalidation]);

  async function fetchForViewer(input: RequestInfo | URL, init?: RequestInit) {
    const expected = viewer.identity;
    const matches = (identity: ViewerIdentity | null) => expected !== null && identity !== null &&
      expected.kind === identity.kind && (expected.kind !== "user" || (identity.kind === "user" && expected.scope === identity.scope));
    // A cookie can move before the focus event. The request must still be for
    // the actor whose cards the user acted on, and late receipts cannot migrate.
    const before = await viewer.revalidate();
    if (!mountedRef.current) throw new ViewerGateError();
    if (!before) throw new Error(VIEWER_UNCONFIRMED_MESSAGE);
    if (!matches(before)) throw new ViewerGateError();
    const response = await gatedFetch(input, init);
    const after = await viewer.revalidate();
    if (!mountedRef.current) throw new ViewerGateError();
    if (!after) throw new Error(VIEWER_UNCONFIRMED_MESSAGE);
    if (!matches(after)) throw new ViewerGateError();
    return response;
  }

  async function startChat(characterId: string) {
    if (viewer.identity?.kind === "anonymous") {
      window.location.assign(signupUrlForFeedChat(characterId));
      return;
    }
    try {
      const response = await fetchForViewer("/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId }),
      });
      const payload = (await response.json()) as {
        data?: { session?: { id: string } };
        error?: { message?: string };
      };
      if (!mountedRef.current) return;
      if (payload.data?.session?.id) {
        window.location.assign(`/chat/${payload.data.session.id}`);
        return;
      }
      // 仅当确实是未登录时送去注册；其它错误（如 403/503）保留真实恢复信息。
      if (response.status === 401) {
        window.location.assign(signupUrlForFeedChat(characterId));
      } else if (response.status === 403) {
        setStatus("Accept the age gate before starting chat.");
      } else {
        setStatus(payload.error?.message ?? "Could not start chat. Please try again.");
      }
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return;
      setStatus("Could not start chat. Please try again.");
    }
  }

  // 切换点赞：乐观更新 + 单飞，防止重复点击虚增计数；失败回滚。
  async function toggleLike(itemId: string) {
    if (viewer.identity?.kind === "anonymous") {
      window.location.assign(authHrefForTarget("/signup", feedItemReturnTarget(itemId)));
      return;
    }
    if (likePendingRef.current.has(itemId)) return;
    const liked = likedIds.has(itemId);
    likePendingRef.current.add(itemId);
    setLikePending((current) => new Set(current).add(itemId));
    setLikedIds((current) => {
      const next = new Set(current);
      if (liked) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    try {
      const response = await fetchForViewer(`/api/v1/feed/items/${encodeURIComponent(itemId)}/like`, {
        method: liked ? "DELETE" : "POST",
      });
      const payload = (await response.json()) as FeedActionPayload;
      if (!mountedRef.current) return;
      if (!response.ok || payload.ok !== true) {
        setLikedIds((current) => {
          const next = new Set(current);
          if (liked) next.add(itemId);
          else next.delete(itemId);
          return next;
        });
        if (response.status === 401) {
          window.location.assign(authHrefForTarget("/signup", feedItemReturnTarget(itemId)));
          return;
        }
        setStatus(payload.error?.message ?? "Could not save your like. Please try again.");
      } else {
        setLikedIds((current) => {
          const next = new Set(current);
          if (payload.data?.liked ?? !liked) next.add(itemId);
          else next.delete(itemId);
          return next;
        });
      }
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return;
      setLikedIds((current) => {
        const next = new Set(current);
        if (liked) next.add(itemId);
        else next.delete(itemId);
        return next;
      });
      setStatus("Could not save your like. Please try again.");
    } finally {
      if (mountedRef.current) {
        likePendingRef.current.delete(itemId);
        setLikePending((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      }
    }
  }

  async function remix(item: FeedCharacterItem) {
    setStatus("Preparing remix...");
    try {
      const response = await fetchForViewer(`/api/v1/feed/items/${encodeURIComponent(item.id)}/remix`, {
        method: "POST",
      });
      const payload = (await response.json()) as FeedActionPayload;
      if (!mountedRef.current) return;
      const remixUrl = payload.data?.remixUrl;
      if (!response.ok || payload.ok !== true || !remixUrl) {
        setStatus(payload.error?.message ?? "Remix unavailable.");
        return;
      }
      window.location.assign(remixUrl);
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return;
      setStatus("Remix unavailable.");
    }
  }

  async function share(itemId: string) {
    try {
      const response = await fetchForViewer(`/api/v1/feed/items/${encodeURIComponent(itemId)}/share`, {
        method: "POST",
      });
      const payload = (await response.json()) as FeedActionPayload;
      if (!mountedRef.current) return;
      if (!response.ok || payload.ok !== true || !payload.data?.shareUrl) {
        setStatus(payload.error?.message ?? "Share unavailable.");
        return;
      }
      const message = await shareOrCopy(new URL(payload.data.shareUrl, window.location.origin).toString(), "iDream");
      if (mountedRef.current) setStatus(message);
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return;
      setStatus("Could not share this item. Please try again.");
    }
  }

  const displayedStatus = status || viewer.error || loadStatus;
  function retryFeed() {
    setStatus("");
    if (viewer.error) void viewer.revalidate();
    else void loadFeed();
  }

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-5xl">
        {/* 手机端（390px）标题与 Restart 并排放不下：标题容器没有 min-w-0 就不肯收缩，
            把按钮整个顶出视口，整页横向溢出 63px。允许换行 + 允许标题收缩即可，
            桌面端宽度足够时行为不变。 */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
              Feed
            </p>
            <h1 className="mt-2 text-[40px] font-black uppercase leading-none text-white">
              Recommended Dreams
            </h1>
          </div>
          <button
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
            disabled={(loading || loadingMore) && !viewer.error}
            onClick={retryFeed}
            type="button"
          >
            <RefreshCcw className="h-4 w-4" />
            Restart
          </button>
        </div>
        {displayedStatus && (
          <p
            aria-live="polite"
            className="mb-5 rounded-[12px] bg-[rgb(36,36,36)] px-4 py-3 text-[13px] font-semibold text-[rgb(220,220,220)]"
            data-testid="feed-status"
            role="status"
          >
            {displayedStatus}
          </p>
        )}
        <div
          className="grid gap-4 md:grid-cols-2"
          data-stale={snapshotStale ? "true" : "false"}
        >
          {items.map((item, index) => (
            <article
              className={`overflow-hidden rounded-[16px] border bg-[rgb(18,18,18)] ${
                item.id === focusedItemId
                  ? "border-[rgb(253,95,194)] shadow-[0_0_0_1px_rgba(253,95,194,0.55)]"
                  : "border-white/10"
              }`}
              data-focused={item.id === focusedItemId ? "true" : "false"}
              data-testid={item.type === "collection" ? "feed-collection-card" : "feed-character-card"}
              key={item.id}
            >
              {item.type === "character" ? (
                <CharacterFeedCard
                  eager={index < 4}
                  focused={item.id === focusedItemId}
                  item={item}
                  liked={likedIds.has(item.id)}
                  likePending={likePending.has(item.id)}
                  onLike={() => toggleLike(item.id)}
                  onRemix={() => void remix(item)}
                  onReport={() => openReport({ kind: "feedItem", id: item.id })}
                  onShare={() => share(item.id)}
                  onStartChat={() => startChat(item.character.id)}
                />
              ) : (
                <CollectionFeedCard
                  eager={index < 4}
                  focused={item.id === focusedItemId}
                  item={item}
                  onReport={() => openReport({ kind: "feedItem", id: item.id })}
                  onShare={() => share(item.id)}
                />
              )}
              {item.id === focusedItemId && (
                <p className="px-3 pt-3 text-[11px] font-black uppercase text-[rgb(253,95,194)]">
                  Shared dream
                </p>
              )}
            </article>
          ))}
        </div>
        {loading && !viewer.error && items.length === 0 && (
          <p className="mt-6 text-[13px] font-medium text-[rgb(170,170,170)]">Loading feed…</p>
        )}
        {!loading && items.length === 0 && !displayedStatus && (
          <div className="mt-6 rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-center text-[13px] font-medium text-[rgb(170,170,170)]">
            No dreams yet. <Link className="underline" href="/explore">Explore characters</Link> to get started.
          </div>
        )}
        {/* SPEC: 加载失败且一条都没拿到时，要给一张有出口的卡片，不是一条灰条。
            INTENT: 原先失败只渲染上面那条 `feed-status` pill —— 没有标题、没有重试。
            页头的 Restart 虽然能重试，但它在手机上会被挤出视口（见同文件页头的
            min-w-0 修复），于是「出错了 + 没有出口」在小屏上同时成立。空状态本来
            就有 CTA，错误态没道理没有。 */}
        {(!loading || viewer.error) && items.length === 0 && Boolean(displayedStatus) && (
          <div
            className="mt-6 rounded-[12px] border border-[rgb(255,184,112)]/30 bg-[rgb(18,18,18)] p-6 text-center"
            data-testid="feed-error"
            role="alert"
          >
            <p className="text-[15px] font-black uppercase text-white">
              Feed could not load
            </p>
            <p className="mx-auto mt-2 max-w-md text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
              {displayedStatus}
            </p>
            <button
              className="mt-5 inline-flex h-11 items-center justify-center rounded-full bg-white px-6 text-[13px] font-black text-[rgb(13,13,13)] disabled:opacity-60"
              disabled={(loading || loadingMore) && !viewer.error}
              onClick={retryFeed}
              type="button"
            >
              Try again
            </button>
          </div>
        )}
        {!loading && nextCursor && (
          <div className="flex h-24 items-center justify-center">
            <button
              className="inline-flex h-11 min-w-44 items-center justify-center rounded-full bg-white px-6 text-[13px] font-black text-[rgb(13,13,13)] disabled:opacity-60"
              disabled={loadingMore}
              onClick={() => {
                if (nextCursor) void loadFeed(nextCursor);
              }}
              type="button"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        )}
      </div>
      <div className="mx-auto max-w-5xl"><ComicDiscovery compact /></div>
      {reportDialog}
    </section>
  );
}

function CharacterFeedCard({
  eager,
  item,
  liked,
  likePending,
  onLike,
  onRemix,
  onReport,
  onShare,
  onStartChat,
}: Readonly<{
  eager: boolean;
  focused: boolean;
  item: FeedCharacterItem;
  liked: boolean;
  likePending: boolean;
  onLike: () => void;
  onRemix: () => void;
  onReport: () => void;
  onShare: () => void;
  onStartChat: () => void;
}>) {
  return (
    <>
      <Link className="relative block aspect-[16/11]" href={`/characters/${item.character.id}`}>
        <Image
          alt=""
          className="object-cover object-top"
          fill
          loading={eager ? "eager" : "lazy"}
          sizes="480px"
          src={item.character.image}
          unoptimized={shouldBypassNextImageOptimizer(item.character.image)}
        />
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.82),rgba(0,0,0,.12)_65%,transparent)]" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <h2 className="text-[24px] font-black uppercase leading-7">
            {item.character.title} <span>{item.character.age}</span>
          </h2>
          <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-5 text-[rgb(220,220,220)]">
            {item.character.description}
          </p>
        </div>
      </Link>
      {item.character.creatorId && item.character.creatorName && (
        <Link
          className="block px-3 pt-3 text-[12px] font-semibold text-[rgb(170,170,170)] hover:text-white"
          href={`/creators/${item.character.creatorId}`}
        >
          by {item.character.creatorName}
        </Link>
      )}
      <div className="grid grid-cols-5 gap-2 p-3">
        <ActionButton icon={<MessageCircle className="h-4 w-4" />} label="Chat" onClick={onStartChat} />
        <ActionButton icon={<Repeat2 className="h-4 w-4" />} label="Remix" onClick={onRemix} />
        <ActionButton
          active={liked}
          disabled={likePending}
          icon={<Heart className={`h-4 w-4 ${liked ? "fill-current" : ""}`} />}
          label={liked ? "Liked" : "Like"}
          onClick={onLike}
          pressed={liked}
        />
        <ActionButton icon={<Share2 className="h-4 w-4" />} label="Share" onClick={onShare} />
        <ActionButton icon={<Flag className="h-4 w-4" />} label="Report" onClick={onReport} />
      </div>
    </>
  );
}

function CollectionFeedCard({
  eager,
  item,
  onReport,
  onShare,
}: Readonly<{
  eager: boolean;
  focused: boolean;
  item: FeedCollectionItem;
  onReport: () => void;
  onShare: () => void;
}>) {
  const collectionHref = communityCollectionHref(item.collection.id);
  return (
    <>
      <Link className="relative block aspect-[16/11]" href={collectionHref}>
        <div className="absolute inset-0 grid grid-cols-2 gap-1 bg-[rgb(28,28,28)]">
          {item.collection.previews.slice(0, 4).map((preview, previewIndex) => (
            <div className="relative overflow-hidden bg-[rgb(36,36,36)]" key={`${item.id}-${preview.id}`}>
              {preview.type === "image" ? <Image
                alt=""
                className="object-cover"
                fill
                loading={eager && previewIndex === 0 ? "eager" : "lazy"}
                sizes="240px"
                src={preview.url}
                unoptimized={shouldBypassNextImageOptimizer(preview.url)}
              /> : <span className="grid h-full place-items-center text-sm text-white/70">{preview.type === "video" ? "Video" : "Audio"}</span>}
            </div>
          ))}
          {Array.from({
            length: Math.max(0, 4 - item.collection.previews.slice(0, 4).length),
          }).map((_, index) => (
            <div
              className="grid place-items-center bg-[rgb(36,36,36)] text-[rgb(120,120,120)]"
              key={`${item.id}-empty-${index}`}
            >
              <Images className="h-5 w-5" />
            </div>
          ))}
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.86),rgba(0,0,0,.16)_65%,transparent)]" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.08em] text-[rgb(253,95,194)]">
            Creator collection
          </p>
          <h2 className="line-clamp-2 text-[24px] font-black uppercase leading-7">
            {item.collection.name}
          </h2>
          <p className="mt-2 text-[13px] font-semibold text-[rgb(220,220,220)]">
            {countLabel(item.collection.itemCount, "item")} · by{" "}
            {item.collection.ownerName ?? "Dreamer"}
          </p>
        </div>
      </Link>
      <div className="grid grid-cols-3 gap-2 p-3">
        <ActionLink href={collectionHref} icon={<Images className="h-4 w-4" />} label="View" />
        <ActionButton icon={<Share2 className="h-4 w-4" />} label="Share" onClick={onShare} />
        <ActionButton icon={<Flag className="h-4 w-4" />} label="Report" onClick={onReport} />
      </div>
    </>
  );
}

class FeedLoadError extends Error {}

async function fetchFeedPayload(
  cursor: string | undefined,
  sharedItemId: string,
  signal: AbortSignal,
  fetcher: ResourceFetcher,
) {
  const params = new URLSearchParams();
  params.set("limit", String(FEED_PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  if (sharedItemId) params.set("item", sharedItemId);
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await fetcher(`/api/v1/feed${query}`, { signal, cache: "no-store" });
  const payload: unknown = await response.json();
  if (!response.ok) {
    return {
      ok: false as const,
      error: { message: publicApiErrorMessage(payload) },
    };
  }
  return {
    ok: true as const,
    data: parseFeedResponse(payload),
  };
}

function publicApiErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

// resume=chat: the character page starts the chat the guest asked for once they are back.
function signupUrlForFeedChat(characterId: string) {
  const next = `/characters/${encodeURIComponent(characterId)}?resume=chat`;
  return `/signup?next=${encodeURIComponent(next)}`;
}

function feedItemReturnTarget(itemId: string) {
  return `/feed?item=${encodeURIComponent(itemId)}`;
}

function communityCollectionHref(collectionId: string) {
  return `/community?collection=${encodeURIComponent(collectionId)}`;
}

function actionClass(active = false) {
  return `inline-flex h-10 items-center justify-center gap-1 rounded-full text-[12px] font-bold disabled:opacity-60 ${
    active ? "bg-[rgb(253,95,194)] text-[rgb(13,13,13)]" : "bg-[rgb(36,36,36)] text-white"
  }`;
}

function ActionLink({
  href,
  icon,
  label,
}: Readonly<{
  href: string;
  icon: React.ReactNode;
  label: string;
}>) {
  return (
    <Link aria-label={label} className={actionClass()} href={href} title={label}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}

function ActionButton({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
  pressed,
}: Readonly<{
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}>) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={actionClass(active)}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
