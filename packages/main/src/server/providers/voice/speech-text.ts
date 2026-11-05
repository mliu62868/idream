// SPEC: the longest reply one clip can voice. The longest catalog reply is the Story
//   profile's 2048 output tokens, about 8-10k characters of English, so this bound is
//   reached only by an unusually wordy reply or a future larger profile.
// INVARIANT: the gateways enforce the same number (`MAX_SPEECH_CHARS`). Ming and Pocket
//   split long text into fragments themselves, and Fish splits for Breeze.
export const VOICE_MAX_INPUT_CHARS = 12_000;

const VOICE_TIMEOUT_CHARS = 2_000;

// SPEC: a provider's configured timeout is its budget for 2000 characters, the old
//   limit, and grows with the text. Clamping to the input bound also bounds the result,
//   and text at or below 2000 characters keeps exactly the configured timeout.
export function voiceSynthesisTimeoutMs(baseTimeoutMs: number, characters: number) {
  const scale = Math.ceil(Math.min(characters, VOICE_MAX_INPUT_CHARS) / VOICE_TIMEOUT_CHARS);
  return baseTimeoutMs * Math.max(1, scale);
}

// SPEC: what a voice should say for one reply. `*smiles softly*` is narration, so it is
//   left out rather than read aloud, while `**word**` is emphasis and keeps its word.
// INTENT: the only place this is decided, and it runs before fingerprinting, so a quote
//   and its delivery always describe the same words.
// INVARIANT: text without an asterisk comes back exactly as given (only trimmed). Every
//   earlier request for such a reply therefore keeps its fingerprint and gateway key.
export function voiceSpeechText(reply: string) {
  const text = reply.trim();
  if (!text.includes("*")) return text;
  const withoutEmphasis = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  const spoken = tidy(withoutEmphasis.replace(/\*[^*\n]+\*/g, " ").replaceAll("*", ""));
  // A reply that is only action still has to say something when someone presses Play.
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : tidy(withoutEmphasis.replaceAll("*", " "));
}

function tidy(text: string) {
  return text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/ ([,.!?;:])/g, "$1").trim();
}
