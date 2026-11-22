import type { KeyboardEvent } from "react";

export function keepDialogTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.hasAttribute("hidden"));
  const first = focusable[0];
  const last = focusable.at(-1);
  const from = event.shiftKey ? first : last;
  const to = event.shiftKey ? last : first;
  if (to && document.activeElement === from) {
    event.preventDefault();
    to.focus();
  }
}
