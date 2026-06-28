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
  Gift,
  ImageIcon,
  Link2,
  LogOut,
  Save,
  Search,
  Trash2,
  UserCog,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ProfilePayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    user?: { displayName?: string | null; email?: string };
    balance?: number;
    subscription?: { plan?: { name: string; billingPeriod: string } } | null;
    entitlements?: Record<string, unknown>;
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

const tabs = ["recent", "characters", "created", "presets", "media", "group-chats"];

export function ProfileWorkspace() {
  const [balance, setBalance] = useState(0);
  const [plan, setPlan] = useState("Free");
  const [displayName, setDisplayName] = useState("Dreamer");
  const [profileName, setProfileName] = useState("Dreamer");
  const [tab, setTab] = useState("recent");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [query, setQuery] = useState("");
  const [profileError, setProfileError] = useState(false);
  const [libraryError, setLibraryError] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [status, setStatus] = useState("");
  const [referralUrl, setReferralUrl] = useState("");
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(new Set());

  const refreshProfile = useCallback(async () => {
    // Surface a real load failure instead of silently showing a fake "0 dreamcoins · Free".
    try {
      const response = await fetch("/api/v1/profile");
      if (!response.ok) throw new Error("profile fetch failed");
      const payload = (await response.json()) as ProfilePayload;
      const nextName = payload.data?.user?.displayName ?? payload.data?.user?.email ?? "Dreamer";
      setDisplayName(nextName);
      setProfileName(nextName);
      setBalance(payload.data?.balance ?? 0);
      const sub = payload.data?.subscription;
      if (sub?.plan) setPlan(`${sub.plan.name} ${sub.plan.billingPeriod}`);
      setProfileError(false);
    } catch {
      setProfileError(true);
    }
  }, []);

  const refreshLibrary = useCallback(async (nextTab: string) => {
    // Distinguish a backend error from a genuinely empty library tab.
    try {
      const response = await fetch(`/api/v1/library/${nextTab}`);
      if (!response.ok) throw new Error("library fetch failed");
      const payload = (await response.json()) as LibraryPayload;
      setItems(payload.data?.items ?? []);
      setLibraryError(false);
    } catch {
      setItems([]);
      setLibraryError(true);
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
      void refreshPreferences();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshPreferences, refreshProfile]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshLibrary(tab), 0);
    return () => window.clearTimeout(timer);
  }, [refreshLibrary, tab]);

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
      const payload = (await response.json()) as { data?: { shareUrl?: string } };
      setReferralUrl(payload.data?.shareUrl ?? "");
      setStatus("Referral invite ready.");
    } catch {
      setStatus("Network error. Please try again.");
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
      const payload = (await response.json()) as { data?: { url?: string } };
      if (payload.data?.url) {
        window.location.href = payload.data.url;
        return;
      }
      setStatus("Billing portal failed.");
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

  async function deleteCharacter(id: string) {
    setStatus("");
    try {
      const response = await fetch(`/api/v1/characters/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setStatus("Delete failed.");
        return;
      }
      setStatus("Character deleted.");
      await refreshLibrary(tab);
    } catch {
      setStatus("Network error. Please try again.");
    }
  }

  async function toggleCharacterVisibility(id: string, current?: string) {
    // public characters re-enter review on publish; private/unlisted publish straight to review.
    setStatus("");
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

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? items.filter((item) =>
        `${item.title ?? ""} ${item.name ?? ""} ${item.character?.name ?? ""} ${item.prompt ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : items;
  const isCreatedTab = tab === "created";

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
              {item.replace("-", " ")}
            </button>
          ))}
        </div>
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          <label className="rounded-[14px] bg-[rgb(18,18,18)] p-4 text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
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
          <button
            className="rounded-[14px] bg-[rgb(18,18,18)] p-4 text-left text-[13px] font-black uppercase text-white"
            onClick={openBillingPortal}
            type="button"
          >
            Billing Portal
            <span className="mt-2 block text-[12px] font-medium normal-case text-[rgb(170,170,170)]">
              Manage subscription
            </span>
          </button>
        </div>
        {(status || referralUrl) && (
          <p className="mt-4 text-[13px] font-semibold text-[rgb(170,170,170)]">
            {status} {referralUrl}
          </p>
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
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-[rgb(36,36,36)] px-3 py-2">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-white">
                <input
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
          <div className="rounded-[14px] bg-[rgb(18,18,18)] p-4">
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
            placeholder={`Search ${tab.replace("-", " ")}…`}
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
              {visibleItems.map((item) => (
                <LibraryCard
                  failedImageIds={failedImageIds}
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
                  showCharacterActions={isCreatedTab}
                  onDuplicateCharacter={duplicateCharacter}
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
                Nothing in {tab.replace("-", " ")} matches “{query}”.
              </p>
            </div>
          ) : (
            <div className="p-10 text-center">
              <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">No items yet</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Create a character, start a chat, or generate images to fill this tab.
              </p>
              <Link
                className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                href="/create"
              >
                Create
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LibraryCard({
  failedImageIds,
  item,
  onDelete,
  onDownload,
  onImageError,
  onReport,
  showCharacterActions = false,
  onDuplicateCharacter,
  onDeleteCharacter,
  onToggleVisibility,
}: Readonly<{
  failedImageIds: Set<string>;
  item: LibraryItem;
  onDelete: (id: string) => void;
  onDownload: (id: string) => void;
  onImageError: (id: string) => void;
  onReport: (id: string) => void;
  showCharacterActions?: boolean;
  onDuplicateCharacter?: (id: string) => void;
  onDeleteCharacter?: (id: string) => void;
  onToggleVisibility?: (id: string, current?: string) => void;
}>) {
  const character = item.character;
  const title = item.title ?? item.name ?? character?.title ?? character?.name ?? item.id;
  const isMediaItem = item.type === "image" || item.type === "video";
  const source = item.thumbnailUrl ?? item.image ?? character?.image ?? item.url;
  const mediaUnavailable =
    failedImageIds.has(item.id) ||
    (isMediaItem && source ? isBuiltInMediaPlaceholderUrl(source) : false);
  const href =
    character?.id
      ? `/characters/${character.id}`
      : isMediaItem
        ? undefined
        : `/characters/${item.id}`;

  const content = (
    <div className="overflow-hidden rounded-[14px] bg-[rgb(36,36,36)]" data-media-id={item.id}>
      {source && (
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
          ) : item.type === "video" ? (
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
          ) : (
            <Image
              alt=""
              className="object-cover object-top"
              fill
              onError={() => onImageError(item.id)}
              sizes="280px"
              src={source}
              unoptimized={isPrivateMediaUrl(source)}
            />
          )}
        </div>
      )}
      <div className="p-4">
        <p className="text-[16px] font-black uppercase">{title}</p>
        {item.prompt && (
          <p className="mt-2 line-clamp-2 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]">
            {item.prompt}
          </p>
        )}
        {isMediaItem && (
          <div className="mt-4 flex gap-2">
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
        )}
      </div>
    </div>
  );

  const card = href ? <Link href={href}>{content}</Link> : content;

  // Created tab: let owners manage their own characters (US-PF-03). Actions sit OUTSIDE
  // the card Link so they remain clickable and don't nest interactive elements.
  if (showCharacterActions && !isMediaItem) {
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
            aria-label="Delete character"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[rgb(120,25,40)] text-white"
            onClick={() => onDeleteCharacter?.(item.id)}
            type="button"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
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
