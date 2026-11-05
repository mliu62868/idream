// SPEC: which job queue adapters currently hold Redis connections open.
// INTENT: lets test teardown close them without importing queue.ts, which reads env
// at load and would then load before the env stubs and vi.mock calls of each test.
type ClosableJobQueue = { close(): Promise<void> };

const open = new Set<ClosableJobQueue>();

export function trackOpenJobQueue(queue: ClosableJobQueue) {
  open.add(queue);
}

export function untrackOpenJobQueue(queue: ClosableJobQueue) {
  open.delete(queue);
}

export async function closeOpenJobQueues() {
  await Promise.allSettled([...open].map((queue) => queue.close()));
}
