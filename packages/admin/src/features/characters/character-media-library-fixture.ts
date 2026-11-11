import type { CharacterMediaLibraryListResponse } from "@idream/shared/admin";

export function emptyCharacterMediaLibrary(): CharacterMediaLibraryListResponse {
  return {
    items: [],
    nextCursor: null,
    capabilities: { describe: false, search: false },
    visualIdentity: null,
    serving: null,
    coverage: { production: null, serving: null },
  };
}
