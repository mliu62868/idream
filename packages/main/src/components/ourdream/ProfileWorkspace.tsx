"use client";

import Image from "next/image";
import Link from "next/link";
import { Bot, Coins, Download, Gift, Languages, Link2, Trash2 } from "lucide-react";
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

type LibraryPayload = {
  data?: {
    items?: LibraryItem[];
    emptyCta?: string;
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
  const [tab, setTab] = useState("recent");
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [redeemCode, setRedeemCode] = useState("WELCOME300");
  const [locale, setLocale] = useState("en");
  const [status, setStatus] = useState("");
  const [referralUrl, setReferralUrl] = useState("");

  const refreshProfile = useCallback(async () => {
    await fetch("/api/v1/profile")
      .then((response) => response.json())
      .then((payload: ProfilePayload) => {
        setDisplayName(payload.data?.user?.displayName ?? payload.data?.user?.email ?? "Dreamer");
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

  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  useEffect(() => {
    refreshLibrary(tab);
  }, [refreshLibrary, tab]);

  async function redeem() {
    setStatus("");
    const response = await fetch("/api/v1/redeem-codes/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: redeemCode }),
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
    if (payload.data?.url) window.location.href = payload.data.url;
  }

  async function deleteMedia(id: string) {
    await fetch(`/api/v1/media/${id}`, { method: "DELETE" });
    await refreshLibrary(tab);
  }

  async function downloadMedia(id: string) {
    const response = await fetch(`/api/v1/media/${id}/download`);
    const payload = (await response.json()) as { data?: { url?: string } };
    if (payload.data?.url) window.open(payload.data.url, "_blank", "noopener,noreferrer");
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
              {balance} dreamcoins · {plan}
            </p>
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
            href="/upgrade"
          >
            Upgrade
          </Link>
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
                className="min-w-0 flex-1 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] normal-case text-white outline-none"
                onChange={(event) => setRedeemCode(event.target.value)}
                value={redeemCode}
              />
              <button
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
        <div className="mt-10 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-6">
          {items && items.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {items.map((item) => (
                <LibraryCard
                  item={item}
                  key={item.id}
                  onDelete={deleteMedia}
                  onDownload={downloadMedia}
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
  item,
  onDelete,
  onDownload,
}: Readonly<{
  item: LibraryItem;
  onDelete: (id: string) => void;
  onDownload: (id: string) => void;
}>) {
  const character = item.character;
  const title = item.title ?? item.name ?? character?.title ?? character?.name ?? item.id;
  const image = item.thumbnailUrl ?? item.image ?? character?.image ?? item.url;
  const href =
    character?.id
      ? `/characters/${character.id}`
      : item.type === "image" || item.type === "video"
        ? undefined
        : `/characters/${item.id}`;

  const content = (
    <div className="overflow-hidden rounded-[14px] bg-[rgb(36,36,36)]">
      {image && (
        <div className="relative aspect-[4/3]">
          <Image alt="" className="object-cover object-top" fill sizes="280px" src={image} />
        </div>
      )}
      <div className="p-4">
        <p className="text-[16px] font-black uppercase">{title}</p>
        {item.prompt && (
          <p className="mt-2 line-clamp-2 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]">
            {item.prompt}
          </p>
        )}
        {(item.type === "image" || item.type === "video") && (
          <div className="mt-4 flex gap-2">
            <button
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white"
              onClick={() => onDownload(item.id)}
              type="button"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
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
