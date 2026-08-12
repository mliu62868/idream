import {
  mainToChatOutboxReplayResultSchema,
  type MainToChatOutboxReplayRequest,
} from "@idream/shared/admin";
import { replayFailedMainToChatOutboxEvents } from "@/server/modules/admin-v2/chat/main-outbox-events";
import { prepareMainToChatReplayAuthority } from "@/server/modules/admin-v2/chat/main-outbox-events";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation<
      MainToChatOutboxReplayRequest,
      Awaited<ReturnType<typeof prepareMainToChatReplayAuthority>>
    >(
      "POST /api/v2/admin/chat/main-outbox-events/commands/replay",
      request,
      {
        params: {},
        permission: "chat.ops.read",
        target: ({ body }) => ({
          type: "main_to_chat_outbox_batch",
          id: canonicalSha256(body.events.map(({ id }) => id)),
        }),
        prepare: ({ body }) => prepareMainToChatReplayAuthority(body),
        mutate: (tx, context, receiverAuthority) =>
          replayFailedMainToChatOutboxEvents(
            {
              body: context.body,
              actor: context.actor,
              requestId: context.requestId,
              receiverAuthority,
            },
            tx,
          ),
        decorateResult: (stored, replayed) =>
          mainToChatOutboxReplayResultSchema.parse({
            ...(stored as Record<string, unknown>),
            replayed,
          }),
      },
    ),
  );
}
