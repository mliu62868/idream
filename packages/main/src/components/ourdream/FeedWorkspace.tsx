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

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await fetchFeedPayload();
      if (payload.ok === false) {
        setStatus(payload.error?.message ?? "Accept the age gate to view feed.");
        return;
      }
      setItems(payload.data?.items ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchFeedPayload()
      .then((payload) => {
        if (!alive) return;
        if (payload.ok === false) {
          setStatus(payload.error?.message ?? "Accept the age gate to view feed.");
          return;
        }
        setItems(payload.data?.items ?? []);
      })
      .catch(() => {
        if (alive) setStatus("Feed unavailable.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  async function startChat(characterId: string) {
    const response = await fetch("/api/v1/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId }),
    });
    const payload = (await response.json()) as { data?: { session?: { id: string } } };
    if (payload.data?.session?.id) window.location.assign(`/chat/${payload.data.session.id}`);
    else setStatus("Sign in to start chat.");
  }

  async function action(itemId: string, name: "like" | "share" | "remix" | "report") {
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
                <ActionButton icon={<Heart className="h-4 w-4" />} label="Like" onClick={() => action(item.id, "like")} />
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
      </div>
    </section>
  );
}

async function fetchFeedPayload() {
  const response = await fetch("/api/v1/feed");
  const payload = (await response.json()) as FeedPayload;
  return response.ok ? payload : { ...payload, ok: false };
}

function ActionButton({
  icon,
  label,
  onClick,
}: Readonly<{ icon: React.ReactNode; label: string; onClick: () => void }>) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-10 items-center justify-center gap-1 rounded-full bg-[rgb(36,36,36)] text-[12px] font-bold text-white"
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
