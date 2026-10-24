export function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  // Cross-origin URLs may ignore download; never replace the current workspace.
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}
