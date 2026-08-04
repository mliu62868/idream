export function feedCharacterId(itemId: string) {
  const decoded = decodedFeedItemId(itemId);
  return decoded?.startsWith("character:")
    ? decoded.slice("character:".length)
    : null;
}

export function feedCollectionId(itemId: string) {
  const decoded = decodedFeedItemId(itemId);
  return decoded?.startsWith("collection:")
    ? decoded.slice("collection:".length)
    : null;
}

function decodedFeedItemId(itemId: string) {
  try {
    return decodeURIComponent(itemId);
  } catch {
    return null;
  }
}
