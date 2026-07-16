export type OfficialCharacterSeed = {
  readonly id: string;
  readonly title: string;
  readonly age: string;
  readonly description: string;
  readonly creator: string;
  readonly image: string;
  readonly vivid?: boolean;
};

// Seed-only cold-start catalog. Runtime product surfaces read Character authority
// from Postgres; this list exists only to build that initial official dataset.
export const officialCharacterSeeds: readonly OfficialCharacterSeed[] = [
  {
    id: "melissa-burke",
    title: "Melissa Burke",
    age: "38",
    description: "She's been your best friend's mom your whole life. The woman who made you both sandwiches after school.",
    creator: "@some1cool",
    image: "/images/ourdream/card-melissa-burke.webp",
  },
  {
    id: "summoned-world",
    title: "Summoned to Another World",
    age: "22",
    description: "(Recently Updated) A normal day at college becomes the beginning of something far greater.",
    creator: "@fuze",
    image: "/images/ourdream/card-summoned-world.webp",
  },
  {
    id: "sarah-mercer",
    title: "Sarah Mercer",
    age: "27",
    description: "Sarah Mercer is your loving wife. Eight years together, high school sweethearts.",
    creator: "@some1cool",
    image: "/images/ourdream/card-sarah-mercer.webp",
    vivid: true,
  },
  {
    id: "alexa-reeves",
    title: "Alexa Reeves",
    age: "19",
    description: "Three guys. One girl. A yacht. She knows what she's walking into.",
    creator: "@archerz",
    image: "/images/ourdream/card-alexa-reeves.webp",
    vivid: true,
  },
  {
    id: "tamsin-jacobs",
    title: "Tamsin Jacobs - A 'Bullish' Request",
    age: "20",
    description: "Friends Sister / Cuckold (Bull User). Your friend group is the bedrock of your life.",
    creator: "@wordshitmelikeablow",
    image: "/images/ourdream/card-tamsin-jacobs.webp",
    vivid: true,
  },
  {
    id: "truth-confessional",
    title: "Truth or Dare : Confessional",
    age: "18",
    description: "Your parents are away and your stepsister wants you to play with her.",
    creator: "@thebigbadwolf",
    image: "/images/ourdream/card-truth-confessional.webp",
  },
  {
    id: "truth-stepmother",
    title: "Truth or Dare: Stepmother Edition",
    age: "36",
    description: "When your stepmother invited you to join nine lively houseguests.",
    creator: "@loudshrike",
    image: "/images/ourdream/card-truth-stepmother.webp",
    vivid: true,
  },
  {
    id: "stephanie",
    title: "Stephanie, your dumbass stepsis",
    age: "18",
    description: "Your super bratty step sister was messing around and got surprised.",
    creator: "@jlg619",
    image: "/images/ourdream/card-stephanie.webp",
  },
  {
    id: "kennedy-graham",
    title: "Kennedy Graham",
    age: "21",
    description: "SEC Sorority Sisters - Book Two. Slow burn | Kennedy Graham.",
    creator: "@jmathersmind",
    image: "/images/ourdream/card-kennedy-graham.webp",
    vivid: true,
  },
  {
    id: "eleanor-dawn",
    title: "Eleanor Dawn",
    age: "21",
    description: "A blackmail story with Eleanor, who keeps control of the apartment.",
    creator: "@dreambig",
    image: "/images/ourdream/card-eleanor-dawn.webp",
    vivid: true,
  },
  {
    id: "bailey-price",
    title: "Bailey Price: One Safe Night",
    age: "19",
    description: "You never planned for any of this. You were supposed to get home tonight.",
    creator: "@towle12",
    image: "/images/ourdream/card-bailey-price.webp",
    vivid: true,
  },
  {
    id: "sophie",
    title: "Sophie - The Single Mother",
    age: "34",
    description: "It's a warm sunny moving day and she needs help around the apartment.",
    creator: "@stzy1",
    image: "/images/ourdream/card-sophie.webp",
  },
  {
    id: "raya-reyes",
    title: "Raya Reyes",
    age: "19",
    description: "She didn't want a stepdad. She didn't want her mom to remarry.",
    creator: "@some1cool",
    image: "/images/ourdream/card-raya-reyes.webp",
  },
  {
    id: "emily-coming-home",
    title: "Emily : Coming Home",
    age: "31",
    description: "Five years ago, you lost everything. Your freedom. Your family.",
    creator: "@thebigbadwolf",
    image: "/images/ourdream/card-emily-coming-home.webp",
  },
  {
    id: "diana-weird-girl",
    title: "Diana - The bet to date the weird girl !",
    age: "22",
    description: "You and your friends started a bet. John always makes the stupidest ideas.",
    creator: "@mau4971",
    image: "/images/ourdream/card-diana-weird-girl.webp",
  },
  {
    id: "lola-moonstruck",
    title: "Lola Moonstruck",
    age: "20",
    description: "Ugh, did you have to introduce myself? Fine. I'm Lola.",
    creator: "@anonarona",
    image: "/images/ourdream/card-lola-moonstruck.webp",
  },
] as const;

export const officialFeedbackItems = [
  {
    id: "seed-feedback-generator-recipes",
    sourceKey: "generator-recipes",
    title: "Saved generator recipes",
    description: "Save a prompt, character, style, orientation, and preset stack so it can be reused later.",
    category: "feature",
    status: "planned",
  },
  {
    id: "seed-feedback-creator-collections",
    sourceKey: "creator-collections",
    title: "Creator collection boards",
    description: "Let creators group characters and generated media into public boards followers can browse.",
    category: "feature",
    status: "under_review",
  },
  {
    id: "seed-feedback-chat-memory-review",
    sourceKey: "chat-memory-review",
    title: "Memory review before long chats",
    description: "Give users a quick way to inspect and adjust remembered facts before continuing a session.",
    category: "improvement",
    status: "under_review",
  },
] as const;
