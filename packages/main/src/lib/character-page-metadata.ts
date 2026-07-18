import type { Metadata } from "next";

export type PublicCharacterPageMetadata = {
  description: string;
  imageUrl: string;
  name: string;
};

export function buildCharacterPageMetadata(
  id: string,
  character: PublicCharacterPageMetadata | null,
): Metadata {
  const canonical = `/characters/${encodeURIComponent(id)}`;
  if (!character) {
    const title = "Character | ourdream.ai";
    const description = "View an Ourdream character.";
    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        type: "website",
        siteName: "ourdream.ai",
        title,
        description,
        url: canonical,
      },
      robots: noIndexRobots,
    };
  }

  const title = `${character.name} | ourdream.ai`;
  const description =
    character.description.trim() ||
    `Meet ${character.name}, an AI character on ourdream.ai.`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      siteName: "ourdream.ai",
      title,
      description,
      url: canonical,
      images: [
        {
          url: character.imageUrl,
          alt: `${character.name} character portrait`,
        },
      ],
    },
    robots: noIndexRobots,
  };
}

const noIndexRobots = {
  index: false,
  follow: false,
  googleBot: {
    index: false,
    follow: false,
  },
} as const;
