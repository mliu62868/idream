import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeadLetterWorkspace } from "./DeadLetterWorkspace";

describe("Dead Letter workspace permission surface", () => {
  it("keeps authority filters available while withholding high-risk writes", () => {
    const html = renderToStaticMarkup(<DeadLetterWorkspace canWrite={false} />);

    expect(html).toContain("Dead-letter Queue");
    expect(html).toContain("Search job, user, provider, or error");
    expect(html).toContain("Read only · ops.deadletter.write is not granted");
    expect(html).not.toContain("Discard selected");
  });

  it("exposes the same loading and source-freshness semantics to writers", () => {
    const html = renderToStaticMarkup(<DeadLetterWorkspace canWrite />);
    expect(html).toContain("source freshness watermark unavailable");
    expect(html).toContain('aria-label="Loading dead-letter authority"');
  });
});
