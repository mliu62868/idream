import { describe, expect, it } from "vitest";
import { selectRecallNotes } from "./recall-notes";

const reply = "I lean back against the stacks of boxes, letting out a long exhale that's half laugh, half exhaustion. \"Honestly? We're winning.\" I nod at the cardboard mountain with its tail of packing tape.";

describe("selectRecallNotes", () => {
  it("drops a note that quotes a reply already in the transcript window", () => {
    const notes = [
      `[assistant @ 2026-10-04T11:43:14.000Z] ${reply}`,
      "[user @ 2026-09-30T23:55:00.000Z] My dog is a terrier called Lola and she hates the vacuum.",
    ];
    expect(selectRecallNotes(notes, ["Hey Sophie, how is the unpacking going today?", reply])).toEqual([notes[1]]);
  });

  it("keeps a note that only shares a few words with the transcript", () => {
    const note = "[user @ 2026-09-30T23:55:00.000Z] We're winning the garden war; the mint finally took over the balcony.";
    expect(selectRecallNotes([note], [reply])).toEqual([note]);
  });

  it("drops a short note contained in a transcript message", () => {
    expect(selectRecallNotes(["[user @ 2026-10-01T00:00:00.000Z] the mint took over"], ["Yesterday the mint took over the balcony again."])).toEqual([]);
  });

  it("caps the result and preserves order", () => {
    const notes = Array.from({ length: 8 }, (_, index) => `[user @ 2026-10-0${index + 1}T00:00:00.000Z] fact ${index} about something distinct enough to keep`);
    expect(selectRecallNotes(notes, [])).toEqual(notes.slice(0, 6));
  });
});
