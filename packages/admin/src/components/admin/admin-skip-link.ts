export function focusAdminMainContent() {
  const target = document.getElementById("admin-main-content");
  if (!(target instanceof HTMLElement)) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}
