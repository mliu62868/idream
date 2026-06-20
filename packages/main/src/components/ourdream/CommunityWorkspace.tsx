"use client";

import Image from "next/image";
import Link from "next/link";
import { Flag, HeartHandshake, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type CommunityCharacter = {
  id: string;
  title: string;
  age: string;
  image: string;
  description: string;
  creatorId?: string | null;
  creator: string;
  likes: string;
  chats: string;
  style?: string;
  gender?: string;
};

type Collection = {
  id: string;
  name: string;
  visibility: string;
};

type CommunityPayload = {
  ok?: boolean;
  data?: {
    leaderboards?: {
      characters?: CommunityCharacter[];
      dreamers?: Array<{ id: string; displayName?: string }>;
      collections?: Collection[];
    };
    collections?: Collection[];
  };
  error?: { message?: string };
};

export function CommunityWorkspace() {
  const [characters, setCharacters] = useState<CommunityCharacter[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [gender, setGender] = useState("any");
  const [style, setStyle] = useState("any");
  const [release, setRelease] = useState("all");
  const [status, setStatus] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ release });
    if (gender !== "any") params.set("gender", gender);
    if (style !== "any") params.set("style", style);
    return params;
  }, [gender, release, style]);

  useEffect(() => {
    async function loadCommunity() {
      setStatus("");
      const [leaderboards, publicCollections] = await Promise.all([
        fetch(`/api/v1/community/leaderboards?${query.toString()}`),
        fetch("/api/v1/community/collections"),
      ]);
      const leaderboardPayload = (await leaderboards.json()) as CommunityPayload;
      const collectionsPayload = (await publicCollections.json()) as CommunityPayload;
      if (!leaderboards.ok || leaderboardPayload.ok === false) {
        setStatus(leaderboardPayload.error?.message ?? "Accept the age gate to view community.");
        return;
      }
      setCharacters(leaderboardPayload.data?.leaderboards?.characters ?? []);
      setCollections(collectionsPayload.data?.collections ?? []);
    }

    loadCommunity().catch(() => setStatus("Community unavailable."));
  }, [query]);

  async function follow(creatorId?: string | null) {
    if (!creatorId) {
      setStatus("This creator cannot be followed.");
      return;
    }
    const response = await fetch(`/api/v1/users/${creatorId}/follow`, { method: "POST" });
    setStatus(response.ok ? "Creator followed." : "Sign in to follow creators.");
  }

  async function report(characterId: string) {
    const response = await fetch(`/api/v1/characters/${characterId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "other_prohibited_content", description: "Community report" }),
    });
    setStatus(response.ok ? "Report submitted." : "Report failed.");
  }

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="relative overflow-hidden rounded-[16px] bg-[rgb(18,18,18)]">
          <Image
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-55"
            height={288}
            src="/images/ourdream/pride-banner-female.webp"
            width={1440}
          />
          <div className="relative p-6 md:p-10">
            <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
              Community
            </p>
            <h1 className="mt-3 max-w-2xl text-[42px] font-black uppercase leading-none md:text-[64px]">
              Dreamers, Characters, Collections
            </h1>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <FilterButton label={`Release ${release}`} onClick={() => setRelease(release === "30d" ? "all" : "30d")} />
          <FilterButton label={`Gender ${gender}`} onClick={() => setGender(next(gender, ["any", "female", "male", "trans"]))} />
          <FilterButton label={`Style ${style}`} onClick={() => setStyle(next(style, ["any", "realistic", "anime", "hybrid"]))} />
        </div>

        <div className="mt-8 grid gap-3 md:grid-cols-4">
          {characters.map((character) => (
            <article
              className="overflow-hidden rounded-[14px] bg-[rgb(18,18,18)]"
              key={character.id}
            >
              <Link className="relative block aspect-[4/5]" href={`/characters/${character.id}`}>
                <Image
                  alt=""
                  className="object-cover object-top"
                  fill
                  sizes="260px"
                  src={character.image}
                />
              </Link>
              <div className="p-4">
                <h2 className="line-clamp-2 text-[16px] font-black uppercase leading-5">
                  {character.title}
                </h2>
                <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
                  {character.likes} likes · {character.chats} chats
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full bg-white text-[12px] font-black text-[rgb(13,13,13)]"
                    onClick={() => follow(character.creatorId)}
                    type="button"
                  >
                    <HeartHandshake className="h-4 w-4" />
                    Follow
                  </button>
                  <button
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-white"
                    onClick={() => report(character.id)}
                    type="button"
                  >
                    <Flag className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>

        <section className="mt-10 rounded-[16px] bg-[rgb(18,18,18)] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[22px] font-black uppercase">Collections</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {collections.length > 0 ? (
              collections.map((collection) => (
                <div className="rounded-[12px] bg-[rgb(36,36,36)] p-4" key={collection.id}>
                  <p className="text-[15px] font-black uppercase">{collection.name}</p>
                  <p className="mt-2 text-[12px] font-medium text-[rgb(170,170,170)]">
                    {collection.visibility}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                Public collections appear here.
              </p>
            )}
          </div>
        </section>
        {status && <p className="mt-5 text-[13px] font-semibold text-[rgb(170,170,170)]">{status}</p>}
      </div>
    </section>
  );
}

function FilterButton({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <button
      className="h-10 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function next(current: string, values: string[]) {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? values[0];
}
