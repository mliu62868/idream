import { afterAll } from "vitest";
import { closeOpenJobQueues } from "@/server/jobs/queue-lifecycle";

// A queue adapter keeps one Worker per queue open for its lifetime, and each test
// file has its own process. Close them rather than leave Redis sockets to the kill.
afterAll(closeOpenJobQueues);
