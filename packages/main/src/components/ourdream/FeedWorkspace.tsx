"use client";

import Image from "next/image";
import Link from "next/link";
import { Flag, Heart, MessageCircle, RefreshCcw, Repeat2, Share2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type FeedItem = {
  id: string;
  type: "character";
  character: {
    id: string;
    title: string;
    age: string;
    description: string;
    image: string;
    likes: string;
    chats: string;
    creator: string;
    creatorId?: string | null;
    creatorName?: string | null;
  };
};

type FeedPayload = {
  ok?: boolean;
  data?: {
    items?: FeedItem[];
    nextCursor?: string | null;
    cursor?: string | null;
    shareUrl?: string;
    remixUrl?: string;
  };
  error?: { message?: string };
};

export function FeedWorkspace() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [likePending, setLikePending] = useState<ReadonlySet<string>>(() => new Set());

  const loadFeed = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const payload = await fetchFeedPayload(cursor);
      if (payload.ok === false) {
        setStatus(payload.error?.message ?? "Accept the age gate to view feed.");
        return;
      }
      const fresh = payload.data?.items ?? [];
      setItems((current) => (cursor ? [...current, ...fresh] : fresh));
      setNextCursor(payload.data?.nextCursor ?? null);
    } catch {
      setStatus(cursor ? "Could not load more dreams." : "Feed unavailable.");
    } finally {
      if (cursor) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFeed(), 0);
    // 接受年龄门后，feed 后端会放行内容：监听事件并重新拉取，避免停留在旧的拦截态。
    function reload() {
      setStatus("");
      void loadFeed();
    }
    window.addEventListener("idream-age-gate-accepted", reload);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("idream-age-gate-accepted", reload);
    };
  }, [loadFeed]);

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
      // 仅当确实是鉴权失败（401/403）时提示登录；其它错误（如 503）暴露真实信息。
      if (response.status === 401 || response.status === 403) {
        setStatus("Sign in to start chat.");
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
      const payload = (await response.json()) as FeedPayload;
      if (!response.ok || payload.ok === false) {
        setLikedIds((current) => {
          const next = new Set(current);
          if (liked) next.add(itemId);
          else next.delete(itemId);
          return next;
        });
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

  async function action(itemId: string, name: "share" | "remix" | "report") {
    const response = await fetch(`/api/v1/feed/items/${encodeURIComponent(itemId)}/${name}`, {
      method: "POST",
      headers: name === "report" ? { "content-type": "application/json" } : undefined,
      body:
        name === "report"
          ? JSON.stringify({ category: "other_prohibited_content", description: "Feed report" })
          : undefined,
    });
    const payload = (await response.json()) as FeedPayload;
    if (!response.ok || payload.ok === false) {
      setStatus(payload.error?.message ?? `${name} failed`);
      return;
    }
    if (payload.data?.remixUrl) window.location.assign(payload.data.remixUrl);
    else setStatus(payload.data?.shareUrl ?? `${name} saved.`);
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
          >
            {status}
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <article
              className="overflow-hidden rounded-[16px] border border-white/10 bg-[rgb(18,18,18)]"
              key={item.id}
            >
              <Link className="relative block aspect-[16/11]" href={`/characters/${item.character.id}`}>
                <Image
                  alt=""
                  className="object-cover object-top"
                  fill
                  sizes="480px"
                  src={item.character.image}
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
                <ActionButton icon={<MessageCircle className="h-4 w-4" />} label="Chat" onClick={() => startChat(item.character.id)} />
                <ActionButton icon={<Repeat2 className="h-4 w-4" />} label="Remix" onClick={() => action(item.id, "remix")} />
                <ActionButton
                  active={likedIds.has(item.id)}
                  disabled={likePending.has(item.id)}
                  icon={<Heart className={`h-4 w-4 ${likedIds.has(item.id) ? "fill-current" : ""}`} />}
                  label={likedIds.has(item.id) ? "Liked" : "Like"}
                  onClick={() => toggleLike(item.id)}
                />
                <ActionButton icon={<Share2 className="h-4 w-4" />} label="Share" onClick={() => action(item.id, "share")} />
                <ActionButton icon={<Flag className="h-4 w-4" />} label="Report" onClick={() => action(item.id, "report")} />
              </div>
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

async function fetchFeedPayload(cursor?: string) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(`/api/v1/feed${query}`);
  const payload = (await response.json()) as FeedPayload;
  return response.ok ? payload : { ...payload, ok: false };
}

function ActionButton({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
}: Readonly<{
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}>) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-10 items-center justify-center gap-1 rounded-full text-[12px] font-bold disabled:opacity-60 ${
        active ? "bg-[rgb(253,95,194)] text-[rgb(13,13,13)]" : "bg-[rgb(36,36,36)] text-white"
      }`}
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
