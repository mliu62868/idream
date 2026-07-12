"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, Flag, HeartHandshake, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { authHrefForTarget } from "./authRedirect";

// SPEC: campaign 投放位曝光/点击埋点，经既有 POST /api/v1/events/track。
// INTENT: 只覆盖有公开渲染面的 campaign 槽位；feed_card/homepage_strip 等无渲染面槽位不造埋点（诚实数据）。
export const PLACEMENT_IMPRESSION_EVENT = "placement_impression";
export const PLACEMENT_CLICK_EVENT = "placement_click";
export const CHARACTER_EXPOSURE_EVENT = "character.exposure.recorded.v2";

function clientEventId(prefix: string) {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function trackPlacementEvent(name: string, placementId: string, slot: string) {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify({ name, props: { placementId, slot } });
  if (typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon("/api/v1/events/track", new Blob([payload], { type: "application/json" }));
    return;
  }
  void fetch("/api/v1/events/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function trackCharacterExposure(props: {
  characterId: string;
  eventType: "eligible_impression" | "detail_view";
  exposureId: string;
  journeyId: string;
  parentExposureId: string | null;
  placementId: string;
  visibleDurationMs: number;
  visibleRatio: number;
}) {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify({ name: CHARACTER_EXPOSURE_EVENT, props });
  if (typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon("/api/v1/events/track", new Blob([payload], { type: "application/json" }));
    return;
  }
  void fetch("/api/v1/events/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

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
  ownerName?: string | null;
  itemCount?: number;
  previews?: string[];
};

type CampaignBanner = {
  ctaLabel?: string | null;
  eyebrow: string;
  href?: string | null;
  id: string;
  image: string;
  title: string;
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

type CommunityCampaignPayload = {
  ok?: boolean;
  data?: {
    campaigns?: CampaignBanner[];
  };
  error?: { message?: string };
};

const releaseOptions = [
  { value: "all", label: "All time" },
  { value: "30d", label: "Last 30 days" },
] as const;

const genderOptions = [
  { value: "any", label: "Any Gender" },
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "trans", label: "Trans" },
] as const;

const styleOptions = [
  { value: "any", label: "Any Style" },
  { value: "realistic", label: "Realistic" },
  { value: "anime", label: "Anime" },
  { value: "hybrid", label: "Hybrid" },
] as const;

const fallbackCampaign: CampaignBanner = {
  eyebrow: "Community",
  id: "fallback-community",
  image: "/images/ourdream/promo-card-female.webp",
  title: "Dreamers, Characters, Collections",
};

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function CommunityWorkspace() {
  const [characters, setCharacters] = useState<CommunityCharacter[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignBanner[]>([]);
  const [campaignIndex, setCampaignIndex] = useState(0);
  const [dreamers, setDreamers] = useState<Dreamer[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [gender, setGender] = useState("any");
  const [style, setStyle] = useState("any");
  const [release, setRelease] = useState("all");
  const [focusedCollectionId, setFocusedCollectionId] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [characterJourneyId] = useState(() => clientEventId("community-journey"));

  const query = useMemo(() => {
    const params = new URLSearchParams({ release });
    if (gender !== "any") params.set("gender", gender);
    if (style !== "any") params.set("style", style);
    return params;
  }, [gender, release, style]);
  const focusedCollection = useMemo(
    () =>
      focusedCollectionId
        ? collections.find((collection) => collection.id === focusedCollectionId) ?? null
        : null,
    [collections, focusedCollectionId],
  );
  const visibleStatus = status || (focusedCollection ? `Showing collection: ${focusedCollection.name}.` : "");
  const visibleCampaigns = useMemo(
    () => (campaigns.length > 0 ? campaigns : [fallbackCampaign]),
    [campaigns],
  );
  const normalizedCampaignIndex = campaignIndex % visibleCampaigns.length;
  const activeCampaign = visibleCampaigns[normalizedCampaignIndex] ?? fallbackCampaign;

  const heroRef = useRef<HTMLDivElement | null>(null);
  const impressedCampaignIds = useRef<Set<string>>(new Set());
  const isHeroVisibleRef = useRef(false);
  const activeCampaignIdRef = useRef(activeCampaign.id);

  function recordCampaignImpression(placementId: string) {
    if (impressedCampaignIds.current.has(placementId)) return;
    impressedCampaignIds.current.add(placementId);
    trackPlacementEvent(PLACEMENT_IMPRESSION_EVENT, placementId, "campaign");
  }

  // SPEC: 曝光按 threshold 0.5 触发，每张卡（activeCampaign.id）每次挂载只发一次。
  useEffect(() => {
    const node = heroRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        isHeroVisibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) recordCampaignImpression(activeCampaignIdRef.current);
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // SPEC: 走马灯切换到新 campaign 时，若英雄区当前仍可见，视为新卡曝光。
  useEffect(() => {
    activeCampaignIdRef.current = activeCampaign.id;
    if (isHeroVisibleRef.current) recordCampaignImpression(activeCampaign.id);
  }, [activeCampaign.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFocusedCollectionId(new URLSearchParams(window.location.search).get("collection") ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadCommunity() {
      setStatus("");
      setLoading(true);
      const [leaderboards, publicCollections, campaignResponse] = await Promise.all([
        fetch(`/api/v1/community/leaderboards?${query.toString()}`),
        fetch("/api/v1/community/collections"),
        fetch("/api/v1/community/campaigns"),
      ]);
      const leaderboardPayload = (await leaderboards.json()) as CommunityPayload;
      const collectionsPayload = (await publicCollections.json()) as CommunityPayload;
      const campaignPayload = (await campaignResponse.json()) as CommunityCampaignPayload;
      if (!active) return;
      if (!leaderboards.ok || leaderboardPayload.ok === false) {
        setStatus(leaderboardPayload.error?.message ?? "Accept the age gate to view community.");
        return;
      }
      setCharacters(leaderboardPayload.data?.leaderboards?.characters ?? []);
      setDreamers(leaderboardPayload.data?.leaderboards?.dreamers ?? []);
      setCollections(collectionsPayload.data?.collections ?? []);
      setCampaigns(campaignResponse.ok && campaignPayload.ok !== false ? (campaignPayload.data?.campaigns ?? []) : []);
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

  useEffect(() => {
    if (!focusedCollectionId || loading || !focusedCollection) return;
    const timer = window.setTimeout(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-collection-id]"),
      ).find((element) => element.dataset.collectionId === focusedCollectionId);
      target?.scrollIntoView({ block: "center" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [focusedCollection, focusedCollectionId, loading]);

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
    if (response.status === 401) {
      redirectToCreatorSignup(creatorId);
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
      if (response.status === 401) {
        redirectToCreatorSignup(dreamer.id);
        return;
      }
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
        <div
          className="relative overflow-hidden rounded-[16px] bg-[rgb(18,18,18)]"
          data-testid="community-campaign-hero"
          ref={heroRef}
        >
          <Image
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-55"
            height={288}
            loading="eager"
            src={activeCampaign.image}
            width={1440}
          />
          <div className="relative p-6 md:p-10" aria-live="polite">
            <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
              {activeCampaign.eyebrow}
            </p>
            <h1 className="mt-3 max-w-2xl text-[42px] font-black uppercase leading-none md:text-[64px]">
              {activeCampaign.title}
            </h1>
            {activeCampaign.href && activeCampaign.ctaLabel ? (
              <CampaignLink
                className="mt-5 inline-flex h-10 items-center justify-center rounded-full bg-white px-4 text-[13px] font-black text-[rgb(13,13,13)]"
                href={activeCampaign.href}
                onClick={() => trackPlacementEvent(PLACEMENT_CLICK_EVENT, activeCampaign.id, "campaign")}
              >
                {activeCampaign.ctaLabel}
              </CampaignLink>
            ) : null}
          </div>
          {visibleCampaigns.length > 1 ? (
            <div className="absolute bottom-4 right-4 flex items-center gap-2">
              <button
                aria-label="Previous campaign"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur"
                onClick={() =>
                  setCampaignIndex((current) =>
                    (current - 1 + visibleCampaigns.length) % visibleCampaigns.length,
                  )
                }
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span
                aria-label={`Campaign ${normalizedCampaignIndex + 1} of ${visibleCampaigns.length}`}
                className="rounded-full bg-black/50 px-3 py-1 text-[12px] font-bold text-white backdrop-blur"
              >
                {normalizedCampaignIndex + 1}/{visibleCampaigns.length}
              </span>
              <button
                aria-label="Next campaign"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur"
                onClick={() =>
                  setCampaignIndex((current) => (current + 1) % visibleCampaigns.length)
                }
                type="button"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
        <div
          className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3 md:flex md:flex-wrap"
          data-testid="community-filters"
        >
          <SelectPill
            ariaLabel="Release"
            onChange={setRelease}
            options={releaseOptions}
            value={release}
          />
          <SelectPill
            ariaLabel="Gender"
            onChange={setGender}
            options={genderOptions}
            value={gender}
          />
          <SelectPill
            ariaLabel="Style"
            onChange={setStyle}
            options={styleOptions}
            value={style}
          />
        </div>
        {visibleStatus && (
          <p
            aria-live="polite"
            className="mt-5 rounded-[12px] bg-[rgb(36,36,36)] px-4 py-3 text-[13px] font-semibold text-[rgb(220,220,220)]"
            data-testid="community-status"
            role="status"
          >
            {visibleStatus}
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
                        {countLabel(dreamer.characters, "character")} ·{" "}
                        {countLabel(dreamer.followers, "follower")}
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

        <section className="mt-8">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[22px] font-black uppercase">Characters</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {loading ? (
              <CharacterSkeletons />
            ) : characters.length > 0 ? (
              characters.map((character) => (
                <CommunityCharacterCard
                  character={character}
                  journeyId={characterJourneyId}
                  key={character.id}
                  onFollow={follow}
                  onReport={report}
                />
              ))
            ) : (
              <p
                className="rounded-[12px] bg-[rgb(18,18,18)] p-5 text-[13px] font-medium text-[rgb(170,170,170)] md:col-span-4"
                data-testid="community-characters-empty"
              >
                No characters match these filters.
              </p>
            )}
          </div>
        </section>

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
                <div
                  className={`overflow-hidden rounded-[12px] border bg-[rgb(36,36,36)] ${
                    collection.id === focusedCollectionId
                      ? "border-[rgb(253,95,194)] shadow-[0_0_0_1px_rgba(253,95,194,0.55)]"
                      : "border-transparent"
                  }`}
                  data-collection-id={collection.id}
                  data-focused={collection.id === focusedCollectionId ? "true" : "false"}
                  data-testid="community-collection-card"
                  key={collection.id}
                >
                  <div className="grid h-[132px] grid-cols-2 grid-rows-2 gap-0.5 bg-black/30">
                    {(collection.previews ?? []).slice(0, 4).map((src) => (
                      <div className="relative min-h-0" key={src}>
                        <Image
                          alt=""
                          className="object-cover object-top"
                          fill
                          sizes="180px"
                          src={src}
                          unoptimized={isPrivateMediaUrl(src)}
                        />
                      </div>
                    ))}
                    {Array.from({
                      length: Math.max(0, 4 - (collection.previews?.length ?? 0)),
                    }).map((_, index) => (
                      <div
                        className="bg-[rgb(28,28,28)]"
                        key={`${collection.id}-empty-${index}`}
                      />
                    ))}
                  </div>
                  <div className="p-4">
                    <p className="line-clamp-1 text-[15px] font-black uppercase">
                      {collection.name}
                    </p>
                    <p className="mt-2 text-[12px] font-medium text-[rgb(170,170,170)]">
                      {countLabel(collection.itemCount ?? 0, "item")} · by{" "}
                      {collection.ownerName ?? "Dreamer"}
                    </p>
                  </div>
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

function CommunityCharacterCard({
  character,
  journeyId,
  onFollow,
  onReport,
}: {
  character: CommunityCharacter;
  journeyId: string;
  onFollow: (creatorId?: string | null) => Promise<void>;
  onReport: (characterId: string) => Promise<void>;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const impressionIdRef = useRef(clientEventId("character-impression"));
  const [detailExposureId] = useState(() => clientEventId("character-detail"));
  const impressionRecordedRef = useRef(false);
  const detailRecordedRef = useRef(false);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    let timer: number | null = null;
    let visibleRatio = 0;
    const clearEligibilityTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRatio = entry.intersectionRatio;
        if (!entry.isIntersecting || entry.intersectionRatio < 0.5) {
          clearEligibilityTimer();
          return;
        }
        if (impressionRecordedRef.current || timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          if (visibleRatio < 0.5 || impressionRecordedRef.current) return;
          impressionRecordedRef.current = true;
          trackCharacterExposure({
            characterId: character.id,
            eventType: "eligible_impression",
            exposureId: impressionIdRef.current,
            journeyId,
            parentExposureId: null,
            placementId: "community.leaderboard",
            visibleDurationMs: 500,
            visibleRatio,
          });
        }, 500);
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(node);
    return () => {
      clearEligibilityTimer();
      observer.disconnect();
    };
  }, [character.id, journeyId]);

  function recordDetailView() {
    if (!impressionRecordedRef.current || detailRecordedRef.current) return;
    detailRecordedRef.current = true;
    trackCharacterExposure({
      characterId: character.id,
      eventType: "detail_view",
      exposureId: detailExposureId,
      journeyId,
      parentExposureId: impressionIdRef.current,
      placementId: "community.leaderboard",
      visibleDurationMs: 0,
      visibleRatio: 1,
    });
  }

  return (
    <article
      className="overflow-hidden rounded-[14px] bg-[rgb(18,18,18)]"
      data-testid="community-character-card"
      ref={cardRef}
    >
      <Link
        aria-label={character.title}
        className="relative block aspect-[4/5]"
        href={`/characters/${character.id}?entryExposureId=${encodeURIComponent(detailExposureId)}&journeyId=${encodeURIComponent(journeyId)}&placementId=${encodeURIComponent("community.leaderboard")}`}
        onClick={recordDetailView}
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
        <h2 className="line-clamp-2 text-[16px] font-black uppercase leading-5">{character.title}</h2>
        <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
          {character.likes} likes · {character.chats} chats
        </p>
        <div className="mt-4 flex gap-2">
          <button
            className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full bg-white text-[12px] font-black text-[rgb(13,13,13)]"
            onClick={() => void onFollow(character.creatorId)}
            type="button"
          >
            <HeartHandshake className="h-4 w-4" />
            Follow
          </button>
          <button
            aria-label={`Report ${character.title}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-white"
            onClick={() => void onReport(character.id)}
            type="button"
          >
            <Flag className="h-4 w-4" />
          </button>
        </div>
      </div>
    </article>
  );
}

function SelectPill({
  ariaLabel,
  onChange,
  options,
  value,
}: Readonly<{
  ariaLabel: string;
  onChange: (value: string) => void;
  options: readonly { label: string; value: string }[];
  value: string;
}>) {
  return (
    <label className="relative inline-flex min-w-0">
      <select
        aria-label={ariaLabel}
        className="h-10 w-full min-w-0 appearance-none truncate rounded-full bg-[rgb(36,36,36)] pl-4 pr-9 text-[13px] font-bold text-white outline-none transition-colors hover:bg-[rgb(46,46,46)] focus-visible:ring-2 focus-visible:ring-white/40 md:min-w-32"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgb(170,170,170)]"
      />
    </label>
  );
}

function CampaignLink({
  children,
  className,
  href,
  onClick,
}: Readonly<{
  children: ReactNode;
  className: string;
  href: string;
  onClick?: () => void;
}>) {
  if (/^https?:\/\//i.test(href)) {
    return (
      <a className={className} href={href} onClick={onClick} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  }
  return (
    <Link className={className} href={href} onClick={onClick}>
      {children}
    </Link>
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

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}

function redirectToCreatorSignup(creatorId: string) {
  window.location.assign(
    authHrefForTarget("/signup", `/creators/${encodeURIComponent(creatorId)}`),
  );
}

// SPEC: turn a failed follow response into a user-facing message.
// INTENT: only show the sign-in hint for genuine auth (401) failures; otherwise
// surface the real server error (e.g. 400 "Cannot follow yourself").
async function followErrorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Sign in to follow creators.";
  const payload = (await response.json().catch(() => null)) as CommunityPayload | null;
  return payload?.error?.message ?? "Could not update follow.";
}
