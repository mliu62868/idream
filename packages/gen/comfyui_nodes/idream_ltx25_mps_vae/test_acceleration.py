from __future__ import annotations

import copy
import unittest

import torch
import torch.nn.functional as functional

from acceleration import CONFIG, accelerate_vae, conv3d_via_conv2d, install, supports


class FakeVAE(torch.nn.Module):
    def __init__(self, config):
        super().__init__()
        self.config = copy.deepcopy(config)
        self.encoder = torch.nn.Conv3d(16, 32, 3, padding=(0, 1, 1))
        self.decoder = torch.nn.Sequential(
            torch.nn.Conv3d(16, 32, 3, padding=(0, 1, 1)),
        )


class VAEAccelerationTest(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(27)
        torch.set_num_threads(4)

    def test_windowed_convolution_matches_independent_cpu_float64_reference(self):
        for stride, bias in [((1, 1, 1), True), ((1, 2, 2), False)]:
            with self.subTest(stride=stride, bias=bias):
                module = torch.nn.Conv3d(16, 32, 3, stride=stride, padding=(0, 1, 1), bias=bias, dtype=torch.float64)
                values = torch.randn(2, 16, 7, 9, 11, dtype=torch.float64)
                reference = functional.conv3d(values, module.weight, module.bias, stride=stride, padding=(0, 1, 1))
                actual = conv3d_via_conv2d(module, values, module.weight, module.bias, window_elements=1)
                torch.testing.assert_close(actual, reference, rtol=1e-10, atol=1e-10)

    def test_uses_supplied_effective_weights_instead_of_module_storage(self):
        module = torch.nn.Conv3d(16, 32, 3, padding=(0, 1, 1), dtype=torch.float64)
        values = torch.randn(1, 16, 5, 7, 7, dtype=torch.float64)
        weight = module.weight.detach() * -2
        bias = module.bias.detach() + 3
        reference = functional.conv3d(values, weight, bias, padding=(0, 1, 1))
        actual = conv3d_via_conv2d(module, values, weight, bias)
        torch.testing.assert_close(actual, reference, rtol=1e-10, atol=1e-10)

    def test_unsupported_temporal_stride_and_reflect_padding_are_not_replaced(self):
        self.assertFalse(supports(torch.nn.Conv3d(16, 32, 3, stride=2)))
        self.assertFalse(supports(torch.nn.Conv3d(16, 32, 3, padding=1, padding_mode="reflect")))

    def test_model_scope_preserves_encoder_and_original_cpu_result(self):
        model = FakeVAE(CONFIG)
        values = torch.randn(1, 16, 5, 7, 7)
        reference = model.decoder(values)
        encoder_result = model.encoder(values)
        accelerate_vae(model)
        torch.testing.assert_close(model.decoder(values), reference, rtol=0, atol=0)
        torch.testing.assert_close(model.encoder(values), encoder_result, rtol=0, atol=0)
        self.assertFalse(hasattr(model.encoder, "_idream_original_conv_forward"))

    def test_other_video_vae_architectures_keep_their_original_operation(self):
        config = {**CONFIG, "timestep_conditioning": True}
        model = FakeVAE(config)
        original = model.decoder[0]._conv_forward
        self.assertEqual(accelerate_vae(model), 0)
        self.assertEqual(model.decoder[0]._conv_forward, original)

    def test_constructor_hook_is_idempotent_and_preserves_arguments(self):
        class LocalVAE(FakeVAE):
            pass
        install(LocalVAE)
        install(LocalVAE)
        model = LocalVAE(config=CONFIG)
        self.assertEqual(accelerate_vae(model), 0)
        values = torch.randn(1, 16, 5, 7, 7)
        module = model.decoder[0]
        reference = functional.conv3d(values, module.weight, module.bias, padding=(0, 1, 1))
        torch.testing.assert_close(model.decoder(values), reference, rtol=0, atol=0)

    @unittest.skipUnless(torch.backends.mps.is_available(), "Requires an Apple MPS device")
    def test_mps_strided_depth_kernels_match_cpu_reference(self):
        for dtype, tolerance in [(torch.float32, 1e-5), (torch.bfloat16, 0.01)]:
            with self.subTest(dtype=dtype):
                module = torch.nn.Conv3d(16, 32, 3, padding=(0, 1, 1), dtype=dtype).to("mps")
                values = torch.randn(2, 16, 5, 8, 8, dtype=dtype).to("mps")
                with torch.inference_mode():
                    actual = conv3d_via_conv2d(module, values, module.weight, module.bias).cpu().float()
                    reference = functional.conv3d(values.cpu().float(), module.weight.cpu().float(), module.bias.cpu().float(), padding=(0, 1, 1))
                relative_rmse = ((actual-reference).square().mean()/reference.square().mean()).sqrt().item()
                self.assertLess(relative_rmse, tolerance)


if __name__ == "__main__":
    unittest.main()
