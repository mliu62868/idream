"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Bell,
  Bot,
  Coins,
  Copy,
  Download,
  Flag,
  FolderPlus,
  Gift,
  ImageIcon,
  Link2,
  LogOut,
  Pencil,
  Save,
  Scale,
  Search,
  Trash2,
  UserCog,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isBlankImagePreview,
  isBuiltInMediaPlaceholderUrl,
  isPrivateMediaUrl,
} from "@/lib/image-delivery";
import {
  parseLibraryResponse,
  parseMediaCollectionsResponse,
  parseProfileResponse,
  parseProfilePreferencesResponse,
  parseTagListResponse,
  type PublicBillingAccess,
  type PublicSubscriptionRefund,
  type PublicSubscription,
  type RuntimeLibraryItem as LibraryItem,
  type RuntimeMediaCollection as MediaCollection,
} from "@/lib/public-api-contracts";
import {
  authorityShowsEmpty,
  failedAuthorityStatus,
  initialAuthorityStatus,
  loadingAuthorityStatus,
  profileAuthorityStateForResponse,
  readyAuthorityStatus,
} from "./authority-state";
import {
  loadViewerResource,
  requestErrorMessage,
} from "@/lib/viewer-resource-client";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget, authNextTargetFromPath } from "./authRedirect";
import {
  fetchProtectedForViewer,
  type ViewerFetcher,
} from "./viewer-auth";
import { activeEntitlementSummary } from "./entitlement-copy";
import { LegacyTestAssetBadge } from "./LegacyTestAssetBadge";

type ApiErrorPayload = {
  ok?: boolean;
  error?: { message?: string };
};

type ProfileMutationPayload = ApiErrorPayload & {
  data?: {
    user?: {
      displayName?: string | null;
    };
  };
};

type ProfileTag = {
  isMutedByDefault?: boolean;
  isMutedByUser?: boolean;
  label: string;
  publicCharacterCount?: number;
  slug: string;
};

type MediaCollectionCreatePayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    collection?: Pick<MediaCollection, "id" | "visibility">;
  };
};

type AuthState = "loading" | "authenticated" | "anonymous" | "error";
type CharacterEditInput = { name: string; description: string };
type CollectionVisibility = MediaCollection["visibility"];
type ProfileWorkspaceProps = {
  routePath: string;
};

export function profileLibraryCardPresentation(item: LibraryItem) {
  const contentType = item.contentType?.toLowerCase() ?? "";
  const isAudioItem =
    item.type === "voice" || item.type === "audio" || contentType.startsWith("audio/");
  const isMediaItem = item.type === "image" || item.type === "video" || isAudioItem;
  const fallbackMediaTitle = isAudioItem
    ? "Generated voice clip"
    : item.type === "video"
      ? "Generated video"
      : "Generated image";
  const character = item.character;

  return {
    title:
      item.title ??
      item.name ??
      character?.title ??
      character?.name ??
      (isMediaItem ? fallbackMediaTitle : item.id),
    // INTENT: Generated media prompts contain identity-lock and runtime instructions.
    // Keep those searchable, but do not expose implementation text as customer-facing card copy.
    summary: isMediaItem ? null : item.prompt ?? item.description ?? null,
  };
}

export function createdCharacterPublicationStatus(input: {
  status?: string | null;
  visibility?: string | null;
  publicationState?: string | null;
}) {
  if (input.visibility === "public" && input.publicationState === "live") return "live";
  if (
    input.visibility === "public" &&
    (
      input.publicationState === "awaiting_publication" ||
      (input.publicationState === undefined && input.status === "approved")
    )
  ) {
    return "approved · awaiting publication";
  }
  return input.status?.replaceAll("_", " ") ?? "";
}

export function accountDeletionLoginHref(payload: unknown) {
  const value = payload as {
    data?: { deletion?: { graceEndsAt?: unknown } };
  } | null;
  const raw = value?.data?.deletion?.graceEndsAt;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
    return "/login";
  }
  const params = new URLSearchParams({
    accountDeletionGraceEndsAt: new Date(raw).toISOString(),
  });
  return `/login?${params.toString()}`;
}

export function loadProfileForViewer(fetcher: ViewerFetcher = fetch) {
  return fetchProtectedForViewer(
    "/api/v1/profile",
    { cache: "no-store" },
    fetcher,
  );
}

const tabs = ["recent", "characters", "created", "presets", "media", "group-chats", "packs"] as const;
type LibraryTab = (typeof tabs)[number];

const tabLabels: Record<LibraryTab, string> = {
  recent: "recent",
  characters: "characters",
  created: "created",
  presets: "presets",
  media: "media",
  "group-chats": "group chats",
  packs: "packs",
};

function emptyStateForTab(tab: LibraryTab, emptyCta: string | null) {
  const defaults: Record<
    LibraryTab,
    { title: string; copy: string; ctaHref: string | null; ctaLabel: string }
  > = {
    recent: {
      title: "No recent activity",
      copy: "Create a character, start a chat, or generate media to fill this tab.",
      ctaHref: "/create",
      ctaLabel: "Create",
    },
    characters: {
      title: "No saved characters",
      copy: "Like public companions from Explore to keep them here.",
      ctaHref: "/",
      ctaLabel: "Explore",
    },
    created: {
      title: "No created characters",
      copy: "Build a private companion or submit a public character for review.",
      ctaHref: "/create",
      ctaLabel: "Create",
    },
    presets: {
      title: "No presets yet",
      copy: "Create image presets from Generate to reuse backgrounds, poses, and outfits.",
      ctaHref: "/generate",
      ctaLabel: "Generate",
    },
    media: {
      title: "No media yet",
      copy: "Generated images and voice clips appear here.",
      ctaHref: "/generate",
      ctaLabel: "Generate",
    },
    "group-chats": {
      title: "Group chats are not in this beta",
      copy: "One-on-one companion chat is available now. This tab stays empty until group chat launches.",
      ctaHref: null,
      ctaLabel: "",
    },
    packs: {
      title: "Packs are not in this beta",
      copy: "Saved bundles will appear here when packs are enabled. Current beta keeps characters and presets separate.",
      ctaHref: null,
      ctaLabel: "",
    },
  };
  return { ...defaults[tab], ctaHref: emptyCta ?? defaults[tab].ctaHref };
}

const profileDeepLinkTargets: Record<string, { selector: string; focusSelector: string }> = {
  "/profile/redeem-code": {
    selector: "[data-testid='profile-redeem-panel']",
    focusSelector: "[aria-label='Redeem code input']",
  },
  "/profile/notifications": {
    selector: "[data-testid='profile-notifications-panel']",
    focusSelector: "[aria-label='Product updates']",
  },
  "/profile/account-management": {
    selector: "[data-testid='profile-account-management-panel']",
    focusSelector: "[aria-label='Delete confirmation']",
  },
};

function focusProfileDeepLink() {
  const target = profileDeepLinkTargets[window.location.pathname];
  if (!target) return;
  window.setTimeout(() => {
    const panel = document.querySelector<HTMLElement>(target.selector);
    panel?.scrollIntoView({ block: "center" });
    document.querySelector<HTMLElement>(target.focusSelector)?.focus({ preventScroll: true });
  }, 50);
}

export function ProfileWorkspace({ routePath }: Readonly<ProfileWorkspaceProps>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authTarget, setAuthTarget] = useState("/profile");
  const [profileAuthority, setProfileAuthority] = useState(initialAuthorityStatus);
  const [balance, setBalance] = useState<number | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<PublicSubscription | null>(null);
  const [billingAccess, setBillingAccess] =
    useState<PublicBillingAccess | null>(null);
  const [refund, setRefund] = useState<PublicSubscriptionRefund | null>(null);
  const [entitlements, setEntitlements] = useState<Record<string, unknown>>({});
  const [displayName, setDisplayName] = useState("");
  const [profileName, setProfileName] = useState("");
  const [tab, setTab] = useState<LibraryTab>("recent");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [libraryAuthority, setLibraryAuthority] = useState(initialAuthorityStatus);
  const [emptyCta, setEmptyCta] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [emailUpdates, setEmailUpdates] = useState<boolean | null>(null);
  const [mutedTags, setMutedTags] = useState<string[]>([]);
  const [preferencesAuthority, setPreferencesAuthority] = useState(initialAuthorityStatus);
  const [preferenceTags, setPreferenceTags] = useState<ProfileTag[]>([]);
  const [preferenceTagsAuthority, setPreferenceTagsAuthority] = useState(
    initialAuthorityStatus,
  );
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteConfirmMediaId, setDeleteConfirmMediaId] = useState<string | null>(null);
  const [deleteConfirmCharacterId, setDeleteConfirmCharacterId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [referralUrl, setReferralUrl] = useState("");
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(new Set());
  const [invalidPreviewImageIds, setInvalidPreviewImageIds] = useState<Set<string>>(new Set());
  const [mediaCollections, setMediaCollections] = useState<MediaCollection[]>([]);
  const [mediaCollectionsAuthority, setMediaCollectionsAuthority] = useState(
    initialAuthorityStatus,
  );
  const [publishedCollectionHref, setPublishedCollectionHref] = useState("");
  const libraryTabRef = useRef<LibraryTab | null>(null);
  const profileRequestSerialRef = useRef(0);
  const libraryRequestSerialRef = useRef(0);
  const mediaCollectionsRequestSerialRef = useRef(0);
  const preferencesRequestSerialRef = useRef(0);

  const showAnonymousProfile = useCallback(() => {
    libraryRequestSerialRef.current += 1;
    mediaCollectionsRequestSerialRef.current += 1;
    preferencesRequestSerialRef.current += 1;
    libraryTabRef.current = null;
    setAuthState("anonymous");
    setProfileAuthority(readyAuthorityStatus());
    setBalance(null);
    setPlan(null);
    setSubscription(null);
    setBillingAccess(null);
    setRefund(null);
    setEntitlements({});
    setDisplayName("");
    setProfileName("");
    setItems([]);
    setLibraryAuthority(initialAuthorityStatus());
    setEmailUpdates(null);
    setMutedTags([]);
    setPreferencesAuthority(initialAuthorityStatus());
    setPreferenceTags([]);
    setPreferenceTagsAuthority(initialAuthorityStatus());
    setMediaCollections([]);
    setMediaCollectionsAuthority(initialAuthorityStatus());
  }, []);

  const refreshProfile = useCallback(async () => {
    const requestSerial = profileRequestSerialRef.current + 1;
    profileRequestSerialRef.current = requestSerial;
    setProfileAuthority(loadingAuthorityStatus);
    setAuthState((current) =>
      current === "authenticated" ? "authenticated" : "loading",
    );
    try {
      const result = await loadProfileForViewer();
      if (requestSerial !== profileRequestSerialRef.current) return;
      if (result.viewer === "anonymous") {
        showAnonymousProfile();
        return;
      }
      const response = result.response;
      const responseState = profileAuthorityStateForResponse(response);
      if (responseState === "anonymous") {
        showAnonymousProfile();
        return;
      }
      const rawPayload: unknown = await response.json().catch(() => null);
      if (requestSerial !== profileRequestSerialRef.current) return;
      if (responseState === "error") {
        const errorPayload = rawPayload as ApiErrorPayload | null;
        throw new Error(
          errorPayload?.error?.message ?? "Account data could not load.",
        );
      }
      const profileData = parseProfileResponse(rawPayload);
      const user = profileData.user;
      const nextName = user?.displayName?.trim() || user?.email?.trim() || "";
      if (!nextName) {
        throw new Error("Account data was incomplete.");
      }
      setAuthState("authenticated");
      setDisplayName(nextName);
      setProfileName(nextName);
      setBalance(profileData.balance);
      setSubscription(profileData.subscription);
      setBillingAccess(profileData.billingAccess);
      setRefund(profileData.refund);
      setEntitlements(profileData.entitlements);
      setPlan(
        profileData.subscription?.plan
          ? `${profileData.subscription.plan.name} ${profileData.subscription.plan.billingPeriod}`
          : profileData.subscription
            ? "Paid access · purchased offer unavailable"
            : "Free",
      );
      setProfileAuthority(readyAuthorityStatus());
    } catch (error) {
      if (requestSerial !== profileRequestSerialRef.current) return;
      setProfileAuthority((current) =>
        failedAuthorityStatus(
          current,
          requestErrorMessage(error, "Account data could not load."),
        ),
      );
      setAuthState((current) =>
        current === "authenticated" ? "authenticated" : "error",
      );
    }
  }, [showAnonymousProfile]);

  const refreshLibrary = useCallback(async (nextTab: LibraryTab) => {
    const requestSerial = libraryRequestSerialRef.current + 1;
    libraryRequestSerialRef.current = requestSerial;
    const hasMatchingSnapshot = libraryTabRef.current === nextTab;
    if (!hasMatchingSnapshot) {
      libraryTabRef.current = nextTab;
      setItems([]);
      setEmptyCta(null);
    }
    setLibraryAuthority((current) =>
      loadingAuthorityStatus(
        hasMatchingSnapshot ? current : initialAuthorityStatus(),
      ),
    );
    const outcome = await loadViewerResource({
      path: `/api/v1/library/${nextTab}`,
      parse: parseLibraryResponse,
      fallbackError: "Library data could not load.",
      errorFrom: "fallback",
      isCurrent: () => requestSerial === libraryRequestSerialRef.current,
    });
    if (outcome.kind === "discarded") return;
    if (outcome.kind === "failed") {
      setLibraryAuthority((current) =>
        failedAuthorityStatus(current, outcome.error),
      );
      return;
    }
    setItems(outcome.data.items);
    setEmptyCta(outcome.data.emptyCta);
    setLibraryAuthority(readyAuthorityStatus());
  }, []);

  const refreshMediaCollections = useCallback(async () => {
    const requestSerial = mediaCollectionsRequestSerialRef.current + 1;
    mediaCollectionsRequestSerialRef.current = requestSerial;
    setMediaCollectionsAuthority(loadingAuthorityStatus);
    const outcome = await loadViewerResource({
      path: "/api/v1/media/collections",
      parse: (raw) => parseMediaCollectionsResponse(raw).collections,
      fallbackError: "Media collections could not load.",
      isCurrent: () =>
        requestSerial === mediaCollectionsRequestSerialRef.current,
    });
    if (outcome.kind === "discarded") return;
    if (outcome.kind === "failed") {
      setMediaCollectionsAuthority((current) =>
        failedAuthorityStatus(current, outcome.error),
      );
      return;
    }
    setMediaCollections(outcome.data);
    setMediaCollectionsAuthority(readyAuthorityStatus());
  }, []);

  const refreshPreferences = useCallback(async () => {
    const requestSerial = preferencesRequestSerialRef.current + 1;
    preferencesRequestSerialRef.current = requestSerial;
    setPreferencesAuthority(loadingAuthorityStatus);
    const isCurrent = () =>
      requestSerial === preferencesRequestSerialRef.current;

    const preferencesOutcome = await loadViewerResource({
      path: "/api/v1/profile/preferences",
      parse: (raw) => parseProfilePreferencesResponse(raw).preferences,
      fallbackError: "Preferences could not load.",
      errorFrom: "fallback",
      isCurrent,
    });
    // INVARIANT: a superseded preferences response abandons the whole refresh,
    // tags included — a newer refresh is already loading both.
    if (preferencesOutcome.kind === "discarded") return;
    if (preferencesOutcome.kind === "failed") {
      setPreferencesAuthority((current) =>
        failedAuthorityStatus(current, preferencesOutcome.error),
      );
    } else {
      const notificationSettings =
        preferencesOutcome.data.notificationSettings ?? {};
      setEmailUpdates(notificationSettings.productUpdates === true);
      setMutedTags(preferencesOutcome.data.mutedTags ?? []);
      setPreferencesAuthority(readyAuthorityStatus());
    }

    // INVARIANT: the tags read runs even when preferences failed — the two
    // panels report their authority separately, as they did before.
    setPreferenceTagsAuthority(loadingAuthorityStatus);
    const tagsOutcome = await loadViewerResource({
      path: "/api/v1/tags",
      parse: (raw) =>
        parseTagListResponse(raw).items.filter(
          (tag) => !tag.isMutedByDefault && (tag.publicCharacterCount ?? 0) > 0,
        ),
      fallbackError: "Preference tags could not load.",
      errorFrom: "fallback",
      isCurrent,
    });
    if (tagsOutcome.kind === "discarded") return;
    if (tagsOutcome.kind === "failed") {
      setPreferenceTagsAuthority((current) =>
        failedAuthorityStatus(current, tagsOutcome.error),
      );
      return;
    }
    setPreferenceTags(tagsOutcome.data);
    setPreferenceTagsAuthority(readyAuthorityStatus());
  }, []);

  // Defer initial loads to a macrotask so the first render commits before any setState
  // (matches ExploreWorkspace/FeedWorkspace; avoids react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => {
      void refreshProfile();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, refreshProfile]);

  useEffect(() => {
    function syncAuthTarget() {
      setAuthTarget(
        authNextTargetFromPath(
          window.location.pathname,
          window.location.search,
          window.location.hash,
        ) ?? "/profile",
      );
    }

    syncAuthTarget();
    window.addEventListener("hashchange", syncAuthTarget);
    return () => window.removeEventListener("hashchange", syncAuthTarget);
  }, []);

  useEffect(() => {
    if (!ageGateAccepted || authState !== "authenticated") return;
    const timer = window.setTimeout(() => void refreshPreferences(), 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, authState, refreshPreferences]);

  useEffect(() => {
    if (!ageGateAccepted || authState !== "authenticated") return;
    focusProfileDeepLink();
  }, [ageGateAccepted, authState]);

  useEffect(() => {
    if (!ageGateAccepted || authState !== "authenticated") return;
    const timer = window.setTimeout(() => void refreshLibrary(tab), 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, authState, refreshLibrary, tab]);

  useEffect(() => {
    if (
      !ageGateAccepted ||
      authState !== "authenticated" ||
      tab !== "media"
    ) {
      return;
    }
    const timer = window.setTimeout(() => void refreshMediaCollections(), 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, authState, refreshMediaCollections, tab]);

  async function redeem() {
    setStatus("");
    const code = redeemCode.trim();
    if (!code) {
      setStatus("Enter a code.");
      return;
    }
    try {
      const response = await fetch("/api/v1/redeem-codes/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = (await response.json()) as ApiErrorPayload;
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Redeem failed");
        return;
      }
      setStatus("Code redeemed.");
      await refreshProfile();
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function invite() {
    setStatus("");
    try {
      const response = await fetch("/api/v1/referrals/invite", { method: "POST" });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string };
        data?: { shareUrl?: string };
      };
      const shareUrl = payload.data?.shareUrl;
      if (!response.ok || payload.ok === false || !shareUrl) {
        setReferralUrl("");
        setStatus(payload.error?.message ?? "Referral invite failed.");
        return;
      }
      setReferralUrl(new URL(shareUrl, window.location.origin).toString());
      setStatus("Referral invite ready.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function copyReferralUrl() {
    if (!referralUrl) return;
    try {
      await navigator.clipboard.writeText(referralUrl);
      setStatus("Referral link copied.");
    } catch {
      setStatus("Copy failed. Select the link manually.");
    }
  }

  async function saveProfile() {
    const nextName = profileName.trim();
    if (!nextName) {
      setStatus("Enter a display name.");
      return;
    }
    try {
      const response = await fetch("/api/v1/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: nextName }),
      });
      const payload = (await response.json()) as ProfileMutationPayload;
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Profile update failed.");
        return;
      }
      setDisplayName(payload.data?.user?.displayName ?? nextName);
      setProfileName(payload.data?.user?.displayName ?? nextName);
      setStatus("Profile updated.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function savePreferences() {
    if (emailUpdates === null) {
      setStatus("Load your saved preferences before updating them.");
      return;
    }
    try {
      const response = await fetch("/api/v1/profile/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mutedTags,
          notificationSettings: { productUpdates: emailUpdates },
        }),
      });
      if (response.ok) setPreferencesAuthority(readyAuthorityStatus());
      setStatus(response.ok ? "Preferences updated." : "Preferences update failed.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  function toggleMutedTag(slug: string, checked: boolean) {
    setMutedTags((current) => {
      if (checked) return current.includes(slug) ? current : [...current, slug];
      return current.filter((item) => item !== slug);
    });
  }

  async function signOutEverywhere() {
    try {
      const response = await fetch("/api/v1/account/sign-out-all", { method: "POST" });
      if (response.ok) {
        window.location.href = "/login";
        return;
      }
      setStatus("Sign out failed.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function requestAccountDeletion() {
    if (deleteConfirm !== "DELETE") {
      setStatus("Type DELETE to confirm account deletion.");
      return;
    }
    try {
      const response = await fetch("/api/v1/account/delete-request", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        window.location.href = accountDeletionLoginHref(payload);
        return;
      }
      setStatus("Account deletion failed.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function deleteMedia(id: string) {
    setStatus("");
    if (deleteConfirmMediaId !== id) {
      setDeleteConfirmMediaId(id);
      setStatus("Press Confirm delete to remove this media.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/media/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setStatus("Delete failed.");
        return;
      }
      setStatus("Media deleted.");
      setDeleteConfirmMediaId(null);
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function downloadMedia(id: string) {
    setStatus("");
    try {
      const response = await fetch(`/api/v1/media/${id}/download`);
      if (!response.ok) {
        setStatus("Download failed.");
        return;
      }
      const payload = (await response.json()) as { data?: { url?: string } };
      if (payload.data?.url) {
        triggerDownload(payload.data.url);
        setStatus("Download started.");
      } else {
        setStatus("Download failed.");
      }
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function duplicateCharacter(id: string) {
    setStatus("");
    setDeleteConfirmCharacterId(null);
    try {
      const response = await fetch(`/api/v1/characters/${id}/duplicate`, { method: "POST" });
      if (!response.ok) {
        setStatus("Duplicate failed.");
        return;
      }
      setStatus("Character duplicated to your created tab.");
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function updateCharacterDetails(id: string, input: CharacterEditInput) {
    setStatus("");
    const name = input.name.trim();
    const description = input.description.trim();
    if (!name) {
      setStatus("Enter a character name.");
      return false;
    }
    if (!description) {
      setStatus("Enter a character description.");
      return false;
    }
    try {
      const response = await fetch(`/api/v1/characters/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Character update failed.");
        return false;
      }
      setStatus("Character updated.");
      await refreshLibrary(tab);
      return true;
    } catch {
      setStatus("Network error. Please try again.");
      return false;
    }
  }

  async function deleteCharacter(id: string) {
    setStatus("");
    if (deleteConfirmCharacterId !== id) {
      setDeleteConfirmCharacterId(id);
      setStatus("Press Confirm delete to remove this character.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/characters/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setStatus("Delete failed.");
        return;
      }
      setStatus("Character deleted.");
      setDeleteConfirmCharacterId(null);
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function toggleCharacterVisibility(id: string, current?: string) {
    // public characters re-enter review on publish; private/unlisted publish straight to review.
    setStatus("");
    setDeleteConfirmCharacterId(null);
    const next = current === "public" ? "private" : "public";
    try {
      const response = await fetch(`/api/v1/characters/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!response.ok) {
        setStatus("Visibility update failed.");
        return;
      }
      setStatus(
        next === "public"
          ? "Submitted for review. Approval starts publication preparation; the character goes live after Release is published."
          : "Character set to private.",
      );
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function reportMedia(id: string) {
    setStatus("");
    try {
      const response = await fetch("/api/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType: "media",
          targetId: id,
          category: "other_prohibited_content",
          description: "Media report",
        }),
      });
      setStatus(response.ok ? "Report submitted." : "Report failed.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function createMediaCollection(
    mediaAssetId: string,
    input: { name: string; visibility: CollectionVisibility },
  ) {
    setStatus("");
    setPublishedCollectionHref("");
    const name = input.name.trim();
    if (!name) {
      setStatus("Name the collection first.");
      return;
    }
    try {
      const response = await fetch("/api/v1/media/collections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mediaAssetId,
          name,
          visibility: input.visibility,
        }),
      });
      const payload = (await response.json()) as MediaCollectionCreatePayload;
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Collection create failed.");
        return;
      }
      if (input.visibility === "public") {
        const collectionId = payload.data?.collection?.id;
        setPublishedCollectionHref(
          collectionId ? `/community?collection=${encodeURIComponent(collectionId)}` : "/community",
        );
      }
      setStatus(
        input.visibility === "public"
          ? "Collection published to Community."
          : "Collection created.",
      );
      await refreshMediaCollections();
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function addMediaToCollection(mediaAssetId: string, collectionId: string) {
    setStatus("");
    if (!collectionId) {
      setStatus("Choose a collection first.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/media/collections/${collectionId}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaAssetId }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Could not add media to collection.");
        return;
      }
      setStatus("Added to collection.");
      await refreshMediaCollections();
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? items.filter((item) =>
        `${item.title ?? ""} ${item.name ?? ""} ${item.character?.name ?? ""} ${item.prompt ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : items;
  const isCreatedTab = tab === "created";
  const emptyState = emptyStateForTab(tab, emptyCta);
  const benefitsPeriod = billingAccess?.benefitsEndAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
        new Date(billingAccess.benefitsEndAt),
      )
    : "the displayed access period";
  const renewalPeriod = billingAccess?.renewsAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
        new Date(billingAccess.renewsAt),
      )
    : null;
  const billingStatus = subscription && billingAccess
    ? billingAccess.billingModel === "prepaid_period"
      ? `Benefits active until ${benefitsPeriod} · no automatic renewal`
      : renewalPeriod
        ? `Renews ${renewalPeriod}`
        : `Benefits active until ${benefitsPeriod}`
    : plan
      ? "No active paid access"
      : "Billing and access status unavailable";
  const refundStatus = refund
    ? refund.state === "completed"
      ? `Full refund completed · ${refund.reversedDreamcoins.toLocaleString()} Dreamcoins reversed · balance ${refund.balanceAfter.toLocaleString()}`
      : refund.state === "canceled"
        ? `Refund canceled · subscription access and ${refund.reversedDreamcoins.toLocaleString()} Dreamcoins restored`
        : `Full refund ${refund.state.replaceAll("_", " ")} · access frozen · ${refund.reversedDreamcoins.toLocaleString()} Dreamcoins reversed`
    : null;
  const isMyAiRoute = routePath.startsWith("/custom");
  const workspaceTitle = isMyAiRoute ? "My AI" : "Profile";
  const authRequiredTitle = isMyAiRoute ? "Sign in to open My AI" : "Sign in to open Profile";
  const authRequiredCopy = isMyAiRoute
    ? "Your characters, generated media, presets, and created companions live in your private My AI library."
    : "Your account settings, billing, referrals, preferences, and private AI library live in your profile.";

  function selectLibraryTab(nextTab: LibraryTab) {
    if (nextTab === tab) return;
    libraryRequestSerialRef.current += 1;
    libraryTabRef.current = nextTab;
    setItems([]);
    setEmptyCta(null);
    setLibraryAuthority(initialAuthorityStatus());
    setTab(nextTab);
  }

  if (authState === "loading") {
    return (
      <section className="px-4 py-10 md:px-[60px]">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[38px] font-black uppercase leading-10 text-white">
            {workspaceTitle}
          </h1>
          <div className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center">
            <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
            <h2 className="mt-4 text-[22px] font-black uppercase text-white">
              Loading your account
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
              Fetching your library, balance, and billing state.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (authState === "error") {
    return (
      <section className="px-4 py-10 md:px-[60px]">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[38px] font-black uppercase leading-10 text-white">
            {workspaceTitle}
          </h1>
          <div
            className="mt-6 rounded-[20px] border border-[rgb(255,184,112)]/30 bg-[rgb(18,18,18)] p-10 text-center"
            data-testid="profile-unavailable"
            role="alert"
          >
            <Bot className="mx-auto h-10 w-10 text-[rgb(255,184,112)]" />
            <h2 className="mt-4 text-[22px] font-black uppercase text-white">
              Account unavailable
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
              {profileAuthority.error ??
                "We couldn't verify your account data. No private account details are being shown."}
            </p>
            <button
              className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-black text-[rgb(13,13,13)]"
              onClick={() => void refreshProfile()}
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (authState === "anonymous") {
    return (
      <section className="px-4 py-10 md:px-[60px]">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[38px] font-black uppercase leading-10 text-white">
            {workspaceTitle}
          </h1>
          <div
            className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center"
            data-testid="profile-auth-required"
          >
            <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
            <h2 className="mt-4 text-[22px] font-black uppercase text-white">
              {authRequiredTitle}
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
              {authRequiredCopy}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-black text-[rgb(13,13,13)]"
                href={authHrefForTarget("/login", authTarget)}
              >
                Log in
              </Link>
              <Link
                className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
                href={authHrefForTarget("/signup", authTarget)}
              >
                Join Free
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 py-10 md:px-[60px]">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[38px] font-black uppercase leading-10 text-white">
              {workspaceTitle}
            </h1>
            <p className="mt-2 text-[14px] font-semibold text-white">{displayName}</p>
            {balance !== null && plan ? (
              <p className="mt-3 flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)]">
                <Coins className="h-4 w-4 text-[rgb(253,95,194)]" />
                {balance.toLocaleString()} dreamcoins · {plan}
              </p>
            ) : null}
            {profileAuthority.phase === "error" ? (
              <ProfileAuthorityNotice
                hasSnapshot={profileAuthority.hasSnapshot}
                message={
                  profileAuthority.error ?? "Account data could not refresh."
                }
                onRetry={() => void refreshProfile()}
              />
            ) : null}
            {profileAuthority.phase === "loading" &&
            profileAuthority.hasSnapshot ? (
              <p className="mt-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                Refreshing account data…
              </p>
            ) : null}
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
            href="/upgrade"
          >
            Upgrade
          </Link>
        </div>
        {/* Surface only entitlements returned by the account authority. */}
        <div className="mt-6 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-[rgb(114,113,112)]">
            Current entitlements
          </p>
          <p className="mt-2 text-[14px] font-semibold leading-6 text-white">
            {plan
              ? activeEntitlementSummary(entitlements, subscription !== null)
              : "Plan details are unavailable until account data loads."}
          </p>
        </div>
        <div aria-label="Library sections" className="mt-6 flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button
              aria-pressed={tab === item}
              className={`h-10 rounded-full px-4 text-[13px] font-bold ${
                tab === item ? "bg-[rgb(46,46,46)] text-white" : "text-[rgb(170,170,170)]"
              }`}
              key={item}
              onClick={() => selectLibraryTab(item)}
              type="button"
            >
              {tabLabels[item]}
            </button>
          ))}
        </div>
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          <label
            className="rounded-[14px] bg-[rgb(18,18,18)] p-4 text-[12px] font-bold uppercase text-[rgb(114,113,112)]"
            data-testid="profile-redeem-panel"
            id="redeem-code"
          >
            Redeem
            <div className="mt-2 flex gap-2">
              <input
                aria-label="Redeem code input"
                className="min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] normal-case text-white outline-none"
                onChange={(event) => setRedeemCode(event.target.value)}
                placeholder="Enter code"
                value={redeemCode}
              />
              <button
                aria-label="Redeem code"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-[rgb(13,13,13)]"
                onClick={redeem}
                type="button"
              >
                <Gift className="h-4 w-4" />
              </button>
            </div>
          </label>
          <div className="rounded-[14px] bg-[rgb(18,18,18)] p-4">
            <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Referral</p>
            <button
              className="mt-2 inline-flex h-10 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
              onClick={invite}
              type="button"
            >
              <Link2 className="h-4 w-4" />
              Invite
            </button>
          </div>
          <div
            className="rounded-[14px] bg-[rgb(18,18,18)] p-4"
            data-testid="profile-billing-card"
            id="billing"
          >
            <p className="text-[13px] font-black uppercase text-white">
              Billing &amp; access
            </p>
            <p className="mt-2 text-[12px] font-bold text-[rgb(170,170,170)]">
              {plan ?? "Plan unavailable"}
            </p>
            <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">{billingStatus}</p>
            {refund && refundStatus ? (
              <div className="mt-3 rounded-[10px] bg-[rgb(29,29,29)] p-3" data-testid="profile-refund-status">
                <p className="text-[12px] font-bold text-white">{refundStatus}</p>
                <p className="mt-1 text-[11px] font-medium text-[rgb(170,170,170)]">
                  Refund reference {refund.reference}
                </p>
                {refund.claimUrl ? (
                  <a className="mt-2 inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]" href={refund.claimUrl} rel="noreferrer" target="_blank">
                    Claim refund
                  </a>
                ) : null}
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {!plan && profileAuthority.phase === "error" ? (
                <button
                  className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                  onClick={() => void refreshProfile()}
                  type="button"
                >
                  Retry account data
                </button>
              ) : subscription ? (
                <Link
                  className="inline-flex h-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[12px] font-bold text-white"
                  href="/upgrade"
                >
                  Change plan
                </Link>
              ) : (
                <Link
                  className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                  href="/upgrade"
                >
                  Compare plans
                </Link>
              )}
            </div>
          </div>
        </div>
        {(status || referralUrl) && (
          <div className="mt-4 space-y-3">
            {status && (
              <div className="flex flex-wrap items-center gap-2">
                <p
                  aria-live="polite"
                  className="text-[13px] font-semibold text-[rgb(170,170,170)]"
                  data-testid="profile-status"
                  role="status"
                >
                  {status}
                </p>
                {publishedCollectionHref && status === "Collection published to Community." && (
                  <Link
                    className="inline-flex h-8 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-3 text-[12px] font-bold text-white"
                    href={publishedCollectionHref}
                  >
                    View in Community
                  </Link>
                )}
              </div>
            )}
            {referralUrl && (
              <div className="flex max-w-xl items-center gap-2">
                <input
                  aria-label="Referral link"
                  className="h-10 min-w-0 flex-1 rounded-[12px] bg-[rgb(18,18,18)] px-3 text-[12px] font-semibold text-[rgb(230,230,230)] outline-none"
                  readOnly
                  value={referralUrl}
                />
                <button
                  aria-label="Copy invite link"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-white"
                  onClick={copyReferralUrl}
                  title="Copy invite link"
                  type="button"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        )}
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <div className="rounded-[14px] bg-[rgb(18,18,18)] p-4">
            <p className="flex items-center gap-2 text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              <UserCog className="h-4 w-4" />
              Account settings
            </p>
            <label className="mt-3 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Display name
              <div className="mt-2 flex gap-2">
                <input
                  aria-label="Display name"
                  className="min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] normal-case text-white outline-none"
                  onChange={(event) => setProfileName(event.target.value)}
                  value={profileName}
                />
                <button
                  aria-label="Save profile"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-[rgb(13,13,13)]"
                  onClick={saveProfile}
                  type="button"
                >
                  <Save className="h-4 w-4" />
                </button>
              </div>
            </label>
            <div
              className="mt-4 rounded-[10px] bg-[rgb(36,36,36)] p-3"
              data-testid="profile-notifications-panel"
              id="notifications"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[13px] font-semibold text-white">
                  <input
                    aria-label="Product updates"
                    checked={emailUpdates ?? false}
                    className="h-4 w-4 accent-[rgb(253,95,194)]"
                    disabled={emailUpdates === null}
                    onChange={(event) => setEmailUpdates(event.target.checked)}
                    type="checkbox"
                  />
                  Product updates
                </label>
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-full bg-black/30 px-3 text-[12px] font-bold text-white disabled:opacity-50"
                  disabled={emailUpdates === null}
                  onClick={savePreferences}
                  type="button"
                >
                  <Bell className="h-4 w-4" />
                  Save preferences
                </button>
              </div>
              {preferencesAuthority.phase === "loading" &&
              !preferencesAuthority.hasSnapshot ? (
                <p className="mt-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                  Loading saved preferences…
                </p>
              ) : null}
              {preferencesAuthority.phase === "error" ? (
                <ProfileAuthorityNotice
                  hasSnapshot={preferencesAuthority.hasSnapshot}
                  message={
                    preferencesAuthority.error ?? "Preferences could not load."
                  }
                  onRetry={() => void refreshPreferences()}
                />
              ) : null}
              {preferenceTagsAuthority.phase === "error" ? (
                <ProfileAuthorityNotice
                  hasSnapshot={preferenceTagsAuthority.hasSnapshot}
                  message={
                    preferenceTagsAuthority.error ??
                    "Preference tags could not load."
                  }
                  onRetry={() => void refreshPreferences()}
                />
              ) : null}
              {preferenceTagsAuthority.phase === "loading" &&
              !preferenceTagsAuthority.hasSnapshot ? (
                <p className="mt-3 text-[12px] font-semibold text-[rgb(170,170,170)]">
                  Loading available tags…
                </p>
              ) : null}
              {preferenceTags.length > 0 ? (
                <div className="mt-4 border-t border-white/10 pt-3">
                  <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
                    Muted tags
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {preferenceTags.map((tag) => (
                      <label
                        className="flex min-h-9 items-center gap-2 rounded-[8px] bg-black/20 px-3 text-[12px] font-semibold text-white"
                        key={tag.slug}
                      >
                        <input
                          aria-label={`Mute ${tag.label}`}
                          checked={mutedTags.includes(tag.slug)}
                          className="h-4 w-4 accent-[rgb(253,95,194)]"
                          onChange={(event) => toggleMutedTag(tag.slug, event.target.checked)}
                          type="checkbox"
                        />
                        <span className="min-w-0 truncate">{tag.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div
            className="rounded-[14px] bg-[rgb(18,18,18)] p-4"
            data-testid="profile-account-management-panel"
            id="account-management"
          >
            <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Account management
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="inline-flex h-10 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                onClick={signOutEverywhere}
                type="button"
              >
                <LogOut className="h-4 w-4" />
                Sign out all sessions
              </button>
            </div>
            <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
              Delete account
              <span className="mt-1 block text-[11px] font-medium normal-case leading-5 text-[rgb(154,153,152)]">
                Access ends immediately. Personal data is erased after the account-deletion grace period.
              </span>
              <div className="mt-2 flex gap-2">
                <input
                  aria-label="Delete confirmation"
                  className="min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] normal-case text-white outline-none"
                  onChange={(event) => setDeleteConfirm(event.target.value)}
                  placeholder="Type DELETE"
                  value={deleteConfirm}
                />
                <button
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-[rgb(120,25,40)] px-4 text-[12px] font-black text-white disabled:opacity-40"
                  disabled={deleteConfirm !== "DELETE"}
                  onClick={requestAccountDeletion}
                  type="button"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              </div>
            </label>
          </div>
        </div>
        <div className="mt-6 flex items-center gap-2 rounded-[12px] bg-[rgb(18,18,18)] px-3">
          <Search className="h-4 w-4 text-[rgb(114,113,112)]" />
          <input
            aria-label="Search your library"
            className="h-11 min-w-0 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-[rgb(114,113,112)]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${tabLabels[tab]}…`}
            value={query}
          />
          {query && (
            <button
              aria-label="Clear search"
              className="text-[12px] font-bold text-[rgb(170,170,170)] hover:text-white"
              onClick={() => setQuery("")}
              type="button"
            >
              Clear
            </button>
          )}
        </div>
        {tab === "media" && mediaCollectionsAuthority.phase === "error" ? (
          <ProfileAuthorityNotice
            hasSnapshot={mediaCollectionsAuthority.hasSnapshot}
            message={
              mediaCollectionsAuthority.error ??
              "Media collections could not load."
            }
            onRetry={() => void refreshMediaCollections()}
          />
        ) : null}
        {tab === "media" &&
        mediaCollectionsAuthority.phase === "loading" &&
        !mediaCollectionsAuthority.hasSnapshot ? (
          <p className="mt-4 text-[12px] font-semibold text-[rgb(170,170,170)]">
            Loading media collections…
          </p>
        ) : null}
        <div className="mt-4 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-6">
          {libraryAuthority.phase === "error" ? (
            <ProfileAuthorityNotice
              hasSnapshot={libraryAuthority.hasSnapshot}
              message={libraryAuthority.error ?? "Library data could not load."}
              onRetry={() => void refreshLibrary(tab)}
            />
          ) : null}
          {libraryAuthority.phase === "loading" &&
          libraryAuthority.hasSnapshot ? (
            <p className="mb-4 text-[12px] font-semibold text-[rgb(170,170,170)]">
              Refreshing this tab. Showing the last loaded items.
            </p>
          ) : null}
          {libraryAuthority.phase === "loading" &&
          !libraryAuthority.hasSnapshot ? (
            <div className="p-10 text-center">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">
                Loading this tab
              </h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Fetching your private library data.
              </p>
            </div>
          ) : visibleItems.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {visibleItems.map((item, index) => (
                <LibraryCard
                  failedImageIds={failedImageIds}
                  imageLoading={index < 3 ? "eager" : "lazy"}
                  invalidPreviewImageIds={invalidPreviewImageIds}
                  item={item}
                  key={item.id}
                  onDelete={deleteMedia}
                  onDownload={downloadMedia}
                  onImageError={(id) =>
                    setFailedImageIds((current) => {
                      if (current.has(id)) return current;
                      const next = new Set(current);
                      next.add(id);
                      return next;
                    })
                  }
                  onInvalidImagePreview={(id) =>
                    setInvalidPreviewImageIds((current) => {
                      if (current.has(id)) return current;
                      const next = new Set(current);
                      next.add(id);
                      return next;
                    })
                  }
                  onReport={reportMedia}
                  collections={mediaCollections}
                  onCreateCollection={createMediaCollection}
                  onAddToCollection={addMediaToCollection}
                  showCharacterActions={isCreatedTab}
                  onUpdateCharacter={updateCharacterDetails}
                  onDuplicateCharacter={duplicateCharacter}
                  deleteConfirmMediaId={deleteConfirmMediaId}
                  deleteConfirmCharacterId={deleteConfirmCharacterId}
                  onDeleteCharacter={deleteCharacter}
                  onToggleVisibility={toggleCharacterVisibility}
                />
              ))}
            </div>
          ) : normalizedQuery && libraryAuthority.hasSnapshot ? (
            <div className="p-10 text-center">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">No matches</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Nothing in {tabLabels[tab]} matches “{query}”.
              </p>
            </div>
          ) : authorityShowsEmpty(libraryAuthority, items.length) ? (
            <div className="p-10 text-center" data-testid="library-empty-state">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">{emptyState.title}</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                {emptyState.copy}
              </p>
              {emptyState.ctaHref ? (
                <Link
                  className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                  href={emptyState.ctaHref}
                >
                  {emptyState.ctaLabel}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ProfileAuthorityNotice({
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
      className="mt-4 flex flex-wrap items-center gap-2 rounded-[12px] border border-[rgb(255,184,112)]/30 bg-[rgb(36,28,18)] px-4 py-3 text-[13px] font-semibold text-[rgb(255,184,112)]"
      role="alert"
    >
      <span>
        {message}
        {hasSnapshot ? " Showing the last loaded data." : ""}
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

function LibraryCard({
  collections,
  failedImageIds,
  imageLoading = "lazy",
  invalidPreviewImageIds,
  item,
  onAddToCollection,
  onCreateCollection,
  onDelete,
  onDownload,
  onImageError,
  onInvalidImagePreview,
  onReport,
  showCharacterActions = false,
  onUpdateCharacter,
  onDuplicateCharacter,
  deleteConfirmMediaId,
  deleteConfirmCharacterId,
  onDeleteCharacter,
  onToggleVisibility,
}: Readonly<{
  collections?: MediaCollection[];
  failedImageIds: Set<string>;
  imageLoading?: "eager" | "lazy";
  invalidPreviewImageIds: Set<string>;
  item: LibraryItem;
  onAddToCollection?: (mediaAssetId: string, collectionId: string) => Promise<void>;
  onCreateCollection?: (
    mediaAssetId: string,
    input: { name: string; visibility: CollectionVisibility },
  ) => Promise<void>;
  onDelete: (id: string) => void;
  onDownload: (id: string) => void;
  onImageError: (id: string) => void;
  onInvalidImagePreview: (id: string) => void;
  onReport: (id: string) => void;
  showCharacterActions?: boolean;
  onUpdateCharacter?: (id: string, input: CharacterEditInput) => Promise<boolean>;
  onDuplicateCharacter?: (id: string) => void;
  deleteConfirmMediaId?: string | null;
  deleteConfirmCharacterId?: string | null;
  onDeleteCharacter?: (id: string) => void;
  onToggleVisibility?: (id: string, current?: string) => void;
}>) {
  const character = item.character;
  const { summary, title } = profileLibraryCardPresentation(item);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(title);
  const [editDescription, setEditDescription] = useState(summary ?? "");
  const [savingEdit, setSavingEdit] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [publishCollection, setPublishCollection] = useState(true);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [collectionBusy, setCollectionBusy] = useState(false);
  const contentType = item.contentType?.toLowerCase() ?? "";
  const isAudioItem =
    item.type === "voice" || item.type === "audio" || contentType.startsWith("audio/");
  const isVisualMediaItem = item.type === "image" || item.type === "video";
  const isMediaItem = isVisualMediaItem || isAudioItem;
  const source = item.thumbnailUrl ?? item.image ?? character?.image ?? item.url;
  const mediaUnavailable =
    (isVisualMediaItem && failedImageIds.has(item.id)) ||
    (isVisualMediaItem && invalidPreviewImageIds.has(item.id)) ||
    (isVisualMediaItem && source ? isBuiltInMediaPlaceholderUrl(source) : false) ||
    (isMediaItem && !source);
  const href =
    character?.id
      ? `/characters/${character.id}`
      : isMediaItem
        ? undefined
        : `/characters/${item.id}`;
  const appealHref =
    showCharacterActions && !isMediaItem && isAppealableCharacterStatus(item.status)
      ? characterAppealHref(character?.id ?? item.id, title)
      : null;
  const confirmMediaDelete = isMediaItem && deleteConfirmMediaId === item.id;

  function startCharacterEdit() {
    setEditName(title);
    setEditDescription(summary ?? "");
    setEditing(true);
  }

  async function saveCharacterEdit() {
    if (!onUpdateCharacter) return;
    setSavingEdit(true);
    const saved = await onUpdateCharacter(item.id, {
      description: editDescription,
      name: editName,
    });
    setSavingEdit(false);
    if (saved) setEditing(false);
  }

  async function createCollectionFromMedia() {
    if (!onCreateCollection) return;
    setCollectionBusy(true);
    await onCreateCollection(item.id, {
      name: collectionName,
      visibility: publishCollection ? "public" : "private",
    });
    setCollectionBusy(false);
    if (collectionName.trim()) setCollectionName("");
  }

  async function addToSelectedCollection() {
    if (!onAddToCollection) return;
    const collectionId = selectedCollectionId || collections?.[0]?.id || "";
    setCollectionBusy(true);
    await onAddToCollection(item.id, collectionId);
    setCollectionBusy(false);
  }

  const content = (
    <div className="overflow-hidden rounded-[14px] bg-[rgb(36,36,36)]" data-media-id={item.id}>
      {(source || isMediaItem) && (
        <div className="relative aspect-[4/3]">
          {mediaUnavailable ? (
            <div
              className="grid h-full place-items-center px-4 text-center text-[13px] font-semibold text-[rgb(170,170,170)]"
              data-testid="profile-media-unavailable"
            >
              <div className="flex flex-col items-center gap-2" data-testid="profile-media-preview-fallback">
                <ImageIcon className="h-5 w-5" />
                Preview unavailable
              </div>
            </div>
          ) : isAudioItem && source ? (
            <div className="flex h-full flex-col justify-center gap-4 px-4 text-white">
              <div className="flex items-center gap-2 text-[13px] font-black uppercase tracking-wide text-[rgb(220,220,220)]">
                <Volume2 className="h-4 w-4" />
                Voice clip
              </div>
              <audio
                aria-label="Profile voice clip"
                className="w-full"
                controls
                data-testid="profile-media-audio"
                preload="none"
              >
                <source src={source} type={item.contentType ?? "audio/mpeg"} />
                Audio playback is not supported.
              </audio>
            </div>
          ) : item.type === "video" && source ? (
            <video
              aria-label="Profile video"
              className="h-full w-full object-cover object-top"
              controls
              data-testid="profile-media-video"
              playsInline
              preload="none"
            >
              <source src={source} type={item.contentType ?? "video/mp4"} />
              Video playback is not supported.
            </video>
          ) : source ? (
            <Image
              alt=""
              className="object-cover object-top"
              data-testid="profile-media-image"
              fill
              loading={imageLoading}
              onLoad={(event) => {
                const image = event.currentTarget;
                if (
                  image.naturalWidth <= 1 ||
                  image.naturalHeight <= 1 ||
                  isBlankImagePreview(image)
                ) {
                  onInvalidImagePreview(item.id);
                }
              }}
              onError={() => onImageError(item.id)}
              sizes="280px"
              src={source}
              unoptimized={isPrivateMediaUrl(source)}
            />
          ) : null}
          <LegacyTestAssetBadge isSynthetic={isMediaItem && item.isSynthetic} />
        </div>
      )}
      <div className="p-4">
        <p className="text-[16px] font-black uppercase">{title}</p>
        {summary && (
          <p className="mt-2 line-clamp-2 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]">
            {summary}
          </p>
        )}
        {isMediaItem && (
          <div className="mt-4 grid gap-3">
            <div className="flex gap-2">
              <button
                aria-label="Download media"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white"
                onClick={() => onDownload(item.id)}
                type="button"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                aria-label="Report media"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white"
                onClick={() => onReport(item.id)}
                type="button"
              >
                <Flag className="h-4 w-4" />
              </button>
              <button
                aria-label={confirmMediaDelete ? "Confirm delete media" : "Delete media"}
                className={
                  confirmMediaDelete
                    ? "inline-flex h-9 items-center justify-center rounded-full bg-[rgb(170,20,45)] px-3 text-[12px] font-bold text-white"
                    : "inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white"
                }
                onClick={() => onDelete(item.id)}
                type="button"
              >
                {confirmMediaDelete ? "Confirm delete" : <Trash2 className="h-4 w-4" />}
              </button>
            </div>
            <div className="rounded-[12px] border border-white/10 bg-black/20 p-3">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase text-[rgb(170,170,170)]">
                <FolderPlus className="h-3.5 w-3.5" />
                Collection
              </div>
              {(collections?.length ?? 0) > 0 && (
                <div className="mt-3 flex gap-2">
                  <select
                    aria-label="Existing collection"
                    className="min-w-0 flex-1 rounded-[10px] bg-[rgb(18,18,18)] px-3 text-[12px] font-semibold text-white outline-none"
                    onChange={(event) => setSelectedCollectionId(event.target.value)}
                    value={selectedCollectionId || collections?.[0]?.id || ""}
                  >
                    {collections?.map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name} ({collection.itemCount})
                      </option>
                    ))}
                  </select>
                  <button
                    aria-label="Add media to collection"
                    className="inline-flex h-9 items-center justify-center rounded-full bg-[rgb(46,46,46)] px-3 text-[12px] font-bold text-white disabled:opacity-50"
                    disabled={collectionBusy}
                    onClick={() => void addToSelectedCollection()}
                    type="button"
                  >
                    Add
                  </button>
                </div>
              )}
              <div className="mt-3 grid gap-2">
                <input
                  aria-label="Collection name"
                  className="h-9 rounded-[10px] bg-[rgb(18,18,18)] px-3 text-[12px] font-semibold text-white outline-none placeholder:text-[rgb(114,113,112)]"
                  onChange={(event) => setCollectionName(event.target.value)}
                  placeholder="New collection name"
                  value={collectionName}
                />
                <label className="flex items-center gap-2 text-[12px] font-semibold text-[rgb(220,220,220)]">
                  <input
                    aria-label="Publish collection to Community"
                    checked={publishCollection}
                    className="h-4 w-4 accent-[rgb(253,95,194)]"
                    onChange={(event) => setPublishCollection(event.target.checked)}
                    type="checkbox"
                  />
                  Publish to Community
                </label>
                <button
                  aria-label="Create collection from media"
                  className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:opacity-50"
                  disabled={collectionBusy || !collectionName.trim()}
                  onClick={() => void createCollectionFromMedia()}
                  type="button"
                >
                  {collectionBusy ? "Saving..." : "Create collection"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const card = href ? <Link href={href}>{content}</Link> : content;

  // Created tab: let owners manage their own characters (US-PF-03). Actions sit OUTSIDE
  // the card Link so they remain clickable and don't nest interactive elements.
  if (showCharacterActions && !isMediaItem) {
    const confirmDelete = deleteConfirmCharacterId === item.id;
    return (
      <div>
        {card}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {item.status && (
            <span className="rounded-full bg-black/30 px-2 py-1 text-[11px] font-bold uppercase text-[rgb(170,170,170)]">
              {createdCharacterPublicationStatus({
                status: item.status,
                visibility: item.visibility,
                publicationState: item.publicationState,
              })}
            </span>
          )}
          <button
            aria-label="Edit character"
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[rgb(46,46,46)] px-3 text-[12px] font-bold text-white"
            onClick={startCharacterEdit}
            type="button"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
          <button
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[rgb(46,46,46)] px-3 text-[12px] font-bold text-white"
            onClick={() => onToggleVisibility?.(item.id, item.visibility)}
            type="button"
          >
            {item.visibility === "public" ? "Make private" : "Publish"}
          </button>
          <button
            aria-label="Duplicate character"
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[rgb(46,46,46)] px-3 text-[12px] font-bold text-white"
            onClick={() => onDuplicateCharacter?.(item.id)}
            type="button"
          >
            <Copy className="h-3.5 w-3.5" />
            Duplicate
          </button>
          {appealHref && (
            <Link
              aria-label={`Appeal decision for ${title}`}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[rgb(46,46,46)] px-3 text-[12px] font-bold text-white hover:bg-[rgb(60,60,60)]"
              href={appealHref}
            >
              <Scale className="h-3.5 w-3.5" />
              Appeal
            </Link>
          )}
          <button
            aria-label={confirmDelete ? "Confirm delete character" : "Delete character"}
            className={
              confirmDelete
                ? "inline-flex h-8 items-center justify-center rounded-full bg-[rgb(170,20,45)] px-3 text-[12px] font-bold text-white"
                : "inline-flex h-8 w-8 items-center justify-center rounded-full bg-[rgb(120,25,40)] text-white"
            }
            onClick={() => onDeleteCharacter?.(item.id)}
            type="button"
          >
            {confirmDelete ? "Confirm delete" : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>
        {editing && (
          <div
            className="mt-3 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-3"
            data-testid="character-edit-form"
          >
            <label className="block text-[11px] font-black uppercase text-[rgb(114,113,112)]">
              Name
              <input
                aria-label="Character name"
                className="mt-2 h-10 w-full rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] normal-case text-white outline-none"
                onChange={(event) => setEditName(event.target.value)}
                value={editName}
              />
            </label>
            <label className="mt-3 block text-[11px] font-black uppercase text-[rgb(114,113,112)]">
              Description
              <textarea
                aria-label="Character description"
                className="mt-2 min-h-24 w-full resize-y rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2 text-[13px] normal-case leading-5 text-white outline-none"
                onChange={(event) => setEditDescription(event.target.value)}
                value={editDescription}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                aria-label="Save character edit"
                className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)] disabled:opacity-50"
                disabled={savingEdit}
                onClick={() => void saveCharacterEdit()}
                type="button"
              >
                {savingEdit ? "Saving..." : "Save"}
              </button>
              <button
                className="inline-flex h-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[12px] font-bold text-white"
                onClick={() => setEditing(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return card;
}

function isAppealableCharacterStatus(status?: string) {
  return status === "removed" || status === "rejected";
}

function characterAppealHref(characterId: string, title: string) {
  const safeTitle = title.trim().slice(0, 120) || characterId;
  const params = new URLSearchParams({
    appealTargetType: "character",
    appealTargetId: characterId,
    appealText: `Please review this character decision again. Character: ${safeTitle}.`,
  });
  return `/helpdesk?${params.toString()}#appeals`;
}

function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
