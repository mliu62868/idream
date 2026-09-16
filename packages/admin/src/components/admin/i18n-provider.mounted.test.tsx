// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AdminI18nProvider, useAdminI18n } from "./i18n";
import type { AdminI18nContextValue } from "./i18n-dictionary";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps translations stable across provider renders and updates them when locale changes", async () => {
  const observed: AdminI18nContextValue[] = [];
  function Consumer() { const value = useAdminI18n(); observed.push(value); return value.t("Refresh"); }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AdminI18nProvider locale="en"><Consumer /></AdminI18nProvider>));
    const initial = observed.at(-1)!;
    await act(async () => root.render(<AdminI18nProvider locale="en"><Consumer /></AdminI18nProvider>));
    expect(observed.at(-1)).toBe(initial);
    await act(async () => root.render(<AdminI18nProvider locale="zh"><Consumer /></AdminI18nProvider>));
    expect(observed.at(-1)?.t).not.toBe(initial.t);
    expect(container.textContent).toBe("刷新");
  } finally { await act(async () => root.unmount()); }
});
