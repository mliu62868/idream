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
    const title = "Character | iDream";
    const description = "View an iDream character.";
    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        type: "website",
        siteName: "iDream",
        title,
        description,
        url: canonical,
      },
      robots: noIndexRobots,
    };
  }

  const title = `${character.name} | iDream`;
  const description =
    character.description.trim() ||
    `Meet ${character.name}, an AI character on iDream.`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      siteName: "iDream",
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
