-- Outbox rows whose event type no transport queue routes are domain records,
-- not deliveries. They used to stay 'pending' forever (~270 rows of
-- generation.request.cancelled.v2, creative.review.decided.v2, ...), which is
-- indistinguishable from a lost delivery. The event-consumer now settles them
-- to 'recorded' (see MAIN_OUTBOX_RECORDED_STATUS); this converges the backlog.
-- INVARIANT: this list is MAIN_OUTBOX_TRANSPORT_EVENT_TYPES at this revision.
UPDATE "main_outbox_events"
   SET "status" = 'recorded', "updatedAt" = now()
 WHERE "status" = 'pending'
   AND "eventType" NOT IN (
     'user.account_deletion.requested.v2',
     'chat.agent_run.cancel_requested.v1',
     'chat.companion_memory.rebuild_requested.v1',
     'chat.companion_memory.project_requested.v1',
     'chat.companion_memory.purge_requested.v1',
     'user.suspended',
     'user.deleted',
     'character.updated',
     'character.removed',
     'character.moderation_restoration.requested.v1',
     'character.visibility_changed',
     'entitlement.updated',
     'age_eligibility.updated',
     'policy.updated',
     'chat.image.accepted',
     'chat.image.completed',
     'chat.image.failed',
     'chat.session_release_migration.requested.v2',
     'product.event.persisted.v2',
     'generation.terminal_record.accepted.v1',
     'creative.retry.dispatch.v2',
     'creative.generation.dispatch.v2',
     'incident.retry.dispatch.v2',
     'generation.retry.dispatch.v2',
     'generation.incident.correlate.v2'
   );
