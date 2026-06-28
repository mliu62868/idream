"use client";

import Image from "next/image";
import Link from "next/link";
import {
  Bell,
  Bot,
  Coins,
  Download,
  Flag,
  Gift,
  ImageIcon,
  Languages,
  Link2,
  LogOut,
  Save,
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
  const [redeemCode, setRedeemCode] = useState("");
  const [locale, setLocale] = useState("en");
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [status, setStatus] = useState("");
  const [referralUrl, setReferralUrl] = useState("");
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(new Set());

  const refreshProfile = useCallback(async () => {
    await fetch("/api/v1/profile")
      .then((response) => response.json())
      .then((payload: ProfilePayload) => {
        const nextName = payload.data?.user?.displayName ?? payload.data?.user?.email ?? "Dreamer";
        setDisplayName(nextName);
        setProfileName(nextName);
        setBalance(payload.data?.balance ?? 0);
        const sub = payload.data?.subscription;
        if (sub?.plan) setPlan(`${sub.plan.name} ${sub.plan.billingPeriod}`);
      })
      .catch(() => undefined);
  }, []);

  const refreshLibrary = useCallback(async (nextTab: string) => {
    await fetch(`/api/v1/library/${nextTab}`)
      .then((response) => response.json())
      .then((payload: LibraryPayload) => setItems(payload.data?.items ?? []))
      .catch(() => setItems([]));
  }, []);

  const refreshPreferences = useCallback(async () => {
    await fetch("/api/v1/profile/preferences")
      .then((response) => response.json())
      .then((payload: PreferencesPayload) => {
        const preferences = payload.data?.preferences;
        if (preferences?.locale) setLocale(preferences.locale);
        const notificationSettings = preferences?.notificationSettings ?? {};
        const updates = notificationSettings.productUpdates;
        if (typeof updates === "boolean") setEmailUpdates(updates);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshProfile();
    refreshPreferences();
  }, [refreshPreferences, refreshProfile]);

  useEffect(() => {
    refreshLibrary(tab);
  }, [refreshLibrary, tab]);

  async function redeem() {
    setStatus("");
    const code = redeemCode.trim();
    if (!code) {
      setStatus("Enter a code.");
      return;
    }
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
  }

  async function invite() {
    const response = await fetch("/api/v1/referrals/invite", { method: "POST" });
    const payload = (await response.json()) as { data?: { shareUrl?: string } };
    setReferralUrl(payload.data?.shareUrl ?? "");
    setStatus("Referral invite ready.");
  }

  async function saveProfile() {
    const nextName = profileName.trim();
    if (!nextName) {
      setStatus("Enter a display name.");
      return;
    }
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
  }

  async function savePreferences() {
    const response = await fetch("/api/v1/profile/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notificationSettings: { productUpdates: emailUpdates },
      }),
    });
    setStatus(response.ok ? "Preferences updated." : "Preferences update failed.");
  }

  async function updateLanguage() {
    const response = await fetch("/api/v1/profile/language", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    });
    setStatus(response.ok ? "Language updated." : "Language update failed.");
  }

  async function openBillingPortal() {
    const response = await fetch("/api/v1/billing/portal", { method: "POST" });
    const payload = (await response.json()) as { data?: { url?: string } };
    if (payload.data?.url) {
      window.location.href = payload.data.url;
      return;
    }
    setStatus("Billing portal failed.");
  }

  async function signOutEverywhere() {
    const response = await fetch("/api/v1/account/sign-out-all", { method: "POST" });
    if (response.ok) {
      window.location.href = "/login";
      return;
    }
    setStatus("Sign out failed.");
  }

  async function requestAccountDeletion() {
    if (deleteConfirm !== "DELETE") {
      setStatus("Type DELETE to confirm account deletion.");
      return;
    }
    const response = await fetch("/api/v1/account/delete-request", { method: "POST" });
    if (response.ok) {
      window.location.href = "/login";
      return;
    }
    setStatus("Account deletion failed.");
  }

  async function deleteMedia(id: string) {
    await fetch(`/api/v1/media/${id}`, { method: "DELETE" });
    await refreshLibrary(tab);
  }

  async function downloadMedia(id: string) {
    setStatus("");
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
  }

  async function reportMedia(id: string) {
    setStatus("");
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
            <p className="mt-3 flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)]">
              <Coins className="h-4 w-4 text-[rgb(253,95,194)]" />
              {balance.toLocaleString()} dreamcoins · {plan}
            </p>
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
        <div className="mt-6 grid gap-3 md:grid-cols-4">
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
          <label className="rounded-[14px] bg-[rgb(18,18,18)] p-4 text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
            Language
            <div className="mt-2 flex gap-2">
              <select
                aria-label="Language selector"
                className="min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] normal-case text-white outline-none"
                onChange={(event) => setLocale(event.target.value)}
                value={locale}
              >
                <option value="en">English</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="zh">Chinese</option>
              </select>
              <button
                aria-label="Update language"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-[rgb(13,13,13)]"
                onClick={updateLanguage}
                type="button"
              >
                <Languages className="h-4 w-4" />
              </button>
            </div>
          </label>
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
        <div className="mt-10 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-6">
          {items && items.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {items.map((item) => (
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
                />
              ))}
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
}: Readonly<{
  failedImageIds: Set<string>;
  item: LibraryItem;
  onDelete: (id: string) => void;
  onDownload: (id: string) => void;
  onImageError: (id: string) => void;
  onReport: (id: string) => void;
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

  return href ? <Link href={href}>{content}</Link> : content;
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
