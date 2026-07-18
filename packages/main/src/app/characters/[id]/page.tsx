import type { Metadata } from "next";
import { CharacterDetailClient } from "@/components/ourdream/CharacterDetailClient";
import { buildCharacterPageMetadata } from "@/lib/character-page-metadata";
import { loadPublicCharacterPageMetadata } from "@/server/public-character-metadata";

type PageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return buildCharacterPageMetadata(
    id,
    await loadPublicCharacterPageMetadata(id),
  );
}

export default async function CharacterPage({ params }: PageProps) {
  const { id } = await params;
  return <CharacterDetailClient id={id} key={id} />;
}
