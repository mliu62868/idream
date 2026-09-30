import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { withGenerationAcceleratorLease } from '../../packages/gen/src/backend/generation-accelerator-lease';

const root = path.dirname(import.meta.filename);
const native = path.join(root, 'h3.c');
const adapter = path.join(root, 'minimax_h3_fl2v_turbo_4step_v1.2_768p_bf16.safetensors');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const names: string[] = manifest.fixture_tensors;
const mode = process.argv[2];
if (!['baseline', 'adapter', 'convrot', 'convrot-native', 'conditioning', 'render4', 'render8'].includes(mode)) throw new Error('Unknown experiment mode');

await withGenerationAcceleratorLease('video', async () => {
  for (const port of [8188, 8189, 8190]) {
    const response = await fetch(`http://127.0.0.1:${port}/queue`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Runner ${port}: HTTP ${response.status}`);
    const queue = await response.json();
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error(`Runner ${port} is busy`);
  }
  console.log('Generation accelerator lease acquired; all three ComfyUI queues idle');
  async function run(label: string, args: string[], expectedExit = 0, cwd = native, extraEnv: Record<string, string> = {}) {
    await writeFile(path.join(root, `${label}.stdout.log`), '');
    await writeFile(path.join(root, `${label}.stderr.log`), '');
    const stdout = Bun.file(path.join(root, `${label}.stdout.log`));
    const stderr = Bun.file(path.join(root, `${label}.stderr.log`));
    const started = Date.now();
    const childEnv = { ...process.env, ...extraEnv };
    for (const key of Object.keys(childEnv)) if (key.startsWith('H3_ANE_')) delete childEnv[key];
    const child = Bun.spawn(['/usr/bin/time', '-l', ...args], { cwd, stdout, stderr, env: childEnv });
    const timer = setTimeout(() => child.kill('SIGTERM'), mode.startsWith('render') ? 600_000 : 300_000);
    const code = await child.exited;
    clearTimeout(timer);
    const record = { label, mode, command: args, exitCode: code, wallSeconds: (Date.now() - started) / 1000, acceleratorLease: true };
    await writeFile(path.join(root, `${label}.run.json`), JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify(record));
    console.log(await stdout.text());
    if (expectedExit === 0 ? code !== 0 : code === 0) throw new Error(`${label}: unexpected exit ${code}`);
  }
  if (mode === 'baseline') {
    await run('native-lora-tests', ['./h3_lora_tests']);
    const output = path.join(root, 'baseline');
    await mkdir(output, { recursive: true });
    await run('native-baseline', ['./h3_lora_check', path.join(root, 'fixture'), output, ...names]);
  } else if (mode === 'adapter') {
    const output = path.join(root, 'patched');
    await mkdir(output, { recursive: true });
    await run('native-real-adapter', ['./h3_lora_check', path.join(root, 'fixture'), output, '--lora', `${adapter}:1`, ...names]);
  } else if (mode === 'convrot-native') {
    await run(`native-nsfw-convrot-${process.env.H3_EXPERIMENT_STAGE ?? 'tests'}`, ['./h3_convrot_tests', path.join(root, 'convrot-source')], 0, path.join(root, 'h3.c-ane'));
  } else if (mode === 'conditioning') {
    for (const port of [8188, 8189, 8190]) {
      const response = await fetch(`http://127.0.0.1:${port}/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Failed to release idle runner ${port}`);
    }
    await run('nsfw-conditioning', ['/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/.venv/bin/python3', '-u', path.join(root, 'encode_conditioning.py')]);
  } else if (mode.startsWith('render')) {
    const steps = mode.slice('render'.length);
    const prompt = (await readFile(path.join(root, 'nsfw-prompt.txt'), 'utf8')).trim();
    await run(`nsfw-native-${steps}step`, ['./h3', '-d', path.join(root, 'nsfw-model'), '-p', prompt, '--width', '512', '--height', '512', '--frames', '22', '--steps', steps, '--layers', '50', '--reuse', '1', '--seed', '42', '--profile', '-o', path.join(root, `nsfw-native-${steps}step.mp4`)], 0, path.join(root, 'h3.c-ane'), { H3_CONDITIONING_FILE: path.join(root, 'conditioning.h3cd') });
  } else {
    const source = path.join(root, 'convrot-source');
    await mkdir(source, { recursive: true });
    const link = path.join(source, 'redcraft.safetensors');
    if (!(await Bun.file(link).exists())) await symlink(manifest.checkpoint, link);
    await run('native-convrot-rejection', ['./h3_lora_check', source, '-', 'blocks.0.attn.out_proj.weight'], 1);
    console.log(await Bun.file(path.join(root, 'native-convrot-rejection.stderr.log')).text());
  }
}, { waitTimeoutMs: 60_000 });
