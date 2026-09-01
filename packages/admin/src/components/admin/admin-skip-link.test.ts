// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { focusAdminMainContent } from "./admin-skip-link";

describe("Admin skip link", () => {
  afterEach(() => document.body.replaceChildren());

  it("moves keyboard focus to the main admin content", () => {
    const main = document.createElement("section");
    main.id = "admin-main-content";
    main.tabIndex = -1;
    document.body.append(main);

    expect(focusAdminMainContent()).toBe(true);
    expect(document.activeElement).toBe(main);
  });
});
