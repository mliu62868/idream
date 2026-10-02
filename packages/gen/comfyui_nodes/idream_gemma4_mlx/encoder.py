"""LTX conditioning from pinned Gemma4 weights in MLX affine format."""
from __future__ import annotations

import gc
import json
import math
import traceback
from pathlib import Path


def collect_states(inner, token_ids, *, check_cancelled=lambda: None):
    import mlx.core as mx
    from mlx_lm.models.base import create_causal_mask

    ids = mx.array(token_ids, dtype=mx.int32)
    mask = ids != 0
    real_tokens = int(mask.sum().item())
    if ids.ndim != 2 or ids.shape[0] != 1 or real_tokens < 1:
        raise ValueError('Expected one non-empty, left-padded Gemma text sequence')
    if not bool(mx.all(mask[:, -real_tokens:]).item()):
        raise ValueError('Gemma padding must be a contiguous left prefix')
    # SPEC: Comfy encodes in FP32, including scaled BF16 token embeddings.
    hidden = inner.embed_tokens(ids).astype(mx.float32) * inner.embed_scale
    states = [hidden[:, -real_tokens:]]
    left_padding = mx.array([ids.shape[1]-real_tokens])
    masks = {
        'full_attention': create_causal_mask(ids.shape[1], left_padding=left_padding),
        'sliding_attention': create_causal_mask(ids.shape[1], window_size=inner.window_size, left_padding=left_padding),
    }
    intermediates = [(None, None)] * len(inner.layers)
    for index, layer in enumerate(inner.layers):
        check_cancelled()
        shared_kv, offset = intermediates[inner.previous_kvs[index]]
        hidden, shared_kv, offset = layer(hidden, mask=masks[layer.layer_type], shared_kv=shared_kv, offset=offset)
        mx.eval(hidden)
        states.append(hidden[:, -real_tokens:])
        intermediates[index] = (shared_kv, offset)
    # INVARIANT: Comfy's final all-layer state is post-norm. The preceding
    # states (including the scaled embedding) remain pre-final-norm.
    states[-1] = inner.norm(states[-1])
    return states


def project_states(states, projections):
    import mlx.core as mx

    # SPEC: flatten hidden-major/layer-minor, matching Comfy DualLinearProjection.
    values = mx.stack(states, axis=-1).astype(mx.float32)
    hidden_size = values.shape[2]
    values = values * mx.rsqrt(mx.mean(values**2, axis=2, keepdims=True)+1e-6)
    values = values.reshape(values.shape[0], values.shape[1], -1)
    outputs = []
    for kind in ('video', 'audio'):
        weight = projections[f'text_embedding_projection.{kind}_aggregate_embed.weight']
        bias = projections[f'text_embedding_projection.{kind}_aggregate_embed.bias']
        output = (values * math.sqrt(weight.shape[0]/hidden_size)) @ weight.T + bias
        mx.eval(output)
        outputs.append(output)
    return mx.concatenate(outputs, axis=-1)


class Gemma4MLXCLIP:
    def __init__(self, path: str | Path):
        import mlx.core as mx
        import mlx.nn as nn
        import torch
        from safetensors import safe_open
        from mlx_lm.models.gemma4 import Model, ModelArgs
        from comfy.text_encoders.gemma4 import Gemma4UnifiedTokenizer
        from comfy.text_encoders.lt import ltxav_gemma4_tokenizer

        if not torch.backends.mps.is_available():
            raise RuntimeError('Gemma4 MLX encoding requires Apple Silicon')
        with safe_open(path, framework='pt', device='cpu') as handle:
            metadata = handle.metadata() or {}
            if metadata.get('idream_format') != 'ltx25_gemma4_mlx_affine_v1':
                raise ValueError('Expected a prepared LTX Gemma4 community MLX affine pack')
            config = json.loads(metadata['gemma_config'])
            quantization = json.loads(metadata['quantization'])
            tokenizer_data = {'tokenizer_json': handle.get_tensor('tokenizer_json')}
        if quantization not in [{'bits':bits,'group_size':64,'mode':'affine'} for bits in (4,8)]:
            raise ValueError('Expected the validated Q4 or Q8/group64 recipe')
        text_config = dict(config['text_config'])
        if config.get('model_type') != 'gemma4_unified' or (
            text_config.get('hidden_size'), text_config.get('num_hidden_layers'),
            text_config.get('hidden_size_per_layer_input'),
        ) != (3840,48,0):
            raise ValueError('Expected the LTX-specific 12B unified text backbone')
        self.tokenizer = ltxav_gemma4_tokenizer(Gemma4UnifiedTokenizer)(tokenizer_data=tokenizer_data)
        self.model = Model(ModelArgs.from_dict({'model_type':'gemma4','text_config':text_config,'vocab_size':text_config['vocab_size']}))
        weights = mx.load(str(path))
        weights.pop('tokenizer_json')
        self.projections = {key:weights.pop(key) for key in list(weights) if key.startswith('text_embedding_projection.')}
        quantized = {key.removesuffix('.scales') for key in weights if key.endswith('.scales')}
        # INTENT: only decoder Linears are quantized; do not quantize
        # the protected BF16 embedding, norms, or trained dual projections.
        nn.quantize(self.model, group_size=64, bits=quantization['bits'], mode='affine', class_predicate=lambda key, _: key in quantized)
        self.model.load_weights(list(weights.items()), strict=True)
        self.model.eval()
        mx.eval(self.model.parameters(), self.projections)
        self.weight_mb = sum(value.nbytes for value in weights.values()) / 1024**2 + sum(value.nbytes for value in self.projections.values()) / 1024**2

    def tokenize(self, text):
        return self.tokenizer.tokenize_with_weights(text)

    def encode_from_tokens_scheduled(self, tokens):
        import mlx.core as mx
        import numpy as np
        import torch
        from comfy.model_management import throw_exception_if_processing_interrupted

        if self.model is None:
            raise RuntimeError('Completed MLX CLIP must be reconstructed for another prompt')
        try:
            rows = tokens['gemma4']
            if len(rows) != 1 or any(not isinstance(item[0], int) for item in rows[0]):
                raise ValueError('MLX LTX Gemma supports the workflow plaintext token sequence')
            ids = [item[0] for item in rows[0]]
            first = next((index for index, token in enumerate(ids) if token != 0), len(ids))
            # The causal masks exclude left padding; RoPE depends on relative
            # positions. Preserve tokenization, but avoid executing 1024 rows
            # for short prompts. Full-weight comparisons cover this translation.
            states = collect_states(self.model.language_model.model, [ids[first:]], check_cancelled=throw_exception_if_processing_interrupted)
            result = project_states(states, self.projections)
            mx.eval(result)
            if not bool(mx.all(mx.isfinite(result)).item()):
                raise RuntimeError('Gemma4 MLX produced non-finite conditioning')
            output = torch.from_numpy(np.array(result.astype(mx.float32), copy=True))
            return [[output, {'pooled_output':None, 'unprocessed_ltxav_embeds':True}]]
        except BaseException as error:
            # Comfy can retain the exception. Its finished layer frames also
            # own weights; dropping self.model alone left 13 GB live on cancel.
            states = result = None
            traceback.clear_frames(error.__traceback__)
            # Failed/cancelled graphs never reach the downstream release barrier.
            self.release_completed()
            raise

    def release_completed(self):
        import mlx.core as mx

        if self.model is None:
            return 0.0
        mx.synchronize()
        self.model = None
        self.projections = None
        gc.collect()
        mx.clear_cache()
        return self.weight_mb
