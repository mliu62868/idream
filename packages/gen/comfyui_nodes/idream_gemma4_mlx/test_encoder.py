from __future__ import annotations

import unittest
import weakref
from types import SimpleNamespace
from unittest.mock import patch

import mlx.core as mx
import numpy as np
import torch
from mlx_lm.models.gemma4 import Model, ModelArgs

from encoder import Gemma4MLXCLIP, collect_states, project_states


def tiny_model():
    config = {'hidden_size':64,'num_hidden_layers':2,'intermediate_size':128,
              'num_attention_heads':1,'num_key_value_heads':1,'num_global_key_value_heads':1,
              'head_dim':64,'global_head_dim':64,'vocab_size':32,
              'num_kv_shared_layers':0,'hidden_size_per_layer_input':0,
              'enable_moe_block':False,'attention_k_eq_v':True,'sliding_window':8,
              'layer_types':['sliding_attention','full_attention']}
    return Model(ModelArgs.from_dict({'model_type':'gemma4','text_config':config,'vocab_size':32})).language_model.model


class EncoderTest(unittest.TestCase):
    def setUp(self):
        mx.random.seed(42)
        torch.manual_seed(42)
        torch.set_num_threads(4)
        self.stream = mx.stream(mx.cpu)
        self.stream.__enter__()

    def tearDown(self):
        self.stream.__exit__(None,None,None)

    def test_final_state_matches_actual_model_norm_without_normalizing_embedding(self):
        inner = tiny_model()
        ids = [[2,4,7,9]]
        states = collect_states(inner,ids)
        reference = inner(mx.array(ids))
        mx.eval(states, reference)
        np.testing.assert_allclose(np.array(states[-1]),np.array(reference),rtol=1e-5,atol=1e-5)
        np.testing.assert_array_equal(np.array(states[0]),np.array(inner.embed_tokens(mx.array(ids))*inner.embed_scale))
        self.assertEqual(len(states),3)

    def test_left_padding_does_not_change_real_token_features(self):
        inner = tiny_model()
        ids = [2,4,7,9]
        short = collect_states(inner,[ids])
        padded = collect_states(inner,[[0]*12+ids])
        mx.eval(short,padded)
        for reference, actual in zip(short,padded):
            np.testing.assert_allclose(np.array(actual),np.array(reference),rtol=2e-4,atol=2e-4)

    def test_projection_matches_independent_torch_hidden_major_layout(self):
        states = [torch.randn(1,7,64) for _ in range(3)]
        weights = {f'text_embedding_projection.{kind}_aggregate_embed.{name}': tensor.to(torch.bfloat16)
                   for kind,dim in [('video',32),('audio',16)]
                   for name,tensor in [('weight',torch.randn(dim,192)),('bias',torch.randn(dim))]}
        reference = torch.stack(states,dim=1).movedim(1,-1)
        reference *= torch.rsqrt(reference.square().mean(dim=2,keepdim=True)+1e-6)
        reference = reference.flatten(start_dim=2)
        expected = torch.cat([torch.nn.functional.linear(reference*(dim/64)**0.5,weights[f'text_embedding_projection.{kind}_aggregate_embed.weight'].float(),weights[f'text_embedding_projection.{kind}_aggregate_embed.bias'].float()) for kind,dim in [('video',32),('audio',16)]],dim=-1)
        actual = project_states([mx.array(tensor.numpy()) for tensor in states],{key:mx.array(tensor.float().numpy()).astype(mx.bfloat16) for key,tensor in weights.items()})
        mx.eval(actual)
        self.assertEqual(actual.dtype, mx.float32)
        np.testing.assert_allclose(np.array(actual),expected.numpy(),rtol=1e-5,atol=1e-5)

    def test_invalid_interior_padding_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'contiguous left prefix'):
            collect_states(tiny_model(),[[2,0,4]])

    def test_cancellation_propagates_at_layer_boundary(self):
        def cancel():
            raise InterruptedError('cancelled')
        with self.assertRaisesRegex(InterruptedError,'cancelled'):
            collect_states(tiny_model(),[[2,4]],check_cancelled=cancel)

    def test_failed_encode_releases_owner_without_downstream_barrier(self):
        def cancel():
            raise InterruptedError('cancelled')
        owner = Gemma4MLXCLIP.__new__(Gemma4MLXCLIP)
        inner = tiny_model()
        reference = weakref.ref(inner)
        owner.model = SimpleNamespace(language_model=SimpleNamespace(model=inner))
        del inner
        owner.projections = {}
        owner.weight_mb = 1.0
        management = SimpleNamespace(throw_exception_if_processing_interrupted=cancel)
        with patch.dict('sys.modules', {'comfy.model_management': management}), patch.object(mx, 'synchronize'), patch.object(mx, 'clear_cache'):
            held_error = None
            try:
                owner.encode_from_tokens_scheduled({'gemma4':[[(2,1.0),(4,1.0)]]})
            except InterruptedError as error:
                held_error = error
        self.assertIsInstance(held_error, InterruptedError)
        self.assertIsNone(owner.model)
        self.assertIsNone(owner.projections)
        self.assertIsNone(reference(), 'Cached exception traceback must not retain the model')
        self.assertEqual(owner.release_completed(), 0.0)


if __name__ == '__main__':
    unittest.main()
