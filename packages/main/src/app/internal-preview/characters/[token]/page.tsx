import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CharacterCard } from "@/components/ourdream/CharacterCard";
import { CharacterDetailHero } from "@/components/ourdream/CharacterDetailHero";
import { loadCharacterRendererPreview } from "@/server/modules/admin-v2/characters/renderer-preview";

export const metadata: Metadata = {
  title: "Character Draft Preview",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CharacterRendererPreviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await loadCharacterRendererPreview(token);
  if (!preview) notFound();
  const dialogue = preview.exampleDialogue.slice(0, 5);
  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] px-4 py-6 text-white md:px-10" data-testid="character-renderer-preview">
      <header className="sticky top-0 z-20 -mx-4 -mt-6 flex flex-wrap items-center justify-between gap-2 border-b border-amber-300/30 bg-amber-300 px-4 py-3 text-xs font-black uppercase tracking-[0.16em] text-black md:-mx-10 md:px-10">
        <span>{preview.authority.label}</span>
        <span>Read-only · exact avatar / hero / chat pack · ContentVersion {preview.authority.contentVersionId}</span>
      </header>

      <section aria-labelledby="card-preview-title" className="mx-auto mt-8 max-w-6xl">
        <h2 className="text-sm font-black uppercase tracking-[0.16em]" id="card-preview-title">Explore / Feed card renderer</h2>
        <div className="mt-4 w-[210px] max-w-full">
          <CharacterCard card={preview.character} href="#detail-preview" imageLoading="eager" />
        </div>
      </section>

      <section aria-labelledby="detail-preview-title" className="mx-auto mt-12 max-w-6xl" id="detail-preview">
        <h2 className="mb-4 text-sm font-black uppercase tracking-[0.16em]" id="detail-preview-title">Character detail renderer</h2>
        <CharacterDetailHero character={preview.character} />
      </section>

      <section aria-labelledby="conversation-preview-title" className="mx-auto mt-12 max-w-6xl">
        <h2 className="text-sm font-black uppercase tracking-[0.16em]" id="conversation-preview-title">Opening and five-turn QA surface</h2>
        <div className="mt-4 grid gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6">
          <p className="max-w-[80%] rounded-2xl bg-[rgb(36,36,36)] px-4 py-3 text-sm leading-6">{preview.openingMessage}</p>
          {Array.from({ length: 5 }, (_, index) => (
            <div className="grid gap-2" key={index}>
              <p className="ml-auto max-w-[80%] rounded-2xl bg-[rgb(253,95,194)] px-4 py-3 text-sm font-medium text-black">QA turn {index + 1}</p>
              <p className="max-w-[80%] rounded-2xl bg-[rgb(36,36,36)] px-4 py-3 text-sm leading-6">
                {dialogue[index] ?? `Response evidence for turn ${index + 1} must be attached before release validation.`}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="chat-image-preview-title" className="mx-auto mt-12 max-w-6xl pb-12">
        <h2 className="text-sm font-black uppercase tracking-[0.16em]" id="chat-image-preview-title">Chat image scenario</h2>
        <div className="mt-4 grid gap-4 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 sm:grid-cols-[180px_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed operator preview can resolve private media */}
          <img alt={`${preview.character.title} chat image preview`} className="aspect-square w-full rounded-xl object-cover object-top" src={preview.assetPack.character_chat.url} />
          <div className="self-center"><p className="font-bold">Pinned visual presentation</p><p className="mt-2 text-sm leading-6 text-white/60">This surface renders the exact chat-slot asset and immutable appearance snapshot without creating a chat, media asset, or online placement.</p><pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3 text-xs">{JSON.stringify({ appearance: preview.appearance, assetPack: preview.authority.assetPack }, null, 2)}</pre></div>
        </div>
      </section>
    </main>
  );
}
