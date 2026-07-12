import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeadLetterWorkspace } from "./DeadLetterWorkspace";

describe("Dead Letter workspace permission surface", () => {
  it("keeps authority filters available while withholding high-risk writes", () => {
    const html = renderToStaticMarkup(<DeadLetterWorkspace permissions={{ discard: false, requeue: false }} />);

    expect(html).toContain("Dead-letter Queue");
    expect(html).toContain("Search job, user, provider, or error");
    expect(html).toContain("generation.job.requeue is not granted");
    expect(html).toContain("ops.deadletter.write is not granted");
    expect(html).not.toContain("Discard selected");
  });

  it("exposes the same loading and source-freshness semantics to writers", () => {
    const html = renderToStaticMarkup(<DeadLetterWorkspace permissions={{ discard: true, requeue: true }} />);
    expect(html).toContain("source freshness watermark unavailable");
    expect(html).toContain('aria-label="Loading dead-letter authority"');
  });
});
