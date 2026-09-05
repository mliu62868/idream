// Main has accepted the request; this copy must never claim delivery is complete.
export const IMAGE_ACKNOWLEDGEMENT_VERSION = "image-action-ack-1" as const;

const replies = {
  en: "Okay, your image request is confirmed.",
  zh: "好，图片请求已确认。",
  ja: "はい、画像のリクエストを受け付けました。",
  ko: "네, 이미지 요청이 접수되었어요.",
  ru: "Хорошо, запрос на изображение принят.",
  ar: "حسنًا، تم قبول طلب الصورة.",
  hi: "ठीक है, तस्वीर का अनुरोध स्वीकार कर लिया गया है।",
  es: "De acuerdo, tu solicitud de imagen está confirmada.",
  fr: "D’accord, ta demande d’image est confirmée.",
  de: "Okay, deine Bildanfrage ist bestätigt.",
  pt: "Certo, seu pedido de imagem está confirmado.",
  it: "Va bene, la tua richiesta di immagine è confermata.",
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
