import { describe, expect, it } from "vitest";
import { buildCharacterPageMetadata } from "./character-page-metadata";

describe("character page metadata", () => {
  it("uses public character facts for the title, description, and share image", () => {
    const metadata = buildCharacterPageMetadata("lola/moonstruck", {
      description: "A thoughtful romantic companion.",
      imageUrl: "/media/lola.jpg",
      name: "Lola Moonstruck",
    });

    expect(metadata).toMatchObject({
      title: "Lola Moonstruck | ourdream.ai",
      description: "A thoughtful romantic companion.",
      alternates: {
        canonical: "/characters/lola%2Fmoonstruck",
      },
      openGraph: {
        title: "Lola Moonstruck | ourdream.ai",
        description: "A thoughtful romantic companion.",
        url: "/characters/lola%2Fmoonstruck",
        images: [
          {
            url: "/media/lola.jpg",
            alt: "Lola Moonstruck character portrait",
          },
        ],
      },
      robots: {
        index: false,
        follow: false,
      },
    });
  });

  it("does not expose metadata for a character outside public authority", () => {
    expect(buildCharacterPageMetadata("private-character", null)).toMatchObject({
      title: "Character | ourdream.ai",
      description: "View an Ourdream character.",
      alternates: {
        canonical: "/characters/private-character",
      },
      openGraph: {
        title: "Character | ourdream.ai",
        description: "View an Ourdream character.",
        url: "/characters/private-character",
      },
      robots: {
        index: false,
        follow: false,
      },
    });
  });
});
