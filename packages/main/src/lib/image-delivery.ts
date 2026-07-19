const DIRECT_STATIC_MEDIA_PATTERN =
  /^\/images\/ourdream\/.+\.(?:avif|webp)$/i;

export function shouldBypassNextImageOptimizer(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  return (
    pathname.startsWith("/api/v1/media/") ||
    pathname.startsWith("/user-content/") ||
    DIRECT_STATIC_MEDIA_PATTERN.test(pathname)
  );
}
