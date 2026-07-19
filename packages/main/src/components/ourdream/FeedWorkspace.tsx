"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Flag, Heart, Images, MessageCircle, RefreshCcw, Repeat2, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseFeedResponse,
  type PublicFeedItem,
} from "@/lib/public-api-contracts";
import { shouldBypassNextImageOptimizer } from "@/lib/image-delivery";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";

type FeedCharacterItem = Extract<PublicFeedItem, { type: "character" }>;
type FeedCollectionItem = Extract<PublicFeedItem, { type: "collection" }>;
type FeedItem = PublicFeedItem;

const FEED_PAGE_SIZE = 8;

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

type FeedActionPayload = {
  ok?: boolean;
  data?: {
    items?: FeedItem[];
    nextCursor?: string | null;
    cursor?: string | null;
    focusedItemId?: string | null;
    shareUrl?: string;
    remixUrl?: string;
  };
  error?: { message?: string };
};

export function FeedWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const searchParams = useSearchParams();
  const sharedItemId = searchParams.get("item")?.trim() ?? "";
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState("");
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
      );
      if (requestSerial !== requestSerialRef.current) return;
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
        setStatus(nextFocusedItemId ? "Showing shared dream." : "");
      }
      setItems((current) => (cursor ? [...current, ...fresh] : fresh));
      setLikedIds((current) => {
        const next = cursor ? new Set(current) : new Set<string>();
        for (const item of fresh) {
          if (item.type === "character" && item.character.liked) next.add(item.id);
        }
        return next;
      });
      setNextCursor(payload.data.nextCursor);
      setSnapshotStale(false);
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestSerial !== requestSerialRef.current
      ) {
        return;
      }
      const message =
        error instanceof FeedLoadError ? error.message : "Feed unavailable.";
      if (cursor) {
        setStatus("Could not load more dreams. Showing the loaded results.");
      } else if (loadedScopeRef.current !== null) {
        setSnapshotStale(true);
        setStatus(`${message} Showing the last loaded results.`);
      } else {
        setStatus(message);
      }
    } finally {
      if (requestSerial !== requestSerialRef.current) return;
      if (cursor) setLoadingMore(false);
      else setLoading(false);
    }
  }, [ageGateAccepted, sharedItemId]);

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
  }, [ageGateAccepted, loadFeed]);

  async function startChat(characterId: string) {
    try {
      const response = await fetch("/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId }),
      });
      const payload = (await response.json()) as {
        data?: { session?: { id: string } };
        error?: { message?: string };
      };
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
    } catch {
      setStatus("Could not start chat. Please try again.");
    }
  }

  // 切换点赞：乐观更新 + 单飞，防止重复点击虚增计数；失败回滚。
  async function toggleLike(itemId: string) {
    if (likePending.has(itemId)) return;
    const liked = likedIds.has(itemId);
    setLikePending((current) => new Set(current).add(itemId));
    setLikedIds((current) => {
      const next = new Set(current);
      if (liked) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    try {
      const response = await fetch(`/api/v1/feed/items/${encodeURIComponent(itemId)}/like`, {
        method: liked ? "DELETE" : "POST",
      });
      const payload = (await response.json()) as FeedActionPayload;
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
        setStatus(payload.error?.message ?? "like failed");
      }
    } catch {
      setLikedIds((current) => {
        const next = new Set(current);
        if (liked) next.add(itemId);
        else next.delete(itemId);
        return next;
      });
      setStatus("like failed");
    } finally {
      setLikePending((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }

  async function remix(item: FeedCharacterItem) {
    setStatus("Preparing remix...");
    try {
      const response = await fetch(`/api/v1/feed/items/${encodeURIComponent(item.id)}/remix`, {
        method: "POST",
      });
      const payload = (await response.json()) as FeedActionPayload;
      const remixUrl = payload.data?.remixUrl;
      if (!response.ok || payload.ok !== true || !remixUrl) {
        setStatus(payload.error?.message ?? "Remix unavailable.");
        return;
      }
      window.location.assign(remixUrl);
    } catch {
      setStatus("Remix unavailable.");
    }
  }

  async function action(itemId: string, name: "share" | "report") {
    try {
      const response = await fetch(`/api/v1/feed/items/${encodeURIComponent(itemId)}/${name}`, {
        method: "POST",
        headers: name === "report" ? { "content-type": "application/json" } : undefined,
        body:
          name === "report"
            ? JSON.stringify({ category: "other_prohibited_content", description: "Feed report" })
            : undefined,
      });
      const payload = (await response.json()) as FeedActionPayload;
      if (!response.ok || payload.ok !== true) {
        setStatus(payload.error?.message ?? `${name} failed`);
        return;
      }
      if (name === "share") {
        if (!payload.data?.shareUrl) {
          setStatus("Share unavailable.");
          return;
        }
        const shareUrl = new URL(payload.data.shareUrl, window.location.origin).toString();
        const copied = await copyShareUrl(shareUrl);
        setStatus(copied ? "Share link copied." : `Share link: ${shareUrl}`);
        return;
      }
      setStatus("Report submitted.");
    } catch {
      setStatus(`${name} failed`);
    }
  }

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
              Feed
            </p>
            <h1 className="mt-2 text-[40px] font-black uppercase leading-none text-white">
              Recommended Dreams
            </h1>
          </div>
          <button
            className="inline-flex h-10 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
            disabled={loading || loadingMore}
            onClick={() => {
              setStatus("");
              void loadFeed();
            }}
            type="button"
          >
            <RefreshCcw className="h-4 w-4" />
            Restart
          </button>
        </div>
        {status && (
          <p
            aria-live="polite"
            className="mb-5 rounded-[12px] bg-[rgb(36,36,36)] px-4 py-3 text-[13px] font-semibold text-[rgb(220,220,220)]"
            data-testid="feed-status"
            role="status"
          >
            {status}
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
                  onReport={() => action(item.id, "report")}
                  onShare={() => action(item.id, "share")}
                  onStartChat={() => startChat(item.character.id)}
                />
              ) : (
                <CollectionFeedCard
                  eager={index < 4}
                  focused={item.id === focusedItemId}
                  item={item}
                  onReport={() => action(item.id, "report")}
                  onShare={() => action(item.id, "share")}
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
        {loading && items.length === 0 && (
          <p className="mt-6 text-[13px] font-medium text-[rgb(170,170,170)]">Loading feed…</p>
        )}
        {!loading && items.length === 0 && !status && (
          <div className="mt-6 rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-center text-[13px] font-medium text-[rgb(170,170,170)]">
            No dreams yet. <Link className="underline" href="/explore">Explore characters</Link> to get started.
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
          {item.collection.previews.slice(0, 4).map((src, previewIndex) => (
            <div className="relative overflow-hidden bg-[rgb(36,36,36)]" key={`${item.id}-${src}`}>
              <Image
                alt=""
                className="object-cover"
                fill
                loading={eager && previewIndex === 0 ? "eager" : "lazy"}
                sizes="240px"
                src={src}
                unoptimized={shouldBypassNextImageOptimizer(src)}
              />
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

async function copyShareUrl(url: string) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

class FeedLoadError extends Error {}

async function fetchFeedPayload(
  cursor?: string,
  sharedItemId?: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  params.set("limit", String(FEED_PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  if (sharedItemId) params.set("item", sharedItemId);
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`/api/v1/feed${query}`, { signal });
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

function signupUrlForFeedChat(characterId: string) {
  const next = `/characters/${encodeURIComponent(characterId)}`;
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
