import { CharacterDetailClient } from "@/components/ourdream/CharacterDetailClient";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CharacterPage({ params }: PageProps) {
  const { id } = await params;
  return <CharacterDetailClient id={id} />;
}
