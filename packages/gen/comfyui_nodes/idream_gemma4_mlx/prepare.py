"""Download and bundle the pinned LTX-specific community Q4, without requantizing."""
from __future__ import annotations

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SOURCE = 'vanch007/LTX-2.5-mlx'
REVISION = '53e9fcb9f338119ac9854c8fe29b357cf1f74b26'
PREFIX = 'gemma4-q4/'


def prepare(destination: Path, cache: Path):
    import torch
    from huggingface_hub import HfApi, hf_hub_download
    import httpx
    from safetensors import safe_open
    from safetensors.torch import save_file

    if destination.exists():
        raise FileExistsError(f'Refusing to replace an existing checkpoint: {destination}')
    info = HfApi().model_info(SOURCE, revision=REVISION, files_metadata=True)
    files = [file for file in info.siblings if file.rfilename.startswith(PREFIX) and
             (file.rfilename.endswith('.safetensors') or file.rfilename in
              [PREFIX+'config.json', PREFIX+'tokenizer.json'])]
    def fetch(entry):
        # The observed transport closes large responses mid-body. Hub resumes
        # its partial file; retry transport failures and verify the complete hash.
        for attempt in range(32):
            try:
                return Path(hf_hub_download(SOURCE, entry.rfilename, revision=REVISION, local_dir=cache))
            except (httpx.RemoteProtocolError, httpx.ReadTimeout):
                if attempt == 31:
                    raise
                print(f'resuming {entry.rfilename} after transport failure', flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(fetch, files))
    weights = {}
    manifest = []
    config = None
    for entry, path in zip(files,paths):
        with path.open('rb') as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        expected = entry.lfs.sha256 if entry.lfs is not None else None
        if expected and digest != expected:
            raise ValueError(f'Source checksum mismatch: {entry.rfilename}')
        manifest.append({'path': entry.rfilename, 'sha256': digest, 'bytes': path.stat().st_size})
        if path.name == 'config.json':
            config = json.loads(path.read_text())
        elif path.name == 'tokenizer.json':
            weights['tokenizer_json'] = torch.tensor(bytearray(path.read_bytes()), dtype=torch.uint8)
        else:
            with safe_open(path, framework='pt', device='cpu') as handle:
                for key in handle.keys():
                    if key.startswith(('language_model.model.layers.', 'text_embedding_projection.')) or key in (
                        'language_model.model.embed_tokens.weight', 'language_model.model.norm.weight',
                    ):
                        if key in weights:
                            raise ValueError(f'Duplicate source tensor: {key}')
                        weights[key] = handle.get_tensor(key)
        print(f'verified {entry.rfilename}', flush=True)
    if config is None or config.get('model_type') != 'gemma4_unified':
        raise ValueError('Expected the LTX Gemma4 unified config')
    if weights['language_model.model.embed_tokens.weight'].dtype != torch.bfloat16:
        raise ValueError('The community recipe must preserve BF16 token embeddings')
    for kind, dimension in [('video',4096),('audio',2048)]:
        weight = weights[f'text_embedding_projection.{kind}_aggregate_embed.weight']
        if weight.dtype != torch.bfloat16 or tuple(weight.shape) != (dimension,188160):
            raise ValueError(f'Unexpected {kind} projection')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.partial')
    save_file(weights, str(temporary), metadata={
        'idream_format': 'ltx25_gemma4_mlx_affine_v1',
        'gemma_config': json.dumps(config),
        'source_repository': SOURCE,
        'source_revision': REVISION,
        'source_files': json.dumps(manifest),
        'quantization': json.dumps({'bits':4,'group_size':64,'mode':'affine'}),
    })
    with temporary.open('rb') as handle:
        digest = hashlib.file_digest(handle,'sha256').hexdigest()
    temporary.rename(destination)
    report = {'source':SOURCE,'revision':REVISION,'destination':str(destination),'sha256':digest,'bytes':destination.stat().st_size,'tensors':len(weights),'files':manifest}
    destination.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:value for key,value in report.items() if key != 'files'}),flush=True)


def prepare_comfy_q8(source: Path, destination: Path):
    """Restore official ConvRot effective weights, then encode MLX affine Q8.

    This adds one Q8 rounding step; it does not recover the BF16 training model.
    """
    import mlx.core as mx
    import numpy as np
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file
    from comfy_kitchen.backends.eager.quantization import dequantize_int8_convrot_weight, dequantize_int8_simple

    if destination.exists():
        raise FileExistsError(f'Refusing to replace an existing checkpoint: {destination}')
    with source.open('rb') as handle:
        source_digest = hashlib.file_digest(handle,'sha256').hexdigest()
    expected = '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f'
    if source_digest != expected:
        raise ValueError('Expected the currently pinned official INT8 Gemma checkpoint')
    torch.set_num_threads(4)
    weights = {}
    converted = 0
    with safe_open(source,framework='pt',device='cpu') as handle, mx.stream(mx.cpu):
        config = json.loads(handle.metadata()['gemma_config'])
        keys = set(handle.keys())
        for key in sorted(keys):
            if key.startswith('text_embedding_projection.') or key == 'tokenizer_json':
                weights[key] = handle.get_tensor(key)
                continue
            if not (key.startswith('model.layers.') or key in ['model.embed_tokens.weight','model.norm.weight']):
                continue
            if key.endswith(('.comfy_quant','.weight_scale')):
                continue
            tensor = handle.get_tensor(key)
            mapped = 'language_model.model.'+key.removeprefix('model.')
            marker = key.removesuffix('.weight')+'.comfy_quant'
            if key.endswith('.weight') and marker in keys:
                descriptor = json.loads(bytes(handle.get_tensor(marker).tolist()))
                if descriptor['format'] != 'int8_tensorwise':
                    raise ValueError(f'Unsupported official quantization: {key}')
                scale = handle.get_tensor(key.removesuffix('.weight')+'.weight_scale')
                tensor = (dequantize_int8_convrot_weight(tensor,scale,descriptor['convrot_groupsize']) if descriptor.get('convrot') else dequantize_int8_simple(tensor,scale)).to(torch.bfloat16)
                value = mx.array(tensor.float().numpy(),dtype=mx.bfloat16)
                packed,scales,biases = mx.quantize(value,group_size=64,bits=8,mode='affine')
                mx.eval(packed,scales,biases)
                prefix = mapped.removesuffix('.weight')
                weights[mapped] = torch.from_numpy(np.array(packed,copy=True))
                for suffix,array in [('scales',scales),('biases',biases)]:
                    weights[prefix+'.'+suffix] = torch.from_numpy(np.array(array.view(mx.uint16),copy=True)).view(torch.bfloat16)
                converted += 1
                if converted % 20 == 0:
                    print(f'converted {converted}/328 official INT8 matrices to MLX Q8',flush=True)
            else:
                weights[mapped] = tensor
    if converted != 328:
        raise ValueError(f'Expected 328 quantized Gemma matrices; got {converted}')
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary = destination.with_suffix('.partial')
    save_file(weights,str(temporary),metadata={
        'idream_format':'ltx25_gemma4_mlx_affine_v1',
        'gemma_config':json.dumps(config),
        'quantization':json.dumps({'bits':8,'group_size':64,'mode':'affine'}),
        'source_checkpoint_sha256':source_digest,
        'source_checkpoint':source.name,
        'conversion':'CPU inverse ConvRot to BF16 effective weights, then MLX affine Q8/group64; additional rounding',
    })
    with temporary.open('rb') as handle:
        digest = hashlib.file_digest(handle,'sha256').hexdigest()
    temporary.rename(destination)
    report = {'source':str(source),'source_sha256':source_digest,'destination':str(destination),'sha256':digest,'bytes':destination.stat().st_size,'tensors':len(weights),'converted':converted}
    destination.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--source-comfy-int8', type=Path)
    args = parser.parse_args()
    if args.source_comfy_int8:
        prepare_comfy_q8(args.source_comfy_int8,args.destination)
    elif args.cache:
        prepare(args.destination, args.cache)
    else:
        parser.error('The community Q4 download requires --cache; the Q8 conversion requires --source-comfy-int8')
