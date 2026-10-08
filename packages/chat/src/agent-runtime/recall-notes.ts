/**
 * SPEC: choose which recalled memory notes may enter the turn. A note that
 * is wholly contained in the ordered transcript window is dropped.
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
// INTENT (2026-10-08): igrep joins several messages into one note, so a note with
// one unseen line used to carry every already-visible reply with it. On a real
// 18-turn session that pushed each request ~1.5k tokens past the admitted budget
// and DSH compacted every turn (12–17 s replies). Dedup per message segment, and
// bound the total, so recall only adds what fell out of view.
const MAX_SEGMENT_CHARS = 500;
const MAX_RECALL_CHARS = 2_400;
const SEGMENT_MARKER = /\[(?:user|assistant|character|companion)\s*@[^\]]*\]/giu;

export function selectRecallNotes(
  notes: readonly string[],
  transcript: readonly string[],
  limit = 6,
): string[] {
  const window = transcript.map(normalize).filter((text) => text.length > 0).join(" ");
  const selected: string[] = [];
  let used = 0;
  for (const note of notes) {
    if (selected.length >= limit) break;
    if (normalize(note).length === 0) continue;
    // A shared passage can sit beside an unseen fact or a later correction.
    // Only a segment wholly visible in the window is redundant; partial overlap stays.
    const unseen = segments(note).filter((segment) => {
      const body = normalize(segment.text);
      return body.length > 0 && !window.includes(body);
    });
    if (unseen.length === 0) continue;
    const kept = unseen.map(({ marker, text }) => {
      const trimmed = text.trim();
      const bounded = trimmed.length > MAX_SEGMENT_CHARS ? `${trimmed.slice(0, MAX_SEGMENT_CHARS - 1)}…` : trimmed;
      return marker ? `${marker} ${bounded}` : bounded;
    }).join(" ");
    if (used + kept.length > MAX_RECALL_CHARS && selected.length > 0) break;
    selected.push(kept);
    used += kept.length;
  }
  return selected;
}

/** Split a note at igrep's "[role @ time]" markers, keeping each marker with its text. */
function segments(note: string): Array<{ marker: string | null; text: string }> {
  const markers = [...note.matchAll(SEGMENT_MARKER)];
  if (markers.length === 0) return [{ marker: null, text: note }];
  const result: Array<{ marker: string | null; text: string }> = [];
  const lead = note.slice(0, markers[0].index).trim();
  if (lead) result.push({ marker: null, text: lead });
  markers.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = markers[index + 1]?.index ?? note.length;
    result.push({ marker: match[0], text: note.slice(start, end) });
  });
  return result;
}

/** Strip the source prefix igrep adds ("[assistant @ 2026-…]") and collapse whitespace. */
function normalize(value: string): string {
  return value
    .replace(/\[(?:user|assistant|character|companion)\s*@[^\]]*\]/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
