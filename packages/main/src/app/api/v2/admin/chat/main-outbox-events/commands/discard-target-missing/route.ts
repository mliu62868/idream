import {
  mainToChatOutboxTargetMissingDispositionResultSchema,
  type MainToChatOutboxTargetMissingDispositionRequest,
} from "@idream/shared/admin";
import { discardTargetMissingMainToChatOutboxEvents } from "@/server/modules/admin-v2/chat/main-outbox-events";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation<MainToChatOutboxTargetMissingDispositionRequest>(
      "POST /api/v2/admin/chat/main-outbox-events/commands/discard-target-missing",
      request,
      {
        params: {},
        permission: "chat.ops.read",
        target: ({ body }) => ({
          type: "main_to_chat_outbox_batch",
          id: canonicalSha256(body.events.map(({ id }) => id)),
        }),
        mutate: (tx, context) =>
          discardTargetMissingMainToChatOutboxEvents(
            {
              body: context.body,
              actor: context.actor,
              requestId: context.requestId,
            },
            tx,
          ),
        decorateResult: (stored, replayed) =>
          mainToChatOutboxTargetMissingDispositionResultSchema.parse({
            ...(stored as Record<string, unknown>),
            replayed,
          }),
      },
    ),
  );
}
