/**
 * SPEC: choose which recalled memory notes may enter the turn. A note that
 * repeats text already in the transcript window is dropped.
 *
 * INTENT: Main projects every committed Turn into memory within seconds, so a
 * fast recall for "what's my name, and do I have a dog?" returned the
 * Character's own reply from two minutes earlier (it mentioned "the dog").
 * Quoted back inside the current user message, right before the question,
 * that line became the strongest signal in the prompt: the reply at 11:45Z
 * on 2026-10-04 (session 26736faf) repeated the 11:43Z reply almost
 * verbatim and never answered the question. The transcript already carries
 * everything in the window; recall is for what fell out of it.
 */
const OVERLAP_WINDOW = 60;

export function selectRecallNotes(
  notes: readonly string[],
  transcript: readonly string[],
  limit = 6,
): string[] {
  const window = transcript.map(normalize).filter((text) => text.length > 0);
  const selected: string[] = [];
  for (const note of notes) {
    if (selected.length >= limit) break;
    const body = normalize(note);
    if (body.length === 0) continue;
    if (overlapsTranscript(body, window)) continue;
    selected.push(note);
  }
  return selected;
}

function overlapsTranscript(body: string, window: readonly string[]): boolean {
  if (body.length < OVERLAP_WINDOW) {
    return window.some((text) => text.includes(body));
  }
  // Slide a window over the note; any 60-character run already present in a
  // transcript message means the note is quoting what the model can see.
  for (let start = 0; start + OVERLAP_WINDOW <= body.length; start += 20) {
    const slice = body.slice(start, start + OVERLAP_WINDOW);
    if (window.some((text) => text.includes(slice))) return true;
  }
  return false;
}

/** Strip the source prefix igrep adds ("[assistant @ 2026-…]") and collapse whitespace. */
function normalize(value: string): string {
  return value
    .replace(/\[(?:user|assistant|character|companion)\s*@[^\]]*\]/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
