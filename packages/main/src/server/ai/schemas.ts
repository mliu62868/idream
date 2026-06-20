// Contracts SSoT now lives in @idream/shared. This module re-exports the chat/
// generation payload schemas so existing `@/server/ai/schemas` imports keep working
// after the physical split. Do not add new schemas here — add them in
// packages/shared/src/contracts and re-export.
export * from "@idream/shared/contracts";
