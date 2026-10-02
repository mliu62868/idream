"""CPU contracts plus opt-in native checks run under Gen's accelerator lease."""

from __future__ import annotations

import os
import copy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import torch

from __init__ import IDreamMPSGraphAttention, mpsgraph_attention


class AttentionContractTest(unittest.TestCase):
    def test_cpu_retains_original_backend_and_arguments(self):
        q, k, v = (torch.zeros(1, 2, 8) for _ in range(3))
        original = Mock(return_value="original result")
        with patch.dict(sys.modules, {"mps_sdpa": None}):
            actual = mpsgraph_attention(original, q, k, v, 2, attn_precision=torch.float32,
                                        skip_output_reshape=True, scale=0.25)
        self.assertEqual(actual, "original result")
        original.assert_called_once_with(q, k, v, 2, None, torch.float32,
                                         skip_reshape=False, skip_output_reshape=True, scale=0.25)

    def test_configuration_failure_precedes_native_extension_import(self):
        with patch.dict(os.environ, {"MPS_SDPA_SKIP_CALIBRATION": "0"}), patch.dict(sys.modules, {"mps_sdpa": None}):
            with self.assertRaisesRegex(RuntimeError, "MPS_SDPA_SKIP_CALIBRATION"):
                IDreamMPSGraphAttention().patch(Mock())

    def test_model_clone_scopes_precision_and_rejects_conflicting_override(self):
        class Model:
            model_options = {"transformer_options": {"existing_setting": True}}
            def clone(self):
                result = Model()
                result.model_options = copy.deepcopy(self.model_options)
                return result
        source = Model()
        dependency = SimpleNamespace(available_backends=lambda: ["mpsgraph_zc"])
        calibration = SimpleNamespace(get_thresholds=lambda: {"fused_min_bytes": {"bf16": 4194304, "fp32": 8388608}})
        with patch.dict(os.environ, {"MPS_SDPA_SKIP_CALIBRATION": "1"}), patch("importlib.metadata.version", return_value="0.2.0"), patch.dict(sys.modules, {"mps_sdpa": dependency, "mps_sdpa.backends": SimpleNamespace(_calibrate=calibration)}):
            result, = IDreamMPSGraphAttention().patch(source, "bf16")
            self.assertNotIn("optimized_attention_override", source.model_options["transformer_options"])
            self.assertTrue(result.model_options["transformer_options"]["existing_setting"])
            self.assertEqual(result.model_options["transformer_options"]["optimized_attention_override"].keywords["compute_precision"], "bf16")
            with self.assertRaisesRegex(ValueError, "already has"):
                IDreamMPSGraphAttention().patch(result)


@unittest.skipUnless(os.environ.get("IDREAM_TEST_MPS_GRAPH") == "1", "Requires the shared accelerator lease")
class NativeAttentionTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(torch.backends.mps.is_available())
        os.environ["MPS_SDPA_SKIP_CALIBRATION"] = "1"
        torch.set_num_threads(4)
        from mps_sdpa.api import reset_call_stats
        reset_call_stats()

    def check_reference(self, q, k, v, mask=None, **kwargs):
        # Selected rows use an independent CPU float64 implementation, including
        # all key/value tokens. No backend is used as its own numerical oracle.
        rows = [0, 511, 1023, 2047]
        reference = q.cpu().double()[:, :, rows] @ k.cpu().double().transpose(-2, -1)
        reference *= kwargs.get("scale", q.shape[-1] ** -0.5)
        if mask is not None:
            reference += mask.cpu().double()[..., rows, :]
        reference = reference.softmax(-1) @ v.cpu().double()
        with torch.inference_mode():
            kwargs.setdefault("compute_precision", "bf16")
            actual = mpsgraph_attention(Mock(side_effect=AssertionError("Unexpected original fallback")),
                                        q, k, v, q.shape[1], mask=mask, skip_reshape=True,
                                        skip_output_reshape=True, **kwargs)
        self.assertEqual(actual.dtype, q.dtype)
        actual = actual.cpu().double()[:, :, rows]
        relative_rmse = ((actual - reference).square().mean() / reference.square().mean()).sqrt().item()
        self.assertLess(relative_rmse, 0.005)
        from mps_sdpa.api import get_call_stats
        self.assertGreater(get_call_stats().get("mpsgraph_zc", 0), 0)

    def test_contiguous_tensor_slice_uses_its_offset_not_storage_origin(self):
        rng = torch.Generator().manual_seed(61002)
        tensors = [torch.randn(2, 1, 2048, 128, generator=rng).to(torch.bfloat16).to("mps")[1:]
                   for _ in range(3)]
        for tensor in tensors:
            self.assertTrue(tensor.is_contiguous())
            self.assertGreater(tensor.storage_offset(), 0)
        self.check_reference(*tensors)

    def test_additive_mask_slice_uses_its_offset(self):
        rng = torch.Generator().manual_seed(61003)
        tensors = [torch.randn(1, 1, 2048, 128, generator=rng).to(torch.bfloat16).to("mps")
                   for _ in range(3)]
        mask = torch.zeros(2, 1, 2048, 2048, dtype=torch.bfloat16)
        mask[1, :, :, 1024:] = float("-inf")
        mask = mask.to("mps")[1:]
        self.assertTrue(mask.is_contiguous())
        self.assertGreater(mask.storage_offset(), 0)
        self.check_reference(*tensors, mask=mask)

    def test_custom_scale_and_noncontiguous_heads_match_reference(self):
        rng = torch.Generator().manual_seed(61004)
        tensors = [torch.randn(1, 2048, 2, 128, generator=rng).to(torch.bfloat16).to("mps").transpose(1, 2)
                   for _ in range(3)]
        self.check_reference(*tensors, scale=0.125)

    def test_default_precision_honors_comfy_fp32_upcast(self):
        rng = torch.Generator().manual_seed(61005)
        tensors = [torch.randn(1, 1, 2048, 128, generator=rng).to(torch.bfloat16).to("mps")
                   for _ in range(3)]
        precision = Mock(return_value=torch.float32)
        from mps_sdpa import sdpa_opt
        with patch.dict(sys.modules, {"comfy.ldm.modules.attention": SimpleNamespace(get_attn_precision=precision)}), patch("mps_sdpa.sdpa_opt", wraps=sdpa_opt) as native:
            self.check_reference(*tensors, compute_precision="comfy")
        precision.assert_called_once_with(None, torch.bfloat16)
        self.assertEqual([t.dtype for t in native.call_args.args[:3]], [torch.float32] * 3)

    def test_short_shapes_and_gqa_retain_original_backend(self):
        q = torch.zeros(1, 4, 64, 128, dtype=torch.bfloat16, device="mps")
        k = torch.zeros(1, 2, 64, 128, dtype=torch.bfloat16, device="mps")
        for kwargs, key in [({}, q), ({"enable_gqa": True}, k)]:
            original = Mock(return_value="original")
            result = mpsgraph_attention(original, q, key, key, 4, skip_reshape=True,
                                        compute_precision="bf16", **kwargs)
            self.assertEqual(result, "original")
            original.assert_called_once_with(q, key, key, 4, None, None,
                                            skip_reshape=True, skip_output_reshape=False, **kwargs)

    def test_broadcast_and_boolean_masks_retain_split_semantics(self):
        q = torch.zeros(1, 1, 2048, 128, dtype=torch.bfloat16, device="mps")
        for mask in [torch.zeros(1, 1, 1, 2048, dtype=torch.bfloat16, device="mps"),
                     torch.ones(2048, 2048, dtype=torch.bool, device="mps")]:
            original = Mock(return_value="original")
            result = mpsgraph_attention(original, q, q, q, 1, mask=mask, skip_reshape=True,
                                        compute_precision="bf16")
            self.assertEqual(result, "original")
            original.assert_called_once_with(q, q, q, 1, mask, None,
                                            skip_reshape=True, skip_output_reshape=False)

    def test_nonfinite_scale_is_not_silently_replaced_by_native_default(self):
        q = torch.zeros(1, 1, 2048, 128, dtype=torch.bfloat16, device="mps")
        for scale in [float("nan"), float("inf")]:
            original = Mock(return_value="original")
            self.assertEqual(mpsgraph_attention(original, q, q, q, 1, skip_reshape=True,
                                                compute_precision="bf16", scale=scale), "original")
            original.assert_called_once()
            self.assertIs(original.call_args.kwargs["scale"], scale)


if __name__ == "__main__":
    unittest.main()
