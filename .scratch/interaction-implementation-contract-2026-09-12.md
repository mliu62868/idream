# Interaction implementation contract

## Proactive messages

`RecentChat.proactiveEnabled`, `proactiveIntervalHours` (6..168 hours), and `proactiveNextAt` are user opt-in controls. A scheduler must claim due rows using `FOR UPDATE SKIP LOCKED`, advance `proactiveNextAt` in the same transaction as creating a Main ChatTurn, and set `ChatTurn.origin=proactive`. The scheduler must never bypass the existing quota, moderation, memory, serving pin, or AgentRun admission paths. Failed admission does not create a second Turn or advance quota; the claimed due row is retried with bounded backoff. The generated prompt is an internal companion event and must be labeled in the UI as proactive.

## Voice Call

Voice Call is not implemented by the existing Voice Clip pipeline. It requires a durable call session (connecting/active/interrupted/ended), a bidirectional media transport, STT/TTS provider identity pins, interruption/reconnect handling, duration usage facts, and settlement. Browser speech recognition or a mock stream is not sufficient for release. No provider endpoint or persistence model currently exists in this checkout; do not claim this capability complete.

## Current fail-closed surface

`GET /api/v1/chat/sessions/:sessionId/voice-call` reports capability state. `POST` returns an unavailable error unless both `CHAT_VOICE_CALL_PROVIDER` and `CHAT_VOICE_CALL_TRANSPORT_URL` exist; no browser speech recognition or clip playback is presented as a call.
