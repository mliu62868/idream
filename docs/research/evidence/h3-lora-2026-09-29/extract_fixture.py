"""Extract real BF16 tensors read-only; restore native H3 QKV row layout."""

import hashlib
import json
import struct
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
SOURCE = Path('/Users/kk/ComfyUI-Shared/models/diffusion_models/REDMix-MiniMaxH3-A2Ab1-pruned-int8-convrot-ComfyMCP.safetensors')
NAMES = [
    'token_refiner.blocks.0.attn.qkv_proj.weight',
    'token_refiner.blocks.0.attn.out_proj.weight',
    'token_refiner.blocks.0.mlp.fc1.weight',
    'token_refiner.blocks.0.mlp.fc2.weight',
    'token_refiner.blocks.0.norm1.weight',
]

before = SOURCE.stat()
with SOURCE.open('rb') as handle:
    header_length = struct.unpack('<Q', handle.read(8))[0]
    header = json.loads(handle.read(header_length))
    (ROOT / 'checkpoint-header.json').write_text(json.dumps(header, indent=2))
    target_header = {'__metadata__': {'source': str(SOURCE), 'scope': 'five real tensors, not a complete model', 'qkv_layout': 'native interleaved per head'}}
    offset = 0
    for name in NAMES:
        item = header[name]
        assert item['dtype'] == 'BF16', item
        length = item['data_offsets'][1] - item['data_offsets'][0]
        target_header[name] = {'dtype': item['dtype'], 'shape': item['shape'], 'data_offsets': [offset, offset + length]}
        offset += length
    output = ROOT / 'fixture' / 'selected-native-tensors.safetensors'
    output.parent.mkdir(exist_ok=True)
    encoded = json.dumps(target_header, separators=(',', ':')).encode()
    encoded += b' ' * ((-len(encoded)) % 8)
    with output.open('wb') as destination:
        destination.write(struct.pack('<Q', len(encoded)))
        destination.write(encoded)
        for name in NAMES:
            item = header[name]
            handle.seek(8 + header_length + item['data_offsets'][0])
            data = handle.read(item['data_offsets'][1] - item['data_offsets'][0])
            if '.qkv_proj.' in name:
                grouped = np.frombuffer(data, dtype='<u2').reshape(3, 56, 128, 5376)
                data = grouped.transpose(1, 0, 2, 3).copy().tobytes()
            destination.write(data)
            print('extracted', name, item['shape'], flush=True)

sha = hashlib.sha256()
with SOURCE.open('rb') as handle:
    for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b''):
        sha.update(chunk)
after = SOURCE.stat()
assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
manifest = {
    'checkpoint': str(SOURCE),
    'checkpoint_bytes': before.st_size,
    'checkpoint_sha256': sha.hexdigest(),
    'checkpoint_mtime_ns': before.st_mtime_ns,
    'fixture': str(output),
    'fixture_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    'fixture_tensors': NAMES,
    'idream_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'native_commit': subprocess.check_output(['git', '-C', str(ROOT / 'h3.c'), 'rev-parse', 'HEAD'], text=True).strip(),
    'hf_revision': '3ec17a324ced54151364f24f8b5fb6bf7e26414f',
    'scope': 'real adapter parsing and selected-tensor Metal patch; no video generation',
}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2), flush=True)
