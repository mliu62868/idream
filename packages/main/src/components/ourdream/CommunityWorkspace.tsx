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

type Dreamer = {
  id: string;
  displayName: string;
  image?: string | null;
  characters: number;
  followers: number;
  likes: string;
  chats: string;
  isFollowing?: boolean;
};

type CommunityPayload = {
  ok?: boolean;
  data?: {
    leaderboards?: {
      characters?: CommunityCharacter[];
      dreamers?: Dreamer[];
      collections?: Collection[];
    };
    collections?: Collection[];
  };
  error?: { message?: string };
};

export function CommunityWorkspace() {
  const [characters, setCharacters] = useState<CommunityCharacter[]>([]);
  const [dreamers, setDreamers] = useState<Dreamer[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [gender, setGender] = useState("any");
  const [style, setStyle] = useState("any");
  const [release, setRelease] = useState("all");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  const query = useMemo(() => {
    const params = new URLSearchParams({ release });
    if (gender !== "any") params.set("gender", gender);
    if (style !== "any") params.set("style", style);
    return params;
  }, [gender, release, style]);

  useEffect(() => {
    let active = true;
    async function loadCommunity() {
      setStatus("");
      setLoading(true);
      const [leaderboards, publicCollections] = await Promise.all([
        fetch(`/api/v1/community/leaderboards?${query.toString()}`),
        fetch("/api/v1/community/collections"),
      ]);
      const leaderboardPayload = (await leaderboards.json()) as CommunityPayload;
      const collectionsPayload = (await publicCollections.json()) as CommunityPayload;
      if (!active) return;
      if (!leaderboards.ok || leaderboardPayload.ok === false) {
        setStatus(leaderboardPayload.error?.message ?? "Accept the age gate to view community.");
        return;
      }
      setCharacters(leaderboardPayload.data?.leaderboards?.characters ?? []);
      setDreamers(leaderboardPayload.data?.leaderboards?.dreamers ?? []);
      setCollections(collectionsPayload.data?.collections ?? []);
    }

    loadCommunity()
      .catch(() => {
        if (active) setStatus("Community unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [query]);

  async function follow(creatorId?: string | null) {
    if (!creatorId) {
      setStatus("This creator cannot be followed.");
      return;
    }
    const response = await fetch(`/api/v1/users/${creatorId}/follow`, { method: "POST" });
    if (response.ok) {
      setStatus("Creator followed.");
      return;
    }
    setStatus(await followErrorMessage(response));
  }

  async function toggleFollowDreamer(dreamer: Dreamer) {
    const next = !dreamer.isFollowing;
    setDreamers((current) =>
      current.map((item) =>
        item.id === dreamer.id
          ? {
              ...item,
              isFollowing: next,
              followers: Math.max(0, item.followers + (next ? 1 : -1)),
            }
          : item,
      ),
    );
    const response = await fetch(`/api/v1/users/${dreamer.id}/follow`, {
      method: next ? "POST" : "DELETE",
    });
    if (!response.ok) {
      setDreamers((current) =>
        current.map((item) =>
          item.id === dreamer.id
            ? {
                ...item,
                isFollowing: dreamer.isFollowing,
                followers: dreamer.followers,
              }
            : item,
        ),
      );
      setStatus(await followErrorMessage(response));
    }
  }

  async function reportDreamer(dreamerId: string) {
    const response = await fetch("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetType: "user_profile",
        targetId: dreamerId,
        category: "other_prohibited_content",
        description: "User profile report",
      }),
    });
    setStatus(response.ok ? "Profile report submitted." : "Profile report failed.");
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
        {status && (
          <p
            aria-live="polite"
            className="mt-5 rounded-[12px] bg-[rgb(36,36,36)] px-4 py-3 text-[13px] font-semibold text-[rgb(220,220,220)]"
          >
            {status}
          </p>
        )}

        <section className="mt-8">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[22px] font-black uppercase">Dreamers</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {loading ? (
              <DreamerSkeletons />
            ) : dreamers.length > 0 ? (
              dreamers.map((dreamer) => (
                <article
                  className="rounded-[14px] bg-[rgb(18,18,18)] p-4"
                  data-testid="community-dreamer-card"
                  key={dreamer.id}
                >
                  <Link className="flex items-center gap-3" href={`/creators/${dreamer.id}`}>
                    {dreamer.image ? (
                      <Image
                        alt=""
                        className="h-12 w-12 rounded-full object-cover"
                        height={48}
                        src={dreamer.image}
                        width={48}
                      />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-[14px] font-black uppercase text-white">
                        {dreamer.displayName.slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <h3 className="truncate text-[15px] font-black uppercase hover:underline">
                        {dreamer.displayName}
                      </h3>
                      <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
                        {dreamer.characters} characters · {dreamer.followers} followers
                      </p>
                    </div>
                  </Link>
                  <p className="mt-3 text-[12px] font-medium text-[rgb(170,170,170)]">
                    {dreamer.likes} likes · {dreamer.chats} chats
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button
                      className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full text-[12px] font-black ${
                        dreamer.isFollowing
                          ? "bg-[rgb(36,36,36)] text-white"
                          : "bg-white text-[rgb(13,13,13)]"
                      }`}
                      onClick={() => toggleFollowDreamer(dreamer)}
                      type="button"
                    >
                      <HeartHandshake className="h-4 w-4" />
                      {dreamer.isFollowing ? "Following" : "Follow"}
                    </button>
                    <button
                      aria-label={`Report user profile ${dreamer.displayName}`}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-white"
                      onClick={() => reportDreamer(dreamer.id)}
                      title="Report profile"
                      type="button"
                    >
                      <Flag className="h-4 w-4" />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                Dreamers with public characters appear here.
              </p>
            )}
          </div>
        </section>

        <div className="mt-8 grid gap-3 md:grid-cols-4">
          {loading && <CharacterSkeletons />}
          {characters.map((character) => (
            <article
              className="overflow-hidden rounded-[14px] bg-[rgb(18,18,18)]"
              key={character.id}
            >
              <Link
                aria-label={character.title}
                className="relative block aspect-[4/5]"
                href={`/characters/${character.id}`}
              >
                <Image
                  alt=""
                  className="object-cover object-top"
                  fill
                  sizes="260px"
                  src={character.image}
                  unoptimized={isPrivateMediaUrl(character.image)}
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
                    aria-label={`Report ${character.title}`}
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
            {loading ? (
              <CollectionSkeletons />
            ) : collections.length > 0 ? (
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

// SPEC: skeleton placeholders shown while the first community fetch is in flight.
// INTENT: avoid the false "empty" flash before data arrives; genuine empty-states
// only render once loading is done.
function DreamerSkeletons() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          className="h-[148px] animate-pulse rounded-[14px] bg-[rgb(18,18,18)]"
          key={index}
        />
      ))}
    </>
  );
}

function CharacterSkeletons() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          className="aspect-[4/5] animate-pulse rounded-[14px] bg-[rgb(18,18,18)]"
          key={index}
        />
      ))}
    </>
  );
}

function CollectionSkeletons() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          className="h-[84px] animate-pulse rounded-[12px] bg-[rgb(36,36,36)]"
          key={index}
        />
      ))}
    </>
  );
}

function next(current: string, values: string[]) {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? values[0];
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}

// SPEC: turn a failed follow response into a user-facing message.
// INTENT: only show the sign-in hint for genuine auth (401) failures; otherwise
// surface the real server error (e.g. 400 "Cannot follow yourself").
async function followErrorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Sign in to follow creators.";
  const payload = (await response.json().catch(() => null)) as CommunityPayload | null;
  return payload?.error?.message ?? "Could not update follow.";
}
