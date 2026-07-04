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
  Search,
  Trash2,
  UserCog,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { authHrefForTarget, authNextTargetFromPath } from "./authRedirect";

type ProfilePayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    user?: { displayName?: string | null; email?: string };
    balance?: number;
    subscription?: SubscriptionSummary | null;
    entitlements?: Record<string, unknown>;
  };
};

type SubscriptionSummary = {
  id: string;
  status: string;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  plan?: {
    name: string;
    billingPeriod: string;
  };
};

type BillingPortalPayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    mode?: "manage" | "subscribe";
    url?: string;
    message?: string;
    subscription?: SubscriptionSummary | null;
  };
};

type BillingMutationPayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    message?: string;
    subscription?: SubscriptionSummary | null;
  };
};

// P1-D: describe the chat entitlement that matches the active plan tier so users
// see what their plan actually unlocks for chat (not a vague "benefits" line).
function chatEntitlementSummary(plan: string): string {
  const p = plan.toLowerCase();
  if (p.includes("deluxe")) {
    return "Unlimited messages · premium chat model · 3× chat memory · highest rate limit.";
  }
  if (p.includes("premium")) {
    return "Unlimited messages · longer context · advanced generation controls.";
  }
  return "Free: 30 messages per day · basic chat model · base memory.";
}

type LibraryPayload = {
  data?: {
    items?: LibraryItem[];
    emptyCta?: string;
  };
};

type PreferencesPayload = {
  data?: {
    preferences?: {
      locale?: string | null;
      notificationSettings?: Record<string, unknown> | null;
    };
  };
};

type LibraryItem = {
  id: string;
  type?: string;
  title?: string;
  name?: string;
  description?: string | null;
  image?: string;
  thumbnailUrl?: string;
  url?: string;
  contentType?: string | null;
  prompt?: string | null;
  visibility?: string;
  status?: string;
  character?: {
    id: string;
    title?: string;
    name?: string;
    image?: string;
  };
};

type MediaCollection = {
  id: string;
  name: string;
  visibility: "private" | "public" | "unlisted";
  itemCount: number;
};

type AuthState = "loading" | "authenticated" | "anonymous";
type CharacterEditInput = { name: string; description: string };
type CollectionVisibility = MediaCollection["visibility"];

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
  const defaults: Record<LibraryTab, { title: string; copy: string; ctaHref: string; ctaLabel: string }> = {
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
      ctaHref: "/create",
      ctaLabel: "Create",
    },
    packs: {
      title: "Packs are not in this beta",
      copy: "Saved bundles will appear here when packs are enabled. Current beta keeps characters and presets separate.",
      ctaHref: "/create",
      ctaLabel: "Create",
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

export function ProfileWorkspace() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authTarget, setAuthTarget] = useState("/profile");
  const [balance, setBalance] = useState(0);
  const [plan, setPlan] = useState("Free");
  const [subscription, setSubscription] = useState<SubscriptionSummary | null>(null);
  const [displayName, setDisplayName] = useState("Dreamer");
  const [profileName, setProfileName] = useState("Dreamer");
  const [tab, setTab] = useState<LibraryTab>("recent");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [emptyCta, setEmptyCta] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [profileError, setProfileError] = useState(false);
  const [libraryError, setLibraryError] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteConfirmCharacterId, setDeleteConfirmCharacterId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [referralUrl, setReferralUrl] = useState("");
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(new Set());
  const [mediaCollections, setMediaCollections] = useState<MediaCollection[]>([]);

  const refreshProfile = useCallback(async () => {
    // Surface a real load failure instead of silently showing a fake "0 dreamcoins · Free".
    try {
      const response = await fetch("/api/v1/profile");
      if (response.status === 401) {
        setAuthState("anonymous");
        setProfileError(false);
        setLibraryError(false);
        setItems([]);
        return;
      }
      if (!response.ok) throw new Error("profile fetch failed");
      const payload = (await response.json()) as ProfilePayload;
      const nextName = payload.data?.user?.displayName ?? payload.data?.user?.email ?? "Dreamer";
      setAuthState("authenticated");
      setDisplayName(nextName);
      setProfileName(nextName);
      setBalance(payload.data?.balance ?? 0);
      const sub = payload.data?.subscription;
      setSubscription(sub ?? null);
      setPlan(sub?.plan ? `${sub.plan.name} ${sub.plan.billingPeriod}` : "Free");
      setProfileError(false);
    } catch {
      setAuthState("authenticated");
      setProfileError(true);
    }
  }, []);

  const refreshLibrary = useCallback(async (nextTab: LibraryTab) => {
    // Distinguish a backend error from a genuinely empty library tab.
    try {
      const response = await fetch(`/api/v1/library/${nextTab}`);
      if (!response.ok) throw new Error("library fetch failed");
      const payload = (await response.json()) as LibraryPayload;
      setItems(payload.data?.items ?? []);
      setEmptyCta(payload.data?.emptyCta ?? null);
      setLibraryError(false);
    } catch {
      setItems([]);
      setEmptyCta(null);
      setLibraryError(true);
    }
  }, []);

  const refreshMediaCollections = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/media/collections");
      if (!response.ok) throw new Error("collections fetch failed");
      const payload = (await response.json()) as {
        data?: { collections?: MediaCollection[] };
      };
      setMediaCollections(payload.data?.collections ?? []);
    } catch {
      setMediaCollections([]);
    }
  }, []);

  const refreshPreferences = useCallback(async () => {
    await fetch("/api/v1/profile/preferences")
      .then((response) => response.json())
      .then((payload: PreferencesPayload) => {
        const preferences = payload.data?.preferences;
        const notificationSettings = preferences?.notificationSettings ?? {};
        const updates = notificationSettings.productUpdates;
        if (typeof updates === "boolean") setEmailUpdates(updates);
      })
      .catch(() => undefined);
  }, []);

  // Defer initial loads to a macrotask so the first render commits before any setState
  // (matches ExploreWorkspace/FeedWorkspace; avoids react-hooks/set-state-in-effect).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshProfile();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshProfile]);

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
    if (authState !== "authenticated") return;
    const timer = window.setTimeout(() => void refreshPreferences(), 0);
    return () => window.clearTimeout(timer);
  }, [authState, refreshPreferences]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    focusProfileDeepLink();
  }, [authState]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const timer = window.setTimeout(() => void refreshLibrary(tab), 0);
    return () => window.clearTimeout(timer);
  }, [authState, refreshLibrary, tab]);

  useEffect(() => {
    if (authState !== "authenticated" || tab !== "media") return;
    const timer = window.setTimeout(() => void refreshMediaCollections(), 0);
    return () => window.clearTimeout(timer);
  }, [authState, refreshMediaCollections, tab]);

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
      const payload = (await response.json()) as ProfilePayload;
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
      const payload = (await response.json()) as ProfilePayload;
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
    try {
      const response = await fetch("/api/v1/profile/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationSettings: { productUpdates: emailUpdates },
        }),
      });
      setStatus(response.ok ? "Preferences updated." : "Preferences update failed.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function openBillingPortal() {
    try {
      const response = await fetch("/api/v1/billing/portal", { method: "POST" });
      const payload = (await response.json()) as BillingPortalPayload;
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Billing portal failed.");
        return;
      }
      const url = payload.data?.url;
      if (payload.data?.subscription !== undefined) setSubscription(payload.data.subscription);
      if (payload.data?.subscription?.plan) {
        setPlan(
          `${payload.data.subscription.plan.name} ${payload.data.subscription.plan.billingPeriod}`,
        );
      }
      if (url && url !== "/profile#billing") {
        window.location.href = url;
        return;
      }
      if (url === "/profile#billing") window.history.replaceState(null, "", "/profile#billing");
      setStatus(payload.data?.message ?? "Billing portal ready.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function updateRenewal(action: "cancel" | "resume") {
    setStatus("");
    try {
      const response = await fetch(`/api/v1/billing/${action}`, { method: "POST" });
      const payload = (await response.json()) as BillingMutationPayload;
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Billing update failed.");
        return;
      }
      if (payload.data?.subscription !== undefined) setSubscription(payload.data.subscription);
      if (payload.data?.subscription?.plan) {
        setPlan(
          `${payload.data.subscription.plan.name} ${payload.data.subscription.plan.billingPeriod}`,
        );
      }
      setStatus(payload.data?.message ?? "Billing updated.");
    } catch {
      setStatus("Network error. Please try again.");
    }
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
      if (response.ok) {
        window.location.href = "/login";
        return;
      }
      setStatus("Account deletion failed.");
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function deleteMedia(id: string) {
    try {
      await fetch(`/api/v1/media/${id}`, { method: "DELETE" });
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
          ? "Submitted for review — public characters go live after approval."
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
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (!response.ok || payload.ok === false) {
        setStatus(payload.error?.message ?? "Collection create failed.");
        return;
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
  const subscriptionPeriod = subscription?.currentPeriodEnd
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
        new Date(subscription.currentPeriodEnd),
      )
    : "current period";
  const billingStatus = subscription
    ? subscription.cancelAtPeriodEnd
      ? `Renewal canceled · benefits active until ${subscriptionPeriod}`
      : `Renews ${subscriptionPeriod}`
    : "No active subscription";

  if (authState === "loading") {
    return (
      <section className="px-4 py-10 md:px-[60px]">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[38px] font-black uppercase leading-10 text-white">My AI</h1>
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

  if (authState === "anonymous") {
    return (
      <section className="px-4 py-10 md:px-[60px]">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[38px] font-black uppercase leading-10 text-white">My AI</h1>
          <div
            className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center"
            data-testid="profile-auth-required"
          >
            <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
            <h2 className="mt-4 text-[22px] font-black uppercase text-white">
              Sign in to open My AI
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
              Your characters, generated media, billing, referrals, and account controls live in
              your private profile.
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
              My AI
            </h1>
            <p className="mt-2 text-[14px] font-semibold text-white">{displayName}</p>
            {profileError ? (
              <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] font-bold text-[rgb(255,140,140)]">
                Couldn&apos;t load your balance and plan.
                <button
                  className="rounded-full bg-[rgb(36,36,36)] px-3 py-1 text-[12px] font-bold text-white"
                  onClick={() => void refreshProfile()}
                  type="button"
                >
                  Retry
                </button>
              </p>
            ) : (
              <p className="mt-3 flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)]">
                <Coins className="h-4 w-4 text-[rgb(253,95,194)]" />
                {balance.toLocaleString()} dreamcoins · {plan}
              </p>
            )}
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
            href="/upgrade"
          >
            Upgrade
          </Link>
        </div>
        {/* P1-D: surface the concrete chat entitlement for the active tier. */}
        <div className="mt-6 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-[rgb(114,113,112)]">
            Chat plan
          </p>
          <p className="mt-2 text-[14px] font-semibold leading-6 text-white">
            {chatEntitlementSummary(plan)}
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button
              className={`h-10 rounded-full px-4 text-[13px] font-bold ${
                tab === item ? "bg-[rgb(46,46,46)] text-white" : "text-[rgb(170,170,170)]"
              }`}
              key={item}
              onClick={() => setTab(item)}
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
            <p className="text-[13px] font-black uppercase text-white">Billing Portal</p>
            <p className="mt-2 text-[12px] font-bold text-[rgb(170,170,170)]">{plan}</p>
            <p className="mt-1 text-[12px] font-medium text-[rgb(170,170,170)]">{billingStatus}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {subscription ? (
                <>
                  <button
                    className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]"
                    onClick={openBillingPortal}
                    type="button"
                  >
                    Manage
                  </button>
                  <Link
                    className="inline-flex h-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[12px] font-bold text-white"
                    href="/upgrade"
                  >
                    Change plan
                  </Link>
                  <button
                    className="inline-flex h-9 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[12px] font-bold text-white"
                    onClick={() =>
                      void updateRenewal(subscription.cancelAtPeriodEnd ? "resume" : "cancel")
                    }
                    type="button"
                  >
                    {subscription.cancelAtPeriodEnd ? "Resume renewal" : "Cancel renewal"}
                  </button>
                </>
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
              <p className="text-[13px] font-semibold text-[rgb(170,170,170)]">{status}</p>
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
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2"
              data-testid="profile-notifications-panel"
              id="notifications"
            >
              <label className="flex items-center gap-2 text-[13px] font-semibold text-white">
                <input
                  aria-label="Product updates"
                  checked={emailUpdates}
                  className="h-4 w-4 accent-[rgb(253,95,194)]"
                  onChange={(event) => setEmailUpdates(event.target.checked)}
                  type="checkbox"
                />
                Product updates
              </label>
              <button
                className="inline-flex h-9 items-center gap-2 rounded-full bg-black/30 px-3 text-[12px] font-bold text-white"
                onClick={savePreferences}
                type="button"
              >
                <Bell className="h-4 w-4" />
                Save preferences
              </button>
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
        <div className="mt-4 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-6">
          {libraryError ? (
            <div className="p-10 text-center">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">Couldn&apos;t load this tab</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Something went wrong loading your library. Please try again.
              </p>
              <button
                className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                onClick={() => void refreshLibrary(tab)}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : visibleItems.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {visibleItems.map((item, index) => (
                <LibraryCard
                  failedImageIds={failedImageIds}
                  imageLoading={index < 3 ? "eager" : "lazy"}
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
                  onReport={reportMedia}
                  collections={mediaCollections}
                  onCreateCollection={createMediaCollection}
                  onAddToCollection={addMediaToCollection}
                  showCharacterActions={isCreatedTab}
                  onUpdateCharacter={updateCharacterDetails}
                  onDuplicateCharacter={duplicateCharacter}
                  deleteConfirmCharacterId={deleteConfirmCharacterId}
                  onDeleteCharacter={deleteCharacter}
                  onToggleVisibility={toggleCharacterVisibility}
                />
              ))}
            </div>
          ) : normalizedQuery ? (
            <div className="p-10 text-center">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">No matches</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Nothing in {tabLabels[tab]} matches “{query}”.
              </p>
            </div>
          ) : (
            <div className="p-10 text-center" data-testid="library-empty-state">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">{emptyState.title}</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                {emptyState.copy}
              </p>
              <Link
                className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                href={emptyState.ctaHref}
              >
                {emptyState.ctaLabel}
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LibraryCard({
  collections,
  failedImageIds,
  imageLoading = "lazy",
  item,
  onAddToCollection,
  onCreateCollection,
  onDelete,
  onDownload,
  onImageError,
  onReport,
  showCharacterActions = false,
  onUpdateCharacter,
  onDuplicateCharacter,
  deleteConfirmCharacterId,
  onDeleteCharacter,
  onToggleVisibility,
}: Readonly<{
  collections?: MediaCollection[];
  failedImageIds: Set<string>;
  imageLoading?: "eager" | "lazy";
  item: LibraryItem;
  onAddToCollection?: (mediaAssetId: string, collectionId: string) => Promise<void>;
  onCreateCollection?: (
    mediaAssetId: string,
    input: { name: string; visibility: CollectionVisibility },
  ) => Promise<void>;
  onDelete: (id: string) => void;
  onDownload: (id: string) => void;
  onImageError: (id: string) => void;
  onReport: (id: string) => void;
  showCharacterActions?: boolean;
  onUpdateCharacter?: (id: string, input: CharacterEditInput) => Promise<boolean>;
  onDuplicateCharacter?: (id: string) => void;
  deleteConfirmCharacterId?: string | null;
  onDeleteCharacter?: (id: string) => void;
  onToggleVisibility?: (id: string, current?: string) => void;
}>) {
  const character = item.character;
  const title = item.title ?? item.name ?? character?.title ?? character?.name ?? item.id;
  const summary = item.prompt ?? item.description ?? null;
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
    (isVisualMediaItem && source ? isBuiltInMediaPlaceholderUrl(source) : false) ||
    (isMediaItem && !source);
  const href =
    character?.id
      ? `/characters/${character.id}`
      : isMediaItem
        ? undefined
        : `/characters/${item.id}`;

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
              <div className="flex flex-col items-center gap-2">
                <ImageIcon className="h-5 w-5" />
                Media unavailable
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
              fill
              loading={imageLoading}
              onError={() => onImageError(item.id)}
              sizes="280px"
              src={source}
              unoptimized={isPrivateMediaUrl(source)}
            />
          ) : null}
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
                aria-label="Delete media"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white"
                onClick={() => onDelete(item.id)}
                type="button"
              >
                <Trash2 className="h-4 w-4" />
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
              {item.status.replace("_", " ")}
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

function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}

function isBuiltInMediaPlaceholderUrl(url: string) {
  const lower = url.toLowerCase();
  return (
    lower.includes("/images/ourdream/card-sarah-mercer.webp") ||
    lower.includes("%2fimages%2fourdream%2fcard-sarah-mercer.webp")
  );
}
