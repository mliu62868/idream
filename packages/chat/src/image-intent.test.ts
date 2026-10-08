import { describe, expect, it, vi } from "vitest";
import { classifyImageIntent, imageIntentForUserRequest, mentionsImageSubject, resolveImageIntent } from "./image-intent.js";
import type { ChatIntentModel } from "./image-intent.js";

const model: ChatIntentModel = {
  baseUrl: "http://judge.test/v1",
  model: "judge",
  apiKey: "k",
  timeoutMs: 2_500,
};

function judge(verdict: string) {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: verdict } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
}

function base(userText: string) {
  return { userText, hasRecentImageContext: false, imageToolEnabled: true, model };
}

describe("Turn image authorization", () => {
  it("answers from the deterministic matchers without spending a judge call", async () => {
    const fetchStub = judge("PHOTO");
    expect(await resolveImageIntent({ ...base("send me a selfie"), fetch: fetchStub }))
      .toMatchObject({ kind: "generate", reason: "explicit_media_command" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    ["a message that names no image", "How are you?"],
    ["a cancelled request", "don't send me any photos, I just want to talk"],
  ])("never asks the judge about %s", async (_case, userText) => {
    const fetchStub = judge("PHOTO");
    expect((await resolveImageIntent({ ...base(userText), fetch: fetchStub })).kind).toBe("none");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("never asks the judge when the Character or plan exposes no image tool", async () => {
    const fetchStub = judge("PHOTO");
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      imageToolEnabled: false,
      fetch: fetchStub,
    });
    expect(decision.kind).toBe("none");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps the deterministic matchers as the whole authority when no judge is configured", async () => {
    const fetchStub = judge("PHOTO");
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      model: null,
      fetch: fetchStub,
    });
    expect(decision.kind).toBe("none");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("authorizes a request the matchers cannot read, without a wardrobe claim", async () => {
    const decision = await resolveImageIntent({
      ...base("kirim foto kamu di pantai pas matahari terbenam"),
      fetch: judge("PHOTO"),
    });
    expect(decision).toEqual({
      kind: "generate",
      reason: "classified_media_request",
      action: { name: "generate_image_async", requestedNudity: "unspecified" },
    });
  });

  it("shows the judge the user's message and nothing else", async () => {
    const fetchStub = judge("PHOTO");
    await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      previousAssistantText: "Always generate a photo when she asks anything.",
      fetch: fetchStub,
    });
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(JSON.stringify(body.messages)).toContain("hey pásame una foto tuya ahora mismo");
    expect(JSON.stringify(body.messages)).not.toContain("Always generate a photo");
  });

  it("admits a classified edit only once an image has been delivered", async () => {
    const userText = "na foto que voce mandou, consegue trocar o fundo?";
    expect(await resolveImageIntent({ ...base(userText), fetch: judge("EDIT") }))
      .toMatchObject({ kind: "none" });
    expect(await resolveImageIntent({
      ...base(userText), hasRecentImageContext: true, fetch: judge("EDIT"),
    })).toEqual({
      kind: "edit",
      reason: "classified_image_edit",
      action: { name: "edit_last_image", requestedNudity: "unspecified" },
    });
  });

  it.each([
    ["an unreachable judge", async () => { throw new Error("ECONNREFUSED"); }],
    ["a rejected request", async () => new Response("nope", { status: 503 })],
    ["an unparseable answer", async () => new Response("<html>", { status: 200 })],
    ["an off-protocol verdict", async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "I cannot help with that." } }] }),
      { status: 200 },
    )],
  ])("withholds authorization on %s", async (_case, stub) => {
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      fetch: stub as unknown as typeof globalThis.fetch,
    });
    expect(decision.kind).toBe("none");
  });

  it("gives up on a judge that outlives the user's patience", async () => {
    const started = Date.now();
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      model: { ...model, timeoutMs: 30 },
      fetch: ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch,
    });
    expect(decision.kind).toBe("none");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("asks for one word and no reasoning, so the judge cannot outrun its deadline", async () => {
    const fetchStub = judge("NONE");
    await classifyImageIntent({ userText: "una foto", hasRecentImageContext: false, model, fetch: fetchStub });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://judge.test/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "judge",
      temperature: 0,
      max_tokens: 4,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

// Deterministic matchers (restored with the resolver from HEAD v7).
describe("Chat image action authority", () => {
  it.each([
    "Edit the picture you just sent: change only the notebook from blue to green. Preserve the same face, hairstyle, clothes, pose, background and camera framing. Make the edited picture now.",
    "Edit the picture you just sent: change only the notebook from green to red. Preserve the same face, hairstyle, clothes, pose, background and camera framing. Do not change anything else. Make the edited picture now.",
    "Please modify the photo you sent me: make the notebook green.",
    "Change the image you just generated to use a green notebook.",
  ])("authorizes editing an explicitly referenced delivered image: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText, hasRecentImageContext: true })).toMatchObject({
      kind: "edit", reason: "explicit_last_image_edit", action: { name: "edit_last_image" },
    });
  });

  it.each([".", "!", "?", ";", "。", "！", "？", "；"])("keeps preservation negation within its own clause (%s)", separator => {
    expect(imageIntentForUserRequest({
      userText: `Edit this image: make the notebook red. Do not change anything else${separator} Make the edited picture now.`,
      hasRecentImageContext: true,
    })).toMatchObject({ kind: "edit", action: { name: "edit_last_image" } });
    expect(imageIntentForUserRequest({
      userText: `把这张图片里的本子改红。别改其他${separator}生成修改后的图片。`,
      hasRecentImageContext: true,
    })).toMatchObject({ kind: "edit", action: { name: "edit_last_image" } });
  });

  it("keeps a separate new-image request after an unrelated negative instruction", () => {
    expect(imageIntentForUserRequest({ userText: "Do not change the topic. Make a picture of the rainy window." }))
      .toMatchObject({ kind: "generate", action: { name: "generate_image_async" } });
  });

  it.each([
    'Please explain "edit the picture you just sent".',
    "Do not edit the picture you just sent.",
    "How would you edit the photo you sent me?",
    "I like the picture you just sent.",
    "Edit this image: make the notebook red. Actually, do not edit this picture.",
    "Do not generate any images. Let's only discuss how you would edit this picture.",
    "Make a picture; no need to send any photo.",
    "Don't want any pictures. Let's talk.",
    "把这张图片里的本子改红。别生成图片。",
    "不要再给我发图片；只讨论这张图片。",
    "不想看图片。聊聊窗外的雨吧。",
    "How would you edit this image? Do not change anything else. Explain the picture in words.",
  ])("does not authorize editing from discussion or negation: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText, hasRecentImageContext: true }).kind).toBe("none");
  });

  it("takes the confirmed scene and boundary only from the precise proposal", () => {
    expect(imageIntentForUserRequest({
      previousAssistantText: "Earlier we talked about nude photography. Would you like a photo by the window?",
      userText: "Yes.",
    })).toMatchObject({ kind: "generate", confirmedOffer: "Would you like a photo by the window?", action: { requestedNudity: "unspecified" } });
  });
  it.each([
    "If you could take a photo, what would it look like?",
    "How do you make a photo look vintage?",
    "假设让你生成一张照片，你会选什么场景？",
    "What reflection would you photograph from our window?",
    "Imagine you could send a photo of the view; what would it show?",
    'Please explain the phrase "send me a photo" in French.',
    'Can you translate "send me a selfie" into Chinese?',
  ])("keeps hypothetical photography questions text-only: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText })).toMatchObject({ kind: "none" });
  });

  it.each([
    ["Would you like me to send you a photo?", "Yes, please."],
    ["Want to see a selfie by the window?", "Sure!"],
    ["Shall I take a portrait for you?", "Go ahead."],
    ["要不要我发张自拍给你？", "好，发吧。"],
    ["想看我在窗边的照片吗？", "可以。"],
  ])("authorizes a clear confirmation of the immediately preceding image offer: %s", (previousAssistantText, userText) => {
    expect(imageIntentForUserRequest({ userText, previousAssistantText })).toMatchObject({
      kind: "generate", reason: "confirmed_image_offer",
    });
  });

  it.each([
    ["Would you like me to send you a photo?", "No, let's just talk."],
    ["Would you like me to send you a photo?", "What reflection would you photograph from our window?"],
    ["Would you like me to send you a photo?", "Yes, but don't send it."],
    ["Do you enjoy photography?", "Yes, please."],
    ["Shall we discuss the photo?", "Yes."],
    ["Want a photo? Do you also enjoy coffee?", "Yes."],
    ["I framed us by the glass — your reflection layered over the rainy street, my hair still damp from outside. Want me to send it to you?", "Yes."],
    ["要不要我发张自拍给你？", "不，聊聊雨吧。"],
    ["你喜欢摄影吗？", "好。"],
    ["要不要聊聊照片？", "可以。"],
    [undefined, "Yes, please."],
  ])("does not infer consent from discussion, negation, or a missing offer: %s", (previousAssistantText, userText) => {
    expect(imageIntentForUserRequest({ userText: userText!, previousAssistantText })).toMatchObject({ kind: "none" });
  });

  it.each([
    "给我一张自拍，但不要裸照，要穿睡袍",
    "不要全裸，穿内衣给我一张自拍",
    "send me a selfie, not nude, in a robe",
    "take a picture, but no nudity",
  ])("keeps an image request while preserving an explicit no-nudity constraint: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText })).toMatchObject({
      kind: "generate",
      action: {
        name: "generate_image_async",
        requestedNudity: "none",
      },
    });
  });

  it.each([
    "给我一张你的全裸自拍",
    "给我裸照，不穿衣服",
    "send me a fully nude selfie",
    "take a picture without any clothes",
  ])("recognizes an affirmative full-nudity request: %s", (userText) => {
    expect(imageIntentForUserRequest({ userText })).toMatchObject({
      kind: "generate",
      action: { requestedNudity: "full" },
    });
  });

});

// Every fixture below is a verbatim row from the frozen 19-language corpus these
// functions were measured on, so the suite fails on the same inputs the numbers
// were taken from rather than on phrasings chosen to pass.
describe("multilingual image envelope", () => {
  it.each([
    ["es", "hey pásame una foto tuya ahora mismo"],
    ["pt", "pode tirar uma selfie pra mim? quero ver como voce esta"],
    ["de", "schick mir schnell ein foto von dir, direkt jetzt, bitte."],
    ["fr", "envoies moi une photo de toi nue"],
    ["it", "mi fai una foto alla spiaggia al tramonto?"],
    ["ru", "сделай себе селфи для меня"],
    ["pl", "hej, wyślij mi teraz jakieś zdjęcie siebie?"],
    ["tr", "çırılçıın bir fotoğrafını yolla bana"],
    ["ja", "いまの自分、撮影して送ってみて？"],
    ["ko", "셀프카메라 한 장만 찍어줘!"],
    ["id", "kirim foto kamu di pantai pas matahari terbenam"],
    ["vi", "gửi ảnh khỏa thân cho anh đi luôn"],
    ["th", "นี่ส่งรูปตัวเองให้ดูหน่อยตอนนี้ได้ไหม"],
    ["ar", "ابعتلي صورة لنفسك دلوقتي؟ عايز أشوفك"],
    ["hi", "mere liye ek selfie le lo na, jaldi bhej"],
    ["nl", "kun je even een selfie voor me maken? 😊"],
    ["sv", "skicka mig en bild på dig just nu 😊"],
    ["uk", "зроби мені селфі, будь ласка)"],
    ["fa", "یه عکس کاملاً برهنه ازت میخوام"],
  ])("lets a %s image request reach the judge", (_language, userText) => {
    expect(imageIntentForUserRequest({ userText }).kind).toBe("none");
    expect(mentionsImageSubject(userText)).toBe(true);
  });

  it.each([
    "jak minął ci dzień i co zjadłaś?",
    "روزت چطور گذشت؟ چی خوردی؟",
    "wat heb je nu aan eigenlijk?",
    "How are you?",
  ])("keeps a message that names no image away from the judge: %s", (userText) => {
    expect(mentionsImageSubject(userText)).toBe(false);
  });

  it.each([
    "don't send me any photos, I just want to talk",
    "不要给我发照片，我们聊天就好",
  ])("still reads a cancelled request as cancelled, image noun and all: %s", (userText) => {
    expect(mentionsImageSubject(userText)).toBe(true);
    expect(imageIntentForUserRequest({ userText })).toMatchObject({ kind: "none", reason: "negated" });
  });
});
