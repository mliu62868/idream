// Main has accepted the request; this copy must never claim delivery is complete.
// INTENT: it stands in for the character's own line, so it reads as something a
// person says while reaching for the camera, not as a system receipt — the
// attachment card below already shows the progress and the price.
export const IMAGE_ACKNOWLEDGEMENT_VERSION = "image-action-ack-1" as const;

const replies = {
  en: "Give me a moment…",
  zh: "等我一下……",
  ja: "ちょっと待ってね…",
  ko: "잠깐만 기다려 줘…",
  ru: "Дай мне минутку…",
  ar: "امنحني لحظة…",
  hi: "बस एक पल…",
  es: "Dame un momento…",
  fr: "Laisse-moi une seconde…",
  de: "Gib mir einen Moment…",
  pt: "Me dá um segundinho…",
  it: "Dammi un attimo…",
} as const;

export function imageAcknowledgement(userText: string, userLocale: string) {
  // Current writing system wins over a saved locale, just as for normal replies.
  const scripts = [
    ["ja", /\p{Script=Hiragana}|\p{Script=Katakana}/u],
    ["ko", /\p{Script=Hangul}/u],
    ["zh", /\p{Script=Han}/u],
    ["ru", /\p{Script=Cyrillic}/u],
    ["ar", /\p{Script=Arabic}/u],
    ["hi", /\p{Script=Devanagari}/u],
  ] as const;
  const requested = scripts.find(([, pattern]) => pattern.test(userText))?.[0]
    ?? userLocale.toLowerCase().split(/[-_]/u)[0];
  const locale = Object.hasOwn(replies, requested) ? requested as keyof typeof replies : "en";
  return { version: IMAGE_ACKNOWLEDGEMENT_VERSION, locale, content: replies[locale] };
}
