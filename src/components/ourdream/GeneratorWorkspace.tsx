"use client";

import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { CharacterCardData } from "@/types/ourdream";

type MediaItem = {
  id: string;
  url: string;
  thumbnailUrl: string;
  prompt: string | null;
};

export function GeneratorWorkspace() {
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [characterId, setCharacterId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/v1/characters?limit=12")
      .then((response) => response.json())
      .then((payload: { data?: { items: CharacterCardData[] } }) => {
        const items = payload.data?.items ?? [];
        setCharacters(items);
        setCharacterId(items[0]?.id ?? "");
      })
      .catch(() => undefined);
    refreshMedia();
  }, []);

  async function refreshMedia() {
    const response = await fetch("/api/v1/media?type=image");
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: { items: MediaItem[] } };
    setMedia(payload.data?.items ?? []);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus("");
    try {
      const response = await fetch("/api/v1/generation/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "image",
          characterId,
          outputCount: 2,
          prompt: prompt || undefined,
          controls: { orientation: "4:5" },
        }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!response.ok || !payload.ok) {
        setStatus(payload.error?.message ?? "Generation failed");
        return;
      }
      setStatus("Generation complete. Images saved to your gallery.");
      await refreshMedia();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="mx-auto grid max-w-6xl gap-5 md:grid-cols-[420px_1fr]">
        <form
          className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4"
          onSubmit={submit}
        >
          <div className="grid grid-cols-2 rounded-full bg-[rgb(36,36,36)] p-1">
            <button className="h-10 rounded-full bg-white text-[13px] font-bold text-[rgb(13,13,13)]" type="button">
              Image
            </button>
            <button className="h-10 rounded-full text-[13px] font-bold text-[rgb(170,170,170)]" type="button">
              Video
            </button>
          </div>
          <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
            Select Character
            <select
              className="mt-2 h-12 w-full rounded-[12px] bg-[rgb(36,36,36)] px-4 text-[13px] font-semibold text-white outline-none"
              onChange={(event) => setCharacterId(event.target.value)}
              value={characterId}
            >
              {characters.map((character) => (
                <option key={character.id} value={character.id}>
                  {character.title}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-4 block text-[12px] font-bold uppercase text-[rgb(114,113,112)]">
            Custom Prompt
            <textarea
              className="mt-2 min-h-28 w-full rounded-[12px] bg-[rgb(36,36,36)] p-4 text-[13px] font-semibold text-white outline-none"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Premium prompt unlocks after checkout"
              value={prompt}
            />
          </label>
          <button
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white disabled:opacity-70"
            disabled={pending || !characterId}
            type="submit"
          >
            <ImageIcon className="h-4 w-4" />
            {pending ? "Generating..." : "Generate"}
          </button>
          {status && (
            <p className="mt-4 text-[13px] font-medium text-[rgb(170,170,170)]">
              {status}
            </p>
          )}
        </form>

        <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
          <div className="mb-4 flex gap-2">
            {["Images", "Videos", "Liked"].map((tab, index) => (
              <button
                className={`h-9 rounded-full px-4 text-[12px] font-bold ${
                  index === 0
                    ? "bg-[rgb(46,46,46)] text-white"
                    : "text-[rgb(170,170,170)]"
                }`}
                key={tab}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {media.map((item) => (
              <div
                className="relative aspect-[4/5] overflow-hidden rounded-[14px] bg-[rgb(36,36,36)]"
                key={item.id}
              >
                <Image
                  alt=""
                  className="object-cover object-top"
                  fill
                  sizes="180px"
                  src={item.thumbnailUrl ?? item.url}
                />
                <button
                  className="absolute bottom-2 right-2 rounded-full bg-black/60 px-3 py-1 text-[11px] font-bold"
                  onClick={() => fetch(`/api/v1/media/${item.id}/like`, { method: "POST" })}
                  type="button"
                >
                  Like
                </button>
              </div>
            ))}
            {media.length === 0 && (
              <div className="col-span-full rounded-[14px] bg-[rgb(36,36,36)] p-8 text-center text-[13px] font-medium text-[rgb(170,170,170)]">
                Generated images appear here.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
