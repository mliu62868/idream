import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

type MainToChatBacklogDb = {
  mainOutboxEvent: {
    count(input: {
      where: {
        eventType: { in: string[] };
        status: "failed";
      };
    }): Promise<number>;
  };
};

export async function inspectMainToChatFailedBacklog(
  db: MainToChatBacklogDb,
) {
  const failed = await db.mainOutboxEvent.count({
    where: {
      eventType: { in: Object.values(MAIN_TO_CHAT_EVENTS) },
      status: "failed",
    },
  });
  return { ok: failed === 0, failed };
}
