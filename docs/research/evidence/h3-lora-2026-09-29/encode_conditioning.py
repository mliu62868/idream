"""Export existing GGUF H3 text conditioning; never loads the diffusion model."""

import importlib.util
import json
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COMFY = Path('/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI')
sys.path.insert(0, str(COMFY))
sys.argv = [sys.argv[0], '--cpu']
import comfy.options
comfy.options.enable_args_parsing()
import folder_paths
import torch

torch.set_num_threads(8)
folder_paths.add_model_folder_path('text_encoders', '/Users/kk/ComfyUI-Shared/models/text_encoders')
folder_paths.add_model_folder_path('clip', '/Users/kk/ComfyUI-Shared/models/text_encoders')
plugin_dir = COMFY / 'custom_nodes/ComfyUI-GGUF'
spec = importlib.util.spec_from_file_location('h3_experiment_gguf', plugin_dir / '__init__.py', submodule_search_locations=[str(plugin_dir)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)

prompt = (ROOT / 'nsfw-prompt.txt').read_text().strip()
started = time.perf_counter()
print('Encoding controlled non-explicit prompt with existing H3 GGUF encoder on CPU', flush=True)
clip = plugin.NODE_CLASS_MAPPINGS['CLIPLoaderGGUF']().load_clip('qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf', type='minimax')[0]
with torch.inference_mode():
    tokens = clip.tokenize(prompt)
    conditioning = clip.encode_from_tokens_scheduled(tokens)
    hidden = conditioning[0][0].detach().cpu().to(torch.bfloat16).contiguous()
assert hidden.ndim == 3 and hidden.shape[0] == 1 and hidden.shape[2] == 5120, hidden.shape
assert torch.isfinite(hidden).all(), 'conditioning contains non-finite values'
values = hidden[0].view(torch.uint16).numpy()
output = ROOT / 'conditioning.h3cd'
with output.open('wb') as handle:
    handle.write(struct.pack('<IIQQII', 0x44434833, 1, hidden.shape[1], 5120, 0, 0))
    handle.write(values.tobytes())
report = {'encoder': '/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl-32B-MiniMax-H3-Q4_K_M.gguf', 'conditioning': str(output), 'shape': list(hidden.shape), 'bytes': output.stat().st_size, 'wall_seconds': time.perf_counter() - started, 'device': 'cpu', 'prompt': prompt, 'scope': 'GGUF conditioning for native T2V smoke; no BF16 encoder parity claim'}
(ROOT / 'conditioning.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2), flush=True)
