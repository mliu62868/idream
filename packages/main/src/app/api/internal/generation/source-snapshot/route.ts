import { env } from "@/server/lib/env";
import { generationSnapshotReaderIsClosed, readGenerationSourceSnapshot } from "@/server/modules/generation/source-snapshot-read";

export async function GET(request: Request): Promise<Response> {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) return new Response(null, { status: 401 });
  const query = new URL(request.url).searchParams;
  const snapshotId = query.get("snapshotId"), jobId = query.get("jobId"), attemptId = query.get("attemptId");
  if (!snapshotId || !jobId || !attemptId || snapshotId.length > 160 || jobId.length > 160 || attemptId.length > 160) return new Response(null, { status: 400 });
  const snapshot = await readGenerationSourceSnapshot({ snapshotId, jobId, attemptId });
  if (!snapshot) {
    // 410 tells Gen to stop for good; 404 stays retryable because it can also mean
    // a transient read problem that a Bull retry may outlast.
    return new Response(null, { status: await generationSnapshotReaderIsClosed({ jobId, attemptId }) ? 410 : 404 });
  }
  return new Response(snapshot.body, { headers: { "content-type": snapshot.contentType, "content-length": String(snapshot.sizeBytes), "cache-control": "no-store" } });
}
