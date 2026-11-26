import { Fragment, type ReactNode } from "react";

export type RoleplaySegment = { readonly kind: "text" | "action" | "strong"; readonly text: string };

// `**strong**` first so its stars are not read as two empty actions; a span
// never crosses a line break, so an unmatched `*` mid-stream stays literal,
// and like Markdown it cannot open or close on a space (`2 * 3 * 4`).
const ROLEPLAY_MARKUP = /\*\*(\S(?:[^*\n]*\S)?)\*\*|\*(\S(?:[^*\n]*\S)?)\*/g;

// SPEC: Roleplay replies mark actions as `*smiles softly*`. Split the text into
//       plain, action and strong segments; quoted dialogue stays plain text.
// INVARIANT: segments are text only — the renderer builds React elements, so
//            message content can never inject markup.
export function roleplaySegments(text: string): RoleplaySegment[] {
  const segments: RoleplaySegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(ROLEPLAY_MARKUP)) {
    const start = match.index ?? 0;
    const inner = match[1] ?? match[2] ?? "";
    // `* *` or `*  *` is punctuation, not an action.
    if (!inner.trim()) continue;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: match[1] !== undefined ? "strong" : "action", text: inner });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

export function ChatMessageText({ text }: Readonly<{ text: string }>): ReactNode {
  const segments = roleplaySegments(text);
  return segments.map((segment, index) => segment.kind === "action"
    ? <em className="italic opacity-80" data-roleplay="action" key={index}>{segment.text}</em>
    : segment.kind === "strong"
      ? <strong className="font-bold" key={index}>{segment.text}</strong>
      : <Fragment key={index}>{segment.text}</Fragment>);
}
