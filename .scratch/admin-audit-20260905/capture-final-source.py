import datetime
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path('/Users/kk/code/idream')
output = root / 'output/playwright/admin-e2e-20260905'
paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
files = []
for name in sorted(set(paths)):
    if not (name.startswith(('packages/', 'scripts/')) or name in ('package.json', 'bun.lock', 'turbo.json', 'tsconfig.json')):
        continue
    path = root / name
    if path.is_file():
        files.append({'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
digest = hashlib.sha256(''.join(f"{row['path']}\0{row['sha256']}\n" for row in files).encode()).hexdigest()
manifest = {
    'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
    'scope': 'git-visible packages, scripts and root build manifests; excludes docs/evidence and ignored runtime files',
    'sha256': digest, 'files': files,
}
(output / 'application-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
processes = json.loads(subprocess.check_output(['pm2', 'jlist'], cwd=root))
names = {'main-web', 'admin-web', 'chat', 'gen-image', 'gen-video', 'gen-finalizer', 'main-event-consumer', 'admin-command-worker'}
runtime = []
for process in processes:
    if process['name'] not in names:
        continue
    env = process['pm2_env']
    runtime.append({
        'name': process['name'], 'pid': process['pid'], 'status': env['status'],
        'restarts': env['restart_time'], 'startedAtMs': env['pm_uptime'],
        'sourceRevision': env.get('IDREAM_SOURCE_REVISION') or env.get('APP_SOURCE_REVISION'),
    })
(output / 'runtime-processes-final.json').write_text(json.dumps({'checkedAt': manifest['checkedAt'], 'processes': runtime}, indent=2) + '\n')
print(json.dumps({'files': len(files), 'applicationSha256': digest, 'processes': runtime}, indent=2))
