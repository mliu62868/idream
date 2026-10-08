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

  it("keeps unseen user facts in a note that also quotes a visible assistant reply", () => {
    const fact = "My greenhouse pickup code is Larch-5816, and the window is Thursday at 16:40 UTC.";
    const note = `[user @ 2026-10-01T10:00:00.000Z] ${fact} [assistant @ 2026-10-01T10:00:01.000Z] ${reply}`;
    // The visible reply is dropped; the unseen fact stays with its source marker.
    expect(selectRecallNotes([note], [reply, "What is my greenhouse pickup code and its pickup window?"]))
      .toEqual([`[user @ 2026-10-01T10:00:00.000Z] ${fact}`]);
  });

  it("bounds each segment and the total so recall cannot crowd out the dialogue", () => {
    const long = "x".repeat(900);
    const notes = Array.from({ length: 6 }, (_, index) => `[user @ 2026-10-0${index + 1}T00:00:00.000Z] fact ${index} ${long}`);
    const selected = selectRecallNotes(notes, []);
    expect(selected[0]?.endsWith("…")).toBe(true);
    expect(selected.join("").length).toBeLessThanOrEqual(2_400 + 600);
    expect(selected.length).toBeLessThan(6);
  });

  it("keeps a corrected fact when only its opening is already in the transcript", () => {
    const opening = "I keep the collection instructions in the blue notebook beside the greenhouse window. ";
    const previous = `${opening}My pickup code is Larch-5816, and the window is Thursday at 16:40 UTC.`;
    const corrected = `${opening}Correction: my pickup code is Cedar-2047, and the window is Friday at 15:20 UTC.`;
    const note = `[user @ 2026-10-02T10:00:00.000Z] ${corrected}`;
    expect(selectRecallNotes([note], [previous, "What is my current pickup code and its pickup window?"])).toEqual([note]);
  });

  it("drops a complete note already visible across adjacent transcript messages", () => {
    const fact = "My greenhouse pickup code is Larch-5816, and the window is Thursday at 16:40 UTC.";
    const note = `[user @ 2026-10-01T10:00:00.000Z] ${fact} [assistant @ 2026-10-01T10:00:01.000Z] ${reply}`;
    expect(selectRecallNotes([note], [fact, reply])).toEqual([]);
  });

  it("caps the result and preserves order", () => {
    const notes = Array.from({ length: 8 }, (_, index) => `[user @ 2026-10-0${index + 1}T00:00:00.000Z] fact ${index} about something distinct enough to keep`);
    expect(selectRecallNotes(notes, [])).toEqual(notes.slice(0, 6));
  });
});
