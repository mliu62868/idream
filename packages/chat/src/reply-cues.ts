// SPEC: every wording-based heuristic that steers a companion Turn lives here.
// Each cue reads the user's (or previous assistant's) raw text with fixed
// patterns and nudges routing, sampling or the turn-state prompt. None of
// them is product authority: the unchanged user message always reaches the
// model, and each cue only compensates for one observed model failure.
//
// INVARIANT: the default cue set is byte-identical to the behavior that lived
// in engine.ts, media-response.ts and prompt.ts before consolidation
// (2026-11-26). Prompt and request digests must not move when cues stay on.
//
// INTENT: ADR-21 rejects keyword classification as a design; these cues exist
// because specific samples failed without them. They cover English and
// Chinese (some also Japanese/Korean or other scripts, as noted per cue);
// other languages fall through to the neutral behavior. Removal is decided by
// offline evaluation: compile/run the same Turn with `replyCues: false`
// (see `compilePreparedTurn` and `CompanionEngineOptions.replyCues`) and keep
// a cue only while the evaluation still shows the failure it compensates.
// There is deliberately no environment variable or production toggle.

/** The single switch shared by the compiler and the engine. Default: enabled. */
export interface ReplyCueOptions {
  replyCues?: boolean;
}

export interface MediaLeadTextInput {
  hasMediaTools: boolean;
  imageActionMode?: string;
  currentUserText: string;
  previousAssistantText?: string;
}

export interface ReplyCues {
  readonly enabled: boolean;
  shouldPreRecall(query: string): boolean;
  needsFactualSampling(text: string): boolean;
  shouldBufferMediaLeadText(input: MediaLeadTextInput): boolean;
  canSkipMediaExtractionForPureMedia(userText: string, independentTextRequestHint: boolean | undefined): boolean;
  describeUserLanguage(userText: string): string;
  describeRequestedReplyConstraints(userText: string, multipleRequests?: boolean): string;
}

// ---------------------------------------------------------------------------
// Pre-recall gating (engine)
// ---------------------------------------------------------------------------

/**
 * Greetings, acknowledgements and other phatic one-liners that carry nothing
 * to recall.
 *
 * Compensates: every normal Turn spawned a `mem-api memory-search` process
 * before the first token, so "hi" or "ok" paid recall latency (fast recall
 * p90 1.8 s measured; capped at 10 s) for notes the reply never used.
 * Evidence: introduced with `shouldPreRecall` (2026-08-30, f665b54a5); the
 * phatic list was extended in b559da959 (2026-11-24).
 * Languages: English and Chinese only. Other languages always pre-recall.
 */
export const TRIVIAL_PHATIC_UTTERANCE = /^(?:hi|hey|hello|yo|sup|good\s+(?:morning|afternoon|evening|night)|gm|gn|ok(?:ay)?|yes|yeah|yep|yup|no|nope|sure|thanks?|thank\s+you|ty|thx|lol|haha+|hehe+|nice|cool|wow|aww+|hmm+|uhh*|bye|goodbye|see\s+ya|你好|您好|早安|晚安|早上好|晚上好|下午好|嗯+|哦+|好+|好的|行|可以|谢谢|多谢|哈哈+|呵呵+|嘻嘻+|拜拜|再见|抱抱|亲亲|摸摸)[!！?？.。~～\s]*$/iu;

/**
 * Decide whether the automatic pre-recall search runs for this message.
 *
 * Compensates: see `TRIVIAL_PHATIC_UTTERANCE`. Explicit memory words
 * ("remember", "上次") always recall; otherwise at least two Han characters or
 * eight characters of text are required.
 * Languages: memory words and phatic list cover English and Chinese; the
 * length rule applies to every script.
 * Disabled: every non-empty message pre-recalls.
 */
export function shouldPreRecall(query: string): boolean {
  const text = query.trim();
  if (!text) return false;
  if (/(?:remember|recall|earlier|before|last time|记得|还记得|上次|之前|曾经)/iu.test(text)) {
    return true;
  }
  if (TRIVIAL_PHATIC_UTTERANCE.test(text)) return false;
  const hanCharacters = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  return hanCharacters >= 2 || text.length >= 8;
}

// ---------------------------------------------------------------------------
// Sampling temperature (engine)
// ---------------------------------------------------------------------------

/**
 * Lower the sampling temperature (min(profile, 0.2)) for exact-recall
 * questions.
 *
 * Compensates: at the expressive roleplay temperature the model paraphrased
 * identifiers it was asked to repeat (labels, access/booking codes, "copy it
 * verbatim", "what did I do"). Deliberately narrow so ordinary roleplay never
 * silently changes personality or cadence; short noun modifiers still name a
 * precise identifier (an access code, a booking reference code).
 * Evidence: introduced 2026-09-09 (e3bfe0f04) with the memory recall probes.
 * Languages: English and Chinese only.
 * Disabled: the profile temperature is always used.
 */
export function needsFactualSampling(text: string): boolean {
  return /\b(?:what\s+(?:have|did)\s+i|what\s+did\s+you|exact(?:\s+[\p{L}\p{N}-]+){0,2}\s+(?:label|name|identifier|code)|copy\s+it\s+verbatim|verbatim|identifier|code\s+word|recall)\b|(?:做了什么|我做过什么|完整标签|原样|逐字|标识符|暗号)/iu.test(text);
}

// ---------------------------------------------------------------------------
// Media turn routing (media-response)
// ---------------------------------------------------------------------------

/**
 * Words that suggest the current message asks for a photo, video or edit.
 *
 * Compensates: provisional text such as "here's the photo!" streamed before
 * the media tool call and then had to be cleared with `text_reset` (visible
 * flicker, and a promise the card may not keep). Buffering every media-capable
 * Turn instead cost all ordinary text Turns (~85-90% of traffic) their live
 * first token.
 * Evidence: intent-aware buffering, composition execution version 79,
 * b559da959 (2026-11-24).
 * Languages: English, Chinese, Japanese and Korean. Other languages stream
 * live and rely on `text_reset` when a media tool is still selected.
 */
export const MEDIA_INTENT_SIGNAL = new RegExp([
  "\\b(?:photos?|pics?|pictures?|images?|selfies?|videos?|clips?|snapshots?|portraits?|draw(?:ing)?|paint(?:ing)?|edit|recolor|redraw|restyle|regenerate|redo|resend|visuals?|camera|shoot|pose|wearing|outfit|dress|undress|naked|nude|lingerie|bikini|show\\s+me|send\\s+(?:me\\s+)?(?:a|an|one|that|the|another|your|it))\\b",
  "(?:照片|图片|自拍|图|照|视频|影片|片段|短片|镜头|画面|重发|再发|再看|发我|发一张|来一张|拍一张|发个|换装|改图|修改|重画|重绘|换成|改成|穿上|脱|裸|比基尼|内衣)",
  "(?:写真|画像|自撮り|動画|クリップ|送って|見せて|編集|書き直|作り直)",
  "(?:사진|이미지|셀카|영상|동영상|클립|보내줘|보여줘|수정|편집)",
].join("|"), "iu");

/**
 * A short reply that accepts an offer made in the previous assistant turn
 * ("yes please", "发吧").
 *
 * Compensates: "yes" after "want a photo of me at the beach?" carries no media
 * word itself, so the confirmation streamed provisional text before the tool
 * call. Evidence: same change as `MEDIA_INTENT_SIGNAL` (b559da959,
 * 2026-11-24).
 * Languages: English, Chinese, Japanese and Korean.
 */
export const SHORT_CONFIRMATION = /^(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|send it|show me|yes please|好|好的|好呀|好呀发吧|行|行呀|可以|发吧|要|嗯|嗯嗯|是的|可以呀|来吧|はい|うん|お願い|네|응|좋아|보내)[!！.。~～\s]*$/iu;

/**
 * Decide whether to buffer text during the native tool-selection round.
 * Buffering prevents provisional media promises from leaking before a tool
 * call, while allowing ordinary text-only chat turns (~85-90% of traffic) to
 * stream live tokens immediately for low TTFT. If an unbuffered turn still
 * unexpectedly emits a media tool call, `text_reset` clears the live stream.
 *
 * Compensates and evidence: see `MEDIA_INTENT_SIGNAL` and `SHORT_CONFIRMATION`.
 * Paid authorization always buffers (not a wording cue).
 * Disabled: every Turn with media tools buffers (no leak, no live TTFT).
 */
export function shouldBufferMediaLeadText(input: MediaLeadTextInput): boolean {
  if (!input.hasMediaTools) return false;
  if (input.imageActionMode === "paid") return true;
  const text = input.currentUserText.trim();
  if (!text) return false;
  if (MEDIA_INTENT_SIGNAL.test(text)) return true;
  if (
    text.length <= 40
    && SHORT_CONFIRMATION.test(text)
    && Boolean(input.previousAssistantText && MEDIA_INTENT_SIGNAL.test(input.previousAssistantText))
  ) {
    return true;
  }
  return false;
}

/**
 * Connectives that introduce a second task ("also", "顺便").
 *
 * Compensates: the model sometimes set `independentTextRequest: false` on a
 * message that also asked a question; skipping extraction then dropped that
 * question silently. Evidence: pure-media fast path, composition execution
 * version 79, b559da959 (2026-11-24).
 * Languages: English, Simplified and Traditional Chinese.
 */
export const MULTI_TASK_CONJUNCTION = /\b(?:also|and\s+(?:also|tell|explain|write|answer|name|give|describe|say|list|summarize)|plus|besides|by\s+the\s+way|btw)\b|(?:顺便|另外|还有|顺带|同时|并且|再帮我|再告诉我|再写|顺手|另外再|還有|順便|再幫我)/iu;

/**
 * Fast-path pure-media replies without paying a second LLM extraction call.
 * Requires both an explicit `independentTextRequest: false` signal from the
 * model AND a conservative deterministic guard proving the user message is a
 * single short non-question request without multi-task conjunctions.
 *
 * Compensates: a pure "send me a selfie" Turn paid a whole serial extraction
 * request (and its blockquote-format failure risk) to learn there was no text
 * to answer. Evidence: see `MULTI_TASK_CONJUNCTION`.
 * Languages: conjunctions cover English and Chinese; the punctuation guards
 * (no newline, question mark, comma or inner sentence break) apply to all.
 * Disabled: extraction always runs (verified tool excerpts may still skip it;
 * that path checks model output against the source and is not a wording cue).
 */
export function canSkipMediaExtractionForPureMedia(
  userText: string,
  independentTextRequestHint: boolean | undefined,
): boolean {
  if (independentTextRequestHint !== false) return false;
  const trimmed = userText.trim();
  if (!trimmed || trimmed.length > 160) return false;
  if (/[\r\n]/u.test(trimmed)) return false;
  if (/[?？]/u.test(trimmed)) return false;
  if (MULTI_TASK_CONJUNCTION.test(trimmed)) return false;
  // Conservatively route comma-separated clauses (e.g. "发张自拍，夸夸我") and
  // multi-sentence messages through full extraction so no second task is missed.
  if (/[,，]/u.test(trimmed)) return false;
  const withoutTrailingPunct = trimmed.replace(/[.!。！~～]+$/u, "").trim();
  if (/[.!;。！？；]/u.test(withoutTrailingPunct)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Turn-state prompt lines (prompt)
// ---------------------------------------------------------------------------

/**
 * SPEC: one deterministic line naming the writing system of the current user
 * message, for scripts the model otherwise drifts away from. Latin-script
 * messages get nothing: English is the default register of the whole prompt.
 * INTENT: with the prompt and turn context in English, 1 of 4 Chinese
 * samples came back in English and the rest mixed English words in (A/B
 * 2026-10-04, Han ratio 0.66 vs 0.85). The reply language is a fact about
 * the user's message, so it is stated as one, next to the message.
 * Languages: Japanese, Korean, Chinese, Russian, Arabic, Hindi, Thai (by
 * script). Latin-script languages other than English get no line.
 * Disabled: no language line.
 */
export function describeUserLanguage(userText: string): string {
  const scripts: Array<[RegExp, string]> = [
    [/\p{Script=Hiragana}|\p{Script=Katakana}/u, "Japanese"],
    [/\p{Script=Hangul}/u, "Korean"],
    [/\p{Script=Han}/u, "Chinese"],
    [/\p{Script=Cyrillic}/u, "Russian"],
    [/\p{Script=Arabic}/u, "Arabic"],
    [/\p{Script=Devanagari}/u, "Hindi"],
    [/\p{Script=Thai}/u, "Thai"],
  ];
  const language = scripts.find(([pattern]) => pattern.test(userText))?.[1];
  return language ? `They are writing in ${language}; answer in ${language}.` : "";
}

const MULTIPLE_REQUESTS_CONSTRAINT = "Answer each independent request in order. Apply its own language, length and formatting instructions to that part of the reply.";

/**
 * INTENT: Keep explicit current-request constraints next to the original text.
 * These optional cues abstain on ambiguous/reporting syntax; the unchanged
 * message remains authoritative. A quote is a barrier, never deleted into a
 * new imperative assembled from words on either side.
 *
 * Compensates: the model overran explicit counts ("in exactly two sentences",
 * "three actions of your own", "用一句话"), narrated actions in the third
 * person, analysed the user during a "just sit with me… don't analyze"
 * request, and answered "why do you like…" with claims about the user.
 * Evidence: introduced 2026-10-24 (d9999b859) from individual failing samples
 * of the reply-form probes; the companionship and preference scopes are
 * single-sample rules.
 * Languages: English; "一句话" is the only Chinese pattern.
 * Disabled: only the structural multi-request line remains (it is chosen by
 * verified media excerpts, not by wording).
 */
export function describeRequestedReplyConstraints(userText: string, multipleRequests = false): string {
  if (multipleRequests) {
    return MULTIPLE_REQUESTS_CONSTRAINT;
  }
  const unquoted = userText.replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]+'(?!\w)/gu, "￼");
  if (/\b(?:actually|instead|ignore|forget|retract)\b/iu.test(unquoted)
    || /[\r\n]/u.test(userText) && /\b(?:said|asked|wrote)\s*:/iu.test(unquoted)) return "";
  const counts = new Map<string, number>();
  let ownActions = true;
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const number = `(?:a single|${words.join("|")}|[1-9]\\d?)`;
  const pattern = new RegExp(`\\b(?:(?:exactly|just|only)\\s+)?(${number})\\s+(?:(?:short|brief|English|small|spoken)\\s+)*(sentences?|actions?)\\b`, "giu");
  const range = new RegExp(`\\b${number}\\s*(?:or|to|[-–])\\s*${number}\\b`, "iu");
  for (const clause of unquoted.split(/[.!?;\n]/u)) {
    if (range.test(clause) || /\b(?:at least|at most|up to|more than|less than|fewer than|between|or fewer|or less)\b/iu.test(clause)) continue;
    const requested = /^\s*(?:(?:please|just|only)\s+)?(?:if\b[^,]*,\s*)?(?:(?:in|with)\b[^,]*,\s*)?(?:answer|reply|respond|say|write|tell|describe|give|continue|acknowledge|summari[sz]e|explain|state|use|keep|limit|check|sit|stay|talk|speak)\b/iu.test(clause);
    for (const match of clause.matchAll(pattern)) {
      const before = clause.slice(0, match.index);
      if (/\b(?:not|never|avoid|don['’]t)\b/iu.test(before)) continue;
      if (!requested && !/^\s*(?:in\s+)?$/iu.test(before)) continue;
      const raw = match[1]!.toLowerCase();
      const count = raw === "a single" ? 1 : words.includes(raw) ? words.indexOf(raw) + 1 : Number(raw);
      const kind = match[2]!.toLowerCase().startsWith("action") ? "action"
        : /\bspoken\b/iu.test(match[0]) ? "spoken sentence" : "sentence";
      if (kind === "action") ownActions &&= /^\s+of\s+your\s+own\b/iu.test(clause.slice(match.index + match[0].length))
        || /\byour\s+own\s*$/iu.test(before);
      // Repeated counts may describe separate parts, even when equal. Leave
      // their composition to the original request instead of imposing a total.
      if (counts.has(kind)) return "";
      counts.set(kind, count);
    }
    if (/一句话/u.test(clause) && /(?:用|请|只|回答|回复)/u.test(clause) && !/(?:不|别|不要|至少|至多)/u.test(clause)) {
      if (counts.has("sentence") || clause.match(/一句话/gu)!.length > 1) return "";
      counts.set("sentence", 1);
    }
  }
  const scopes: string[] = [];
  const reportedOrRevised = /[\r\n]/u.test(userText)
    || /\b(?:yesterday|earlier|previously|said|asked|wrote|translate(?:d)?|summari[sz]e)\b|\b(?:was|were)\s+(?:(?:his|her|their|my|the|our)\s+)?(?:question|request|instruction)\b|\b(?:do not|don['’]t)\s+answer\s+(?:that|this|the question)\b/iu.test(unquoted);
  if (!reportedOrRevised) {
    const clauses = unquoted.split(/[.!?;]/u).map(value => value.trim()).filter(Boolean);
    const companyRequest = new RegExp(`^(?:please\\s+)?(?:just|only)\\s+(?:(?:sit|stay|be)\\s+(?:here\\s+)?with\\s+me|keep\\s+me\\s+company)(?:\\s+(?:quietly|in silence|as yourself|for a while))*(?:\\s+and\\s+(?:say|speak|use|answer(?:\\s+in)?|reply(?:\\s+in)?|respond(?:\\s+in)?)\\s+(?:exactly\\s+)?${number}\\s+(?:English\\s+)?sentences?)?$`, "iu");
    if (companyRequest.test(clauses.at(-1) ?? "")
      && clauses.some(value => /^(?:please\s+)?(?:do not|don['’]t)\s+analy[sz]e\b/iu.test(value))) {
      // This bounds the companionship component, never the entire message:
      // the same user may also ask a separate factual question.
      scopes.push("For the requested companionship, describe only your own immediate actions or sensations; speak about being here with the user. Keep that companionship free of judgments about the event, its significance or the user's abilities.");
    }
    if (counts.has("action") && ownActions) {
      scopes.push("Action narration uses the same viewpoint as your speech: I/me/my/mine for yourself and you/your/yours for the user, in every clause.");
    }
    const questions = unquoted.match(/[^.!?;]+\?/gu) ?? [];
    if (questions.some(value => /^\s*(?:why|what)\s+(?:do|did)\s+you\s+(?:like|love|enjoy|prefer|dislike|hate)\b/iu.test(value))) {
      scopes.push("For this preference question, any described experience is your own. When using pronouns for that experience, use I/my; any statement about how the user feels needs their stated experience. Keep the requested answer form.");
    }
  }
  if (!counts.size && !scopes.length) return "";
  const form = [...counts].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}${kind === "sentence" ? " in the entire reply, including action descriptions" : ""}`).join(" and ");
  return [
    ...(counts.size ? [`Their current request specifies exactly ${form}. Keep all content within that form; end after it.`] : []),
    // A total multi-sentence form leaves separate prose for reactions; make
    // clear that incidental movements there also consume the action count.
    ...(counts.has("action") ? [(counts.get("sentence") ?? 0) > 1
      ? "Use one physical verb per requested action; describe other reactions through thoughts or sensations, without extra bodily movements."
      : "The action count covers the entire reply, including physical reactions. Count distinct actions, not sentences; one continuous gesture is one action."] : []),
    ...(counts.get("spoken sentence") === 1
      ? ["Keep all speech, including interjections, in one sentence."]
      : counts.has("spoken sentence") ? ["A standalone interjection counts as a spoken sentence."] : []),
    ...scopes,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

const ENABLED_REPLY_CUES: ReplyCues = Object.freeze({
  enabled: true,
  shouldPreRecall,
  needsFactualSampling,
  shouldBufferMediaLeadText,
  canSkipMediaExtractionForPureMedia,
  describeUserLanguage,
  describeRequestedReplyConstraints,
});

/** Neutral behavior for offline evaluation: no wording influences the Turn. */
const DISABLED_REPLY_CUES: ReplyCues = Object.freeze({
  enabled: false,
  shouldPreRecall: (query: string) => query.trim().length > 0,
  needsFactualSampling: () => false,
  shouldBufferMediaLeadText: (input: MediaLeadTextInput) => input.hasMediaTools,
  canSkipMediaExtractionForPureMedia: () => false,
  describeUserLanguage: () => "",
  describeRequestedReplyConstraints: (_userText: string, multipleRequests = false) =>
    multipleRequests ? MULTIPLE_REQUESTS_CONSTRAINT : "",
});

/** Resolve the cue set; omitted options keep the production (enabled) cues. */
export function replyCues(options: ReplyCueOptions = {}): ReplyCues {
  return options.replyCues === false ? DISABLED_REPLY_CUES : ENABLED_REPLY_CUES;
}
