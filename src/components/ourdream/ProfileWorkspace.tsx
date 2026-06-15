"use client";

import Link from "next/link";
import { Bot, Coins } from "lucide-react";
import { useEffect, useState } from "react";

type ProfilePayload = {
  data?: {
    balance?: number;
    subscription?: { plan?: { name: string; billingPeriod: string } } | null;
  };
};

type LibraryPayload = {
  data?: {
    items?: Array<{ id: string; title?: string; name?: string; image?: string }>;
  };
};

const tabs = ["recent", "characters", "created", "presets", "media", "group-chats"];

export function ProfileWorkspace() {
  const [balance, setBalance] = useState(0);
  const [plan, setPlan] = useState("Free");
  const [tab, setTab] = useState("recent");
  const [items, setItems] = useState<NonNullable<LibraryPayload["data"]>["items"]>([]);

  useEffect(() => {
    fetch("/api/v1/profile")
      .then((response) => response.json())
      .then((payload: ProfilePayload) => {
        setBalance(payload.data?.balance ?? 0);
        const sub = payload.data?.subscription;
        if (sub?.plan) setPlan(`${sub.plan.name} ${sub.plan.billingPeriod}`);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch(`/api/v1/library/${tab}`)
      .then((response) => response.json())
      .then((payload: LibraryPayload) => setItems(payload.data?.items ?? []))
      .catch(() => setItems([]));
  }, [tab]);

  return (
    <section className="px-4 py-10 md:px-[60px]">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[38px] font-black uppercase leading-10 text-white">
              My AI
            </h1>
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
        <div className="mt-10 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-6">
          {items && items.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-3">
              {items.map((item) => (
                <div className="rounded-[14px] bg-[rgb(36,36,36)] p-4" key={item.id}>
                  <p className="text-[16px] font-black uppercase">
                    {item.title ?? item.name ?? item.id}
                  </p>
                </div>
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
