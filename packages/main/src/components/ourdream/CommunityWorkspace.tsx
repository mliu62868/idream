"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, Flag, HeartHandshake, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseCommunityCampaignsResponse,
  parseCommunityCollectionsResponse,
  parseCommunityLeaderboardsResponse,
  parseFollowMutationResponse,
  type CommunityCampaign as CampaignBanner,
  type CommunityCharacter,
  type CommunityCollection as Collection,
  type CommunityDreamer as Dreamer,
  type RankingExperiment,
} from "@/lib/public-api-contracts";
import { shouldBypassNextImageOptimizer } from "@/lib/image-delivery";
import { useAgeGateAccess } from "./AgeGateBoundary";
import {
  authorityShowsEmpty,
  failedAuthorityStatus,
  initialAuthorityStatus,
  loadingAuthorityStatus,
  loadingAuthorityStatusForScope,
  readyAuthorityStatus,
} from "./authority-state";
import { authHrefForTarget } from "./authRedirect";

// SPEC: campaign 投放位曝光/点击埋点，经既有 POST /api/v1/events/track。
// INTENT: 只覆盖有公开渲染面的 campaign 槽位；feed_card/homepage_strip 等无渲染面槽位不造埋点（诚实数据）。
export const PLACEMENT_IMPRESSION_EVENT = "placement_impression";
export const PLACEMENT_CLICK_EVENT = "placement_click";
export const CHARACTER_EXPOSURE_EVENT = "character.exposure.recorded.v2";

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
  contextToken: string;
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

function trackExperimentExposure(props: {
  exposureId: string;
  assignmentId: string;
  surface: "community.leaderboard";
}) {
  const payload = JSON.stringify({ name: "experiment.exposed.v2", props });
  void fetch("/api/v1/events/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

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

type CommunityHero = {
  ctaLabel: string | null;
  eyebrow: string;
  href: string | null;
  id: string;
  image: string;
  source: "authority" | "editorial_overview";
  title: string;
};

const editorialOverview: CommunityHero = {
  ctaLabel: null,
  eyebrow: "Community",
  href: null,
  id: "editorial-community-overview",
  image: "/images/ourdream/promo-card-female.webp",
  source: "editorial_overview",
  title: "Dreamers, Characters, Collections",
};

const COMMUNITY_INITIAL_DREAMERS = 3;
const COMMUNITY_INITIAL_CHARACTERS = 8;
const COMMUNITY_INITIAL_COLLECTIONS = 3;

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function CommunityWorkspace() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const searchParams = useSearchParams();
  const focusedCollectionId = searchParams.get("collection")?.trim() ?? "";
  const [characters, setCharacters] = useState<CommunityCharacter[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignBanner[]>([]);
  const [campaignsAuthority, setCampaignsAuthority] = useState(
    initialAuthorityStatus,
  );
  const [campaignIndex, setCampaignIndex] = useState(0);
  const [dreamers, setDreamers] = useState<Dreamer[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [gender, setGender] = useState("any");
  const [style, setStyle] = useState("any");
  const [release, setRelease] = useState("all");
  const [visibleDreamerCount, setVisibleDreamerCount] = useState(
    COMMUNITY_INITIAL_DREAMERS,
  );
  const [visibleCharacterCount, setVisibleCharacterCount] = useState(
    COMMUNITY_INITIAL_CHARACTERS,
  );
  const [visibleCollectionCount, setVisibleCollectionCount] = useState(
    COMMUNITY_INITIAL_COLLECTIONS,
  );
  const [followPendingIds, setFollowPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [status, setStatus] = useState("");
  const [leaderboardsAuthority, setLeaderboardsAuthority] = useState(initialAuthorityStatus);
  const [collectionsAuthority, setCollectionsAuthority] = useState(initialAuthorityStatus);
  const [leaderboardsReloadToken, setLeaderboardsReloadToken] = useState(0);
  const [collectionsReloadToken, setCollectionsReloadToken] = useState(0);
  const [campaignsReloadToken, setCampaignsReloadToken] = useState(0);
  const [rankingExperiment, setRankingExperiment] =
    useState<RankingExperiment | null>(null);
  const rankingExposureRecordedRef = useRef(false);
  const leaderboardsQueryRef = useRef("");
  const collectionsScopeRef = useRef<string | null>(null);

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
  const visibleDreamers = useMemo(
    () => dreamers.slice(0, visibleDreamerCount),
    [dreamers, visibleDreamerCount],
  );
  const visibleCharacters = useMemo(
    () => characters.slice(0, visibleCharacterCount),
    [characters, visibleCharacterCount],
  );
  const orderedCollections = useMemo(
    () =>
      focusedCollection
        ? [
            focusedCollection,
            ...collections.filter(
              (collection) => collection.id !== focusedCollection.id,
            ),
          ]
        : collections,
    [collections, focusedCollection],
  );
  const visibleCollections = useMemo(
    () => orderedCollections.slice(0, visibleCollectionCount),
    [orderedCollections, visibleCollectionCount],
  );
  const visibleStatus = status || (focusedCollection ? `Showing collection: ${focusedCollection.name}.` : "");
  const visibleCampaigns = useMemo<readonly CommunityHero[]>(
    () =>
      campaigns.length > 0
        ? campaigns.map((campaign) => ({
            ctaLabel: campaign.ctaLabel ?? null,
            eyebrow: campaign.eyebrow,
            href: campaign.href ?? null,
            id: campaign.id,
            image: campaign.image,
            source: campaign.source,
            title: campaign.title,
          }))
        : [editorialOverview],
    [campaigns],
  );
  const normalizedCampaignIndex = campaignIndex % visibleCampaigns.length;
  const activeCampaign =
    visibleCampaigns[normalizedCampaignIndex] ?? editorialOverview;
  const invalidateLeaderboardScope = useCallback(() => {
    leaderboardsQueryRef.current = "";
    rankingExposureRecordedRef.current = false;
    setCharacters([]);
    setDreamers([]);
    setRankingExperiment(null);
    setLeaderboardsAuthority(initialAuthorityStatus());
  }, []);
  const recordRankingExposure = useCallback(() => {
    if (!rankingExperiment || rankingExposureRecordedRef.current) return;
    rankingExposureRecordedRef.current = true;
    trackExperimentExposure(rankingExperiment);
  }, [rankingExperiment]);

  const heroRef = useRef<HTMLDivElement | null>(null);
  const impressedCampaignIds = useRef<Set<string>>(new Set());
  const isHeroVisibleRef = useRef(false);
  const activeCampaignIdRef = useRef(activeCampaign.id);

  function recordCampaignImpression(placementId: string) {
    if (placementId === editorialOverview.id) return;
    if (impressedCampaignIds.current.has(placementId)) return;
    impressedCampaignIds.current.add(placementId);
    trackPlacementEvent(PLACEMENT_IMPRESSION_EVENT, placementId, "campaign");
  }

  // SPEC: 曝光按 threshold 0.5 触发，每张卡（activeCampaign.id）每次挂载只发一次。
  useEffect(() => {
    if (!ageGateAccepted) return;
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
  }, [ageGateAccepted]);

  // SPEC: 走马灯切换到新 campaign 时，若英雄区当前仍可见，视为新卡曝光。
  useEffect(() => {
    if (!ageGateAccepted) return;
    activeCampaignIdRef.current = activeCampaign.id;
    if (isHeroVisibleRef.current) recordCampaignImpression(activeCampaign.id);
  }, [activeCampaign.id, ageGateAccepted]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    let active = true;
    const controller = new AbortController();
    const leaderboardsQuery = query.toString();

    async function loadLeaderboards() {
      try {
        const response = await fetch(
          `/api/v1/community/leaderboards?${leaderboardsQuery}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Community rankings could not load.");
        const payload = parseCommunityLeaderboardsResponse(
          await response.json(),
        );
        if (!active) return;
        setCharacters(payload.leaderboards.characters);
        setDreamers(payload.leaderboards.dreamers);
        setVisibleDreamerCount(COMMUNITY_INITIAL_DREAMERS);
        setVisibleCharacterCount(COMMUNITY_INITIAL_CHARACTERS);
        setRankingExperiment(payload.experimentAssignment ?? null);
        rankingExposureRecordedRef.current = false;
        setLeaderboardsAuthority(readyAuthorityStatus());
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setLeaderboardsAuthority((current) =>
          failedAuthorityStatus(
            current,
            communityRequestError(error, "Community rankings could not load."),
          ),
        );
      }
    }

    async function loadCommunityLeaderboards() {
      setStatus("");
      const hasMatchingLeaderboardQuery =
        leaderboardsQueryRef.current === leaderboardsQuery;
      if (!hasMatchingLeaderboardQuery) {
        leaderboardsQueryRef.current = leaderboardsQuery;
        setCharacters([]);
        setDreamers([]);
        setRankingExperiment(null);
      }
      setLeaderboardsAuthority((current) =>
        loadingAuthorityStatusForScope(
          current,
          hasMatchingLeaderboardQuery,
        ),
      );
      await loadLeaderboards();
    }

    void loadCommunityLeaderboards();

    return () => {
      active = false;
      controller.abort();
    };
  }, [ageGateAccepted, leaderboardsReloadToken, query]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    let active = true;
    const controller = new AbortController();
    const collectionSearch = focusedCollectionId
      ? `?collection=${encodeURIComponent(focusedCollectionId)}`
      : "";
    const hasMatchingCollectionScope =
      collectionsScopeRef.current === focusedCollectionId;
    collectionsScopeRef.current = focusedCollectionId;
    if (!hasMatchingCollectionScope) {
      setCollections([]);
    }

    async function loadCollections() {
      setCollectionsAuthority((current) =>
        loadingAuthorityStatusForScope(
          current,
          hasMatchingCollectionScope,
        ),
      );
      try {
        const response = await fetch(
          `/api/v1/community/collections${collectionSearch}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Public collections could not load.");
        const nextCollections = parseCommunityCollectionsResponse(
          await response.json(),
        ).collections;
        if (!active) return;
        setCollections(nextCollections);
        setVisibleCollectionCount(COMMUNITY_INITIAL_COLLECTIONS);
        setCollectionsAuthority(readyAuthorityStatus());
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setCollectionsAuthority((current) =>
          failedAuthorityStatus(
            current,
            communityRequestError(error, "Public collections could not load."),
          ),
        );
      }
    }

    void loadCollections();
    return () => {
      active = false;
      controller.abort();
    };
  }, [ageGateAccepted, collectionsReloadToken, focusedCollectionId]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    let active = true;
    const controller = new AbortController();

    async function loadCampaigns() {
      setCampaignsAuthority(loadingAuthorityStatus);
      try {
        const response = await fetch("/api/v1/community/campaigns", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Community campaigns could not load.");
        }
        const nextCampaigns = parseCommunityCampaignsResponse(
          await response.json(),
        ).campaigns;
        if (!active) return;
        setCampaigns(nextCampaigns);
        setCampaignsAuthority(readyAuthorityStatus());
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setCampaignsAuthority((current) =>
          failedAuthorityStatus(
            current,
            communityRequestError(error, "Community campaigns could not load."),
          ),
        );
      }
    }

    void loadCampaigns();
    return () => {
      active = false;
      controller.abort();
    };
  }, [ageGateAccepted, campaignsReloadToken]);

  useEffect(() => {
    if (
      !focusedCollectionId ||
      (collectionsAuthority.phase === "loading" &&
        !collectionsAuthority.hasSnapshot) ||
      !focusedCollection
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-collection-id]"),
      ).find((element) => element.dataset.collectionId === focusedCollectionId);
      target?.scrollIntoView({ block: "center" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [collectionsAuthority, focusedCollection, focusedCollectionId]);

  async function follow(creatorId?: string | null) {
    if (!creatorId) {
      setStatus("This creator cannot be followed.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/users/${creatorId}/follow`, { method: "POST" });
      if (response.ok) {
        parseFollowMutationResponse(await response.json());
        setStatus("Creator followed.");
        return;
      }
      if (response.status === 401) {
        redirectToCreatorSignup(creatorId);
        return;
      }
      setStatus(await followErrorMessage(response));
    } catch {
      setStatus("Could not update follow. Please try again.");
    }
  }

  async function toggleFollowDreamer(dreamer: Dreamer) {
    if (followPendingIds.has(dreamer.id)) return;
    const next = !dreamer.isFollowing;
    setFollowPendingIds((current) => new Set(current).add(dreamer.id));
    try {
      const response = await fetch(`/api/v1/users/${dreamer.id}/follow`, {
        method: next ? "POST" : "DELETE",
      });
      if (!response.ok) {
        if (response.status === 401) {
          redirectToCreatorSignup(dreamer.id);
          return;
        }
        setStatus(await followErrorMessage(response));
        return;
      }
      const authority = parseFollowMutationResponse(await response.json());
      setDreamers((current) =>
        current.map((item) =>
          item.id === dreamer.id
            ? {
                ...item,
                isFollowing: authority.following,
                followers: authority.followers,
              }
            : item,
        ),
      );
    } catch {
      setStatus("Could not update follow. Please try again.");
    } finally {
      setFollowPendingIds((current) => {
        const nextPending = new Set(current);
        nextPending.delete(dreamer.id);
        return nextPending;
      });
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
            unoptimized={shouldBypassNextImageOptimizer(activeCampaign.image)}
            width={1440}
          />
          <div className="relative p-6 md:p-10" aria-live="polite">
            <p
              className="mb-3 text-[11px] font-bold uppercase tracking-wide text-white/70"
              data-testid="community-campaign-authority-status"
            >
              {activeCampaign.source === "authority"
                ? campaignsAuthority.phase === "ready"
                  ? "Live community campaign"
                  : campaignsAuthority.phase === "error"
                    ? "Campaigns unavailable · Last known campaign"
                    : "Refreshing campaigns · Last known campaign"
                : campaignsAuthority.phase === "error"
                  ? "Campaigns unavailable · Editorial community overview"
                  : campaignsAuthority.phase === "ready"
                    ? "No active campaign · Editorial community overview"
                    : "Loading campaigns · Editorial community overview"}
            </p>
            {campaignsAuthority.phase === "error" ? (
              <button
                className="mb-3 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-bold text-white"
                onClick={() => setCampaignsReloadToken((current) => current + 1)}
                type="button"
              >
                Retry campaigns
              </button>
            ) : null}
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
            onChange={(value) => {
              if (value === release) return;
              invalidateLeaderboardScope();
              setRelease(value);
            }}
            options={releaseOptions}
            value={release}
          />
          <SelectPill
            ariaLabel="Gender"
            onChange={(value) => {
              if (value === gender) return;
              invalidateLeaderboardScope();
              setGender(value);
            }}
            options={genderOptions}
            value={gender}
          />
          <SelectPill
            ariaLabel="Style"
            onChange={(value) => {
              if (value === style) return;
              invalidateLeaderboardScope();
              setStyle(value);
            }}
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
        {leaderboardsAuthority.phase === "error" ? (
          <CommunityAuthorityNotice
            hasSnapshot={leaderboardsAuthority.hasSnapshot}
            message={
              leaderboardsAuthority.error ?? "Community rankings could not load."
            }
            onRetry={() => setLeaderboardsReloadToken((current) => current + 1)}
          />
        ) : null}
        {leaderboardsAuthority.phase === "loading" &&
        leaderboardsAuthority.hasSnapshot ? (
          <p className="mt-5 text-[12px] font-semibold text-[rgb(170,170,170)]">
            Updating rankings. Showing the previous results until the refresh completes.
          </p>
        ) : null}

        <section className="mt-8">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[22px] font-black uppercase">Dreamers</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {leaderboardsAuthority.phase === "loading" &&
            !leaderboardsAuthority.hasSnapshot ? (
              <DreamerSkeletons />
            ) : dreamers.length > 0 ? (
              visibleDreamers.map((dreamer) => (
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
                        unoptimized={shouldBypassNextImageOptimizer(dreamer.image)}
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
                  {(dreamer.likesCount ?? 0) > 0 || (dreamer.chatsCount ?? 0) > 0 ? (
                    <p className="mt-3 text-[12px] font-medium text-[rgb(170,170,170)]">
                      {(dreamer.likesCount ?? 0) > 0 ? `${dreamer.likes} likes` : null}
                      {(dreamer.likesCount ?? 0) > 0 && (dreamer.chatsCount ?? 0) > 0 ? " · " : null}
                      {(dreamer.chatsCount ?? 0) > 0 ? `${dreamer.chats} chats` : null}
                    </p>
                  ) : (
                    <p className="mt-3 text-[12px] font-medium text-[rgb(170,170,170)]">
                      Public creator
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <button
                      className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full text-[12px] font-black ${
                        dreamer.isFollowing
                          ? "bg-[rgb(36,36,36)] text-white"
                          : "bg-white text-[rgb(13,13,13)]"
                      }`}
                      disabled={followPendingIds.has(dreamer.id)}
                      onClick={() => toggleFollowDreamer(dreamer)}
                      type="button"
                    >
                      <HeartHandshake className="h-4 w-4" />
                      {followPendingIds.has(dreamer.id)
                        ? "Updating..."
                        : dreamer.isFollowing
                          ? "Following"
                          : "Follow"}
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
            ) : authorityShowsEmpty(leaderboardsAuthority, dreamers.length) ? (
              <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                Dreamers with public characters appear here.
              </p>
            ) : null}
          </div>
          {dreamers.length > visibleDreamers.length ? (
            <CommunityShowMoreButton
              label="Show more dreamers"
              onClick={() =>
                setVisibleDreamerCount((current) =>
                  Math.min(dreamers.length, current + 6),
                )
              }
            />
          ) : null}
        </section>

        <section className="mt-8">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[22px] font-black uppercase">Characters</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {leaderboardsAuthority.phase === "loading" &&
            !leaderboardsAuthority.hasSnapshot ? (
              <CharacterSkeletons />
            ) : characters.length > 0 ? (
              visibleCharacters.map((character) => (
                <CommunityCharacterCard
                  character={character}
                  key={character.id}
                  onEligibleImpression={recordRankingExposure}
                  onFollow={follow}
                  onReport={report}
                />
              ))
            ) : authorityShowsEmpty(leaderboardsAuthority, characters.length) ? (
              <p
                className="rounded-[12px] bg-[rgb(18,18,18)] p-5 text-[13px] font-medium text-[rgb(170,170,170)] md:col-span-4"
                data-testid="community-characters-empty"
              >
                No characters match these filters.
              </p>
            ) : null}
          </div>
          {characters.length > visibleCharacters.length ? (
            <CommunityShowMoreButton
              label="Show more characters"
              onClick={() =>
                setVisibleCharacterCount((current) =>
                  Math.min(characters.length, current + 8),
                )
              }
            />
          ) : null}
        </section>

        <section className="mt-10 rounded-[16px] bg-[rgb(18,18,18)] p-5">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[22px] font-black uppercase">Collections</h2>
          </div>
          {collectionsAuthority.phase === "error" ? (
            <CommunityAuthorityNotice
              hasSnapshot={collectionsAuthority.hasSnapshot}
              message={
                collectionsAuthority.error ?? "Public collections could not load."
              }
              onRetry={() => setCollectionsReloadToken((current) => current + 1)}
            />
          ) : null}
          <div className="grid gap-3 md:grid-cols-3">
            {collectionsAuthority.phase === "loading" &&
            !collectionsAuthority.hasSnapshot ? (
              <CollectionSkeletons />
            ) : collections.length > 0 ? (
              visibleCollections.map((collection) => (
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
                          unoptimized={shouldBypassNextImageOptimizer(src)}
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
                      {countLabel(collection.itemCount ?? 0, "item")}
                      {collection.ownerName ? ` · by ${collection.ownerName}` : ""}
                    </p>
                  </div>
                </div>
              ))
            ) : authorityShowsEmpty(collectionsAuthority, collections.length) ? (
              <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                Public collections appear here.
              </p>
            ) : null}
          </div>
          {orderedCollections.length > visibleCollections.length ? (
            <CommunityShowMoreButton
              label="Show more collections"
              onClick={() =>
                setVisibleCollectionCount((current) =>
                  Math.min(orderedCollections.length, current + 3),
                )
              }
            />
          ) : null}
        </section>
      </div>
    </section>
  );
}

function CommunityCharacterCard({
  character,
  onFollow,
  onEligibleImpression,
  onReport,
}: {
  character: CommunityCharacter;
  onFollow: (creatorId?: string | null) => Promise<void>;
  onEligibleImpression: () => void;
  onReport: (characterId: string) => Promise<void>;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const impressionRecordedRef = useRef(false);
  const detailRecordedRef = useRef(false);
  const exposureContext = character.exposureContext ?? null;

  useEffect(() => {
    const node = cardRef.current;
    if (!node || !exposureContext || typeof IntersectionObserver === "undefined") return;
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
          onEligibleImpression();
          trackCharacterExposure({
            contextToken: exposureContext.contextToken,
            characterId: character.id,
            eventType: "eligible_impression",
            exposureId: exposureContext.impressionExposureId,
            journeyId: exposureContext.journeyId,
            parentExposureId: null,
            placementId: exposureContext.placementId,
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
  }, [character.id, exposureContext, onEligibleImpression]);

  function recordDetailView() {
    if (!exposureContext || !impressionRecordedRef.current || detailRecordedRef.current) return;
    detailRecordedRef.current = true;
    trackCharacterExposure({
      contextToken: exposureContext.contextToken,
      characterId: character.id,
      eventType: "detail_view",
      exposureId: exposureContext.detailExposureId,
      journeyId: exposureContext.journeyId,
      parentExposureId: exposureContext.impressionExposureId,
      placementId: exposureContext.placementId,
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
        href={exposureContext
          ? `/characters/${character.id}?entryExposureId=${encodeURIComponent(exposureContext.detailExposureId)}&journeyId=${encodeURIComponent(exposureContext.journeyId)}&placementId=${encodeURIComponent(exposureContext.placementId)}`
          : `/characters/${character.id}`}
        onClick={recordDetailView}
      >
        <Image
          alt=""
          className="object-cover object-top"
          fill
          sizes="260px"
          src={character.image}
          unoptimized={shouldBypassNextImageOptimizer(character.image)}
        />
      </Link>
      <div className="p-4">
        <h2 className="line-clamp-2 text-[16px] font-black uppercase leading-5">{character.title}</h2>
        <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">
          {(character.likesCount ?? 0) > 0 || (character.chatsCount ?? 0) > 0 ? (
            <>
              {(character.likesCount ?? 0) > 0 ? `${character.likes} likes` : null}
              {(character.likesCount ?? 0) > 0 && (character.chatsCount ?? 0) > 0 ? " · " : null}
              {(character.chatsCount ?? 0) > 0 ? `${character.chats} chats` : null}
            </>
          ) : character.source === "official" ? (
            "Official character"
          ) : (
            "New public character"
          )}
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

function CommunityShowMoreButton({
  label,
  onClick,
}: Readonly<{
  label: string;
  onClick: () => void;
}>) {
  return (
    <div className="mt-5 flex justify-center">
      <button
        className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[12px] font-black text-white hover:bg-[rgb(46,46,46)]"
        onClick={onClick}
        type="button"
      >
        {label}
      </button>
    </div>
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

function CommunityAuthorityNotice({
  hasSnapshot,
  message,
  onRetry,
}: Readonly<{
  hasSnapshot: boolean;
  message: string;
  onRetry: () => void;
}>) {
  return (
    <div
      className="mt-5 flex flex-wrap items-center gap-2 rounded-[12px] border border-[rgb(255,184,112)]/30 bg-[rgb(36,28,18)] px-4 py-3 text-[13px] font-semibold text-[rgb(255,184,112)]"
      role="alert"
    >
      <span>
        {message}
        {hasSnapshot ? " Showing the last loaded results." : ""}
      </span>
      <button
        className="rounded-full bg-white/10 px-3 py-1 text-[12px] font-black text-white"
        onClick={onRetry}
        type="button"
      >
        Retry
      </button>
    </div>
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
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  return payload?.error?.message ?? "Could not update follow.";
}

function communityRequestError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
