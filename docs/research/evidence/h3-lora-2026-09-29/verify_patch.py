"""Independent float64 LoRA oracle on sampled rows of real checkpoint tensors."""

import hashlib
import json
import re
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
ADAPTER = ROOT / 'minimax_h3_fl2v_turbo_4step_v1.2_768p_bf16.safetensors'
EXPECTED_SHA = 'c3d4a2cf618efea71b9e21a4baaa12d412f1eb6c2b6f86efacaf0ebb6814b689'
assert ADAPTER.stat().st_size == 1383677808
sha = hashlib.sha256()
with ADAPTER.open('rb') as handle:
    for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b''):
        sha.update(chunk)
assert sha.hexdigest() == EXPECTED_SHA, sha.hexdigest()


class TensorFile:
    def __init__(self, file):
        self.path = Path(file)
        with self.path.open('rb') as handle:
            length = struct.unpack('<Q', handle.read(8))[0]
            self.header = json.loads(handle.read(length))
        self.start = 8 + length

    def raw(self, name):
        info = self.header[name]
        assert info['dtype'] == 'BF16'
        return np.memmap(self.path, mode='r', dtype='<u2', offset=self.start + info['data_offsets'][0], shape=tuple(info['shape']))

    def floats(self, name):
        return bf16_to_float(self.raw(name))


def bf16_to_float(bits):
    return (np.asarray(bits).astype(np.uint32) << 16).view(np.float32)


def round_bf16(values):
    bits = np.asarray(values, dtype=np.float32).view(np.uint32)
    return ((bits + np.uint32(0x7fff) + ((bits >> 16) & 1)) >> 16).astype(np.uint16)


manifest = json.loads((ROOT / 'manifest.json').read_text())
checkpoint = json.loads((ROOT / 'checkpoint-header.json').read_text())
adapter = TensorFile(ADAPTER)
fixture = TensorFile(manifest['fixture'])
mapping = {
    'attn.to_q': 'attn.qkv_proj',
    'attn.to_k': 'attn.qkv_proj',
    'attn.to_v': 'attn.qkv_proj',
    'attn.to_out.0': 'attn.out_proj',
    'ff.net.0.proj': 'mlp.fc1',
    'ff.net.2': 'mlp.fc2',
}
mapped_targets = set()
modules = 0
for name, info in adapter.header.items():
    if '.lora_A.default.weight' not in name:
        continue
    match = re.fullmatch(r'(transformer_blocks|token_refiner.refiner_blocks)\.(\d+)\.(.+)\.lora_A.default.weight', name)
    assert match, name
    prefix = 'blocks' if match[1] == 'transformer_blocks' else 'token_refiner.blocks'
    target = f'{prefix}.{match[2]}.{mapping[match[3]]}.weight'
    base = checkpoint[target]
    up = adapter.header[name.replace('.lora_A.', '.lora_B.')]
    divisor = 3 if match[3] in ('attn.to_q', 'attn.to_k', 'attn.to_v') else 1
    assert [base['shape'][0] // divisor, base['shape'][1]] == [up['shape'][0], info['shape'][1]], target
    assert info['shape'][0] == up['shape'][1] == 128
    mapped_targets.add(target)
    modules += 1

results = []
rng = np.random.default_rng(20260929)
for name in manifest['fixture_tensors']:
    info = fixture.header[name]
    raw = fixture.raw(name)
    baseline = np.memmap(ROOT / 'baseline' / (name + '.bin'), dtype='<u2', mode='r', shape=tuple(info['shape']))
    patched = np.memmap(ROOT / 'patched' / (name + '.bin'), dtype='<u2', mode='r', shape=tuple(info['shape']))
    assert np.array_equal(raw, baseline), f'baseline did not preserve {name}'
    if '.norm1.' in name:
        assert np.array_equal(baseline, patched), 'unadapted tensor changed'
        results.append({'tensor': name, 'unadapted_identical': True})
        continue
    out_rows, columns = info['shape']
    rows = sorted(set([0, 1, 127, 128, out_rows // 2 - 1, out_rows // 2, out_rows - 1] + list(rng.integers(0, out_rows, 64))))
    original = bf16_to_float(baseline[rows]).astype(np.float64)
    delta = np.empty(original.shape, dtype=np.float64)
    prefix = 'token_refiner.refiner_blocks.0.'

    def product(module, selected):
        down = adapter.floats(prefix + module + '.lora_A.default.weight').astype(np.float64)
        up = adapter.floats(prefix + module + '.lora_B.default.weight')[selected].astype(np.float64)
        return up @ down * (float(adapter.header['__metadata__']['alpha']) / down.shape[0])

    if '.qkv_proj.' in name:
        # Native rows are interleaved by head; the adapter has separate Q/K/V.
        for kind, module in enumerate(('attn.to_q', 'attn.to_k', 'attn.to_v')):
            selected_positions = [i for i, row in enumerate(rows) if row % 384 // 128 == kind]
            selected_rows = [rows[i] // 384 * 128 + rows[i] % 128 for i in selected_positions]
            delta[selected_positions] = product(module, selected_rows)
    elif '.mlp.fc1.' in name:
        # Native [gate; value], diffusers [value; gate].
        delta[:] = product('ff.net.0.proj', [(row + out_rows // 2) % out_rows for row in rows])
    elif '.mlp.fc2.' in name:
        delta[:] = product('ff.net.2', rows)
    elif '.out_proj.' in name:
        delta[:] = product('attn.to_out.0', rows)
    else:
        raise AssertionError(name)
    expected_bits = round_bf16(original + delta)
    actual_bits = np.asarray(patched[rows])
    actual = bf16_to_float(actual_bits)
    expected = bf16_to_float(expected_bits)
    assert np.isfinite(actual).all()
    bit_distance = np.abs(actual_bits.astype(np.int32) - expected_bits.astype(np.int32))
    # Allow one BF16 ULP for FP32 GPU vs float64 CPU reduction at rounding ties.
    assert bit_distance.max() <= 1, (name, int(bit_distance.max()))
    changed = float(np.mean(actual_bits != baseline[rows]))
    assert changed > 0.01, f'LoRA was a no-op on {name}'
    item = {'tensor': name, 'shape': info['shape'], 'sampled_rows': len(rows), 'max_bf16_ulp': int(bit_distance.max()), 'exact_oracle_fraction': float(np.mean(bit_distance == 0)), 'sampled_changed_fraction': changed, 'delta_rms': float(np.sqrt(np.mean(delta ** 2))), 'max_abs_error_to_rounded_oracle': float(np.max(np.abs(actual - expected)))}
    results.append(item)
    print(json.dumps(item), flush=True)

source = Path(manifest['checkpoint']).stat()
assert source.st_size == manifest['checkpoint_bytes'] and source.st_mtime_ns == manifest['checkpoint_mtime_ns']
assert hashlib.sha256(Path(manifest['fixture']).read_bytes()).hexdigest() == manifest['fixture_sha256']
native_stdout = (ROOT / 'native-real-adapter.stdout.log').read_text()
assert 'low_rank=312' in native_stdout and 'targets=208' in native_stdout and 'applied=4' in native_stdout
assert 'dtype/rank I8/2' in (ROOT / 'native-convrot-rejection.stderr.log').read_text()
report = {'adapter_bytes': ADAPTER.stat().st_size, 'adapter_sha256': sha.hexdigest(), 'adapter_alpha': 8, 'adapter_rank': 128, 'requested_strength': 1, 'effective_scale': 0.0625, 'parsed_modules': modules, 'shape_matched_checkpoint_targets': len(mapped_targets), 'native_supported_bf16_targets': sum(checkpoint[t]['dtype'] == 'BF16' for t in mapped_targets), 'native_unsupported_int8_targets': sum(checkpoint[t]['dtype'] == 'I8' for t in mapped_targets), 'native_adapter_output': native_stdout.strip(), 'results': results, 'checkpoint_stat_unchanged': True, 'fixture_sha256_unchanged': True, 'full_video_generation_tested': False}
(ROOT / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
print('PASS: real adapter mapped; nonzero native Metal patches match independent float64 oracle within one BF16 ULP; source unchanged.')
