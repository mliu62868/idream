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
  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] px-4 py-6 text-white md:px-10" data-testid="character-renderer-preview">
      <header className="sticky top-0 z-20 -mx-4 -mt-6 flex flex-wrap items-center justify-between gap-2 border-b border-amber-300/30 bg-amber-300 px-4 py-3 text-xs font-black uppercase tracking-[0.16em] text-black md:-mx-10 md:px-10">
        <span>{preview.authority.label}</span>
        <span>只读预览 · 头像、详情和聊天图片均来自此版本</span>
      </header>

      <section aria-labelledby="card-preview-title" className="mx-auto mt-8 max-w-6xl">
        <h2 className="text-sm font-black uppercase tracking-[0.16em]" id="card-preview-title">发现页角色卡片</h2>
        <div className="mt-4 w-[210px] max-w-full">
          <CharacterCard card={preview.character} href="#detail-preview" imageLoading="eager" />
        </div>
      </section>

      <section aria-labelledby="detail-preview-title" className="mx-auto mt-12 max-w-6xl" id="detail-preview">
        <h2 className="mb-4 text-sm font-black uppercase tracking-[0.16em]" id="detail-preview-title">角色详情</h2>
        <CharacterDetailHero character={preview.character} />
      </section>

      <section aria-labelledby="conversation-preview-title" className="mx-auto mt-12 max-w-6xl">
        <h2 className="text-sm font-black uppercase tracking-[0.16em]" id="conversation-preview-title">角色开场</h2>
        <div className="mt-4 grid gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6">
          <p className="max-w-[80%] rounded-2xl bg-[rgb(36,36,36)] px-4 py-3 text-sm leading-6">{preview.openingMessage}</p>
        </div>
      </section>

      <section aria-labelledby="chat-image-preview-title" className="mx-auto mt-12 max-w-6xl pb-12">
        <h2 className="text-sm font-black uppercase tracking-[0.16em]" id="chat-image-preview-title">聊天图片</h2>
        <div className="mt-4 grid gap-4 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 sm:grid-cols-[180px_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed operator preview can resolve private media */}
          <img alt={`${preview.character.title} chat image preview`} className="aspect-square w-full rounded-xl object-cover object-top" src={preview.assetPack.character_chat.url} />
          <div className="self-center"><p className="font-bold">当前版本的聊天图片</p><p className="mt-2 text-sm leading-6 text-white/60">这里展示当前快照中的聊天图片。预览不会发起聊天或改变线上内容。</p><details className="mt-3"><summary className="cursor-pointer text-sm">技术详情</summary><pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3 text-xs">{JSON.stringify({ appearance: preview.appearance, assetPack: preview.authority.assetPack }, null, 2)}</pre></details></div>
        </div>
      </section>
    </main>
  );
}
