# GenerationContext

Main owns an authenticated, revocable source selector; the browser receives a deterministic HMAC token containing only selector IDs and a digest. Quotes and admission resolve the same context; admission locks its authority before media locks. Unknown request receipts are replayed before resolving a potentially withdrawn source.

- Chat selector: `{ kind: "chat", sessionId, turnId, attempt, mediaAssetId? }`. Preserve the completed Turn's content version, Release, visual identity, reference set, Scene and accepted image brief. A delivered source image must belong to that exact reply and account.
- Comic selector: `{ kind: "comic", comicId, comicVersion, pageId }`. Requires a currently published public/unlisted manifest, active author, every readable page and explicit `allowRemix`. The source is the selected page image plus author-published captions. Generation does not reveal or reuse the source author's private prompts or dialogue.
- Character identity for Comic: when the source image belongs to a currently public Character, freeze its approved source generation identity and corresponding published/superseded Release. Otherwise use source-only image editing. Neither path may access a private Character Soul. A stale token cannot silently change identity mode or versions.

The module is `server/modules/ourdream/generation-context.ts`; its public operations are `loadGenerationContext`, `signGenerationContext`, `resolveGenerationContext`, `lockGenerationContext`, `applyGenerationContext`, and `generationContextSource`. The HTTP read is `GET /api/v1/generation/context?kind=...`; new requests carry `generationContextToken`. Existing persisted `chatHandoffToken` requests and v1 HMAC tokens retain read support to preserve exact idempotency fingerprints.

The client context DTO contains `token`, discriminated `source`, `identityMode`, nullable `characterId`/`characterName`/`pins`, `scene`, `prompt`, `sourceMedia`, `returnHref`, and `sourceLabel`. Source metadata pins Comic version/page or Chat Turn/attempt alongside the digest. Product source types remain `comic_remix`, `chat_handoff`, and `chat_video`.

`applyGenerationContext(body, context, { allowVideo: true })` is available to the Chat video authority after validating its Chat selector. Public Generate accepts image contexts. Video only dispatches its source image while preserving Character identity pins as provenance.

Comic v2 tokens also include a signed `comicGrant: { mediaAssetId, allowRemix: true }`. The accepted Job persists that token and its source selector. Dispatch verifies the HMAC/user, Comic ID/version/page, digest and exact source image before passing a narrow grant to image reference loading. The grant only applies to `source_image`; Character identity references still require their normal authority. Accepted attempts can finish after withdrawal, while a new submission or paid retry revalidates the current publication.
