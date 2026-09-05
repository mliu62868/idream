// Controlled runtime recovery: no /prompt POST, no new Generation Attempt.
// Default is read-only. Root owns the --apply execution and chooses the real admin actor.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generationTerminalRecordSchema, generationTerminalRecordChecksum } from '../../packages/shared/src/contracts';
import { assertGeneratedImageSanity } from '../../packages/shared/src/media/generated-image-sanity';
import { ComfyUIBackend } from '../../packages/gen/src/backend/comfyui';
import { prisma } from '../../packages/main/src/server/lib/db';
import { ingestGenerationTerminalRecord } from '../../packages/main/src/server/ai/generation-terminal-record-ingest';
import { reconcileUnknownGenerationRequest } from '../../packages/main/src/server/modules/admin-v2/jobs/unknown-reconciliation';
import { effectivePermissions } from '../../packages/main/src/server/admin/effective-permissions';

const jobId = 'cmto7159c000ov3l70eyvcpnk';
const attemptId = 'cmto7159u000rv3l78jtcw3vz';
const promptId = '41003306-72b3-486e-984e-1d751788ebdd';
const blobRoot = '/Users/kk/code/idream/data/blob';
const originalRef = `gen/terminal-records/${attemptId}/terminal.json`;
const originalChecksum = 'eeeb062a6170d4670159be1cdefd7f1876b276c107a46c25379e585c440ed63f';
const resolutionRef = `gen/terminal-records/${attemptId}/resolution-comfyui-success.json`;
const commandKey = `chrome-iris-recover-${attemptId}`;
const historyUrl = `http://127.0.0.1:8189/history/${promptId}`;
const apply = process.argv.includes('--apply');
const actorId = process.argv.find((arg) => arg.startsWith('--actor='))?.slice(8);
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

async function immutableWrite(key: string, body: Uint8Array) {
  const target = path.join(blobRoot, key);
  if (!target.startsWith(`${blobRoot}/gen/`)) throw Error('Blob scope mismatch');
  await mkdir(path.dirname(target), { recursive: true });
  try { await writeFile(target, body, { flag: 'wx' }); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    if (digest(await readFile(target)) !== digest(body)) throw Error(`Immutable evidence conflict: ${key}`);
  }
}

try {
  const target = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/idream_runtime_20260812') throw Error('Unexpected runtime DB');
  const original = generationTerminalRecordSchema.parse(JSON.parse(await readFile(path.join(blobRoot, originalRef), 'utf8')));
  if (original.outcome !== 'unknown' || generationTerminalRecordChecksum(original) !== originalChecksum || original.attemptId !== attemptId || original.generationJobId !== jobId || original.providerRequestId !== promptId || original.provider !== 'comfyui') throw Error('Original terminal authority mismatch');
  const [job, attempt, attempts, transport] = await Promise.all([
    prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } }),
    prisma.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } }),
    prisma.generationAttempt.count({ where: { requestId: jobId } }),
    prisma.generationTransportExecution.findUniqueOrThrow({ where: { attemptId_transportAttemptNo: { attemptId, transportAttemptNo: 1 } } }),
  ]);
  if (attempts !== 1 || attempt.status !== 'unknown' || attempt.terminalRecordRef !== originalRef || transport.status !== 'unknown' || transport.providerRequestId !== promptId) throw Error('Attempt state changed; inspect before recovery');
  if (!['queued', 'completed'].includes(job.status) || (job.status === 'queued' && job.version !== 1)) throw Error('Unexpected Request version/status');
  const response = await fetch(historyUrl);
  if (!response.ok) throw Error(`Comfy history HTTP ${response.status}`);
  const history = (await response.json())[promptId];
  if (!history?.status?.completed || history.status.status_str !== 'success') throw Error('Provider success is not confirmed');
  const messages = history.status.messages as [string, { timestamp: number }][];
  const started = messages.find(([kind]) => kind === 'execution_start')?.[1].timestamp;
  const completed = messages.find(([kind]) => kind === 'execution_success')?.[1].timestamp;
  if (!started || !completed || completed <= started) throw Error('Provider timing evidence missing');
  // poll performs GET history/view and the canonical image sanity check. Never call submit.
  const output = await new ComfyUIBackend({ apiUrl: 'http://127.0.0.1:8189' }).poll({ id: promptId });
  if (output.assets.length !== 1) throw Error('Expected exactly one original output');
  const image = output.assets[0]!;
  if (image.contentType !== 'image/png' || image.width !== 832 || image.height !== 1024) throw Error('Recovered image shape mismatch');
  const sanity = assertGeneratedImageSanity(Buffer.from(image.body), `${jobId} recovered output`, { singleContinuousFrame: true });
  const assetKey = `gen/${jobId}/attempts/${attemptId}/image-1.png`;
  const record = generationTerminalRecordSchema.parse({
    ...original, outcome: 'succeeded', completedAt: new Date(completed).toISOString(),
    // Original timeout accounting remains immutable in its original record/transport.
    // Provider history measures successful execution; cost remains unknown.
    accounting: { usage: original.usage, latencyMs: completed - started, costMicros: null, pricingVersion: null },
    assets: [{ ordinal: 0, key: assetKey, contentType: image.contentType, width: image.width, height: image.height, providerKey: null,
      quality: { schemaVersion: '1', evaluatorVersion: sanity.evaluatorVersion,
        artifact: { status: 'unscored', reason: 'artifact_evaluator_unavailable' },
        faceCount: { status: 'unscored', reason: 'evaluator_unavailable' },
        identity: { status: 'unscored', reason: 'evaluator_unavailable' },
        intent: { status: 'unscored', reason: 'evaluator_unavailable' },
        sanity: sanity.sanity, composition: sanity.composition } }],
  });
  const ingest = { terminalRecordRef: resolutionRef, terminalRecordChecksum: generationTerminalRecordChecksum(record), terminalRecord: record };
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'read-only', jobId, attemptId, promptId, jobStatus: job.status, version: job.version, providerExecutionMs: completed - started, originalChecksum, resolutionRef, resolutionChecksum: ingest.terminalRecordChecksum, assetKey, assetSha256: digest(image.body), image: { width: image.width, height: image.height }, sanity }, null, 2));
  if (apply) {
    if (!actorId) throw Error('--actor=<real admin id> is required');
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { id: true, role: true, status: true } });
    if (actor.role !== 'admin' || actor.status !== 'active' || !(await effectivePermissions(actor.id, 'admin')).has('generation.job.requeue')) throw Error('Actor lacks effective recovery authority');
    await immutableWrite(assetKey, image.body);
    await immutableWrite(resolutionRef, new TextEncoder().encode(JSON.stringify(record)));
    const ack = await ingestGenerationTerminalRecord(ingest);
    if (!ack.acknowledged) throw Error(`Resolution rejected: ${JSON.stringify(ack)}`);
    const result = await reconcileUnknownGenerationRequest({ requestId: jobId,
      actor: { id: actor.id, role: actor.role }, idempotencyKey: commandKey, traceId: commandKey,
      command: { resolution: 'adopt_succeeded', entityVersion: 1,
        reason: 'Recover existing ComfyUI success after 300s polling timeout; provider history proves completion at 331.959s. No new provider invocation.',
        providerEvidenceRefs: [historyUrl, originalRef, resolutionRef], confirmation: `${jobId}:adopt_succeeded` },
    });
    console.log(JSON.stringify({ acknowledgment: ack, result }, null, 2));
    if (generationTerminalRecordChecksum(generationTerminalRecordSchema.parse(JSON.parse(await readFile(path.join(blobRoot, originalRef), 'utf8')))) !== originalChecksum) throw Error('Original evidence changed');
    console.log(JSON.stringify({ attemptsAfter: await prisma.generationAttempt.count({ where: { requestId: jobId } }), deliveriesAfter: await prisma.generationDelivery.findMany({ where: { requestId: jobId }, select: { status: true, artifactId: true } }) }, null, 2));
  }
} finally { await prisma.$disconnect(); }
