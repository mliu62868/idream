"""Run in the image ComfyUI environment; MPS tests expose the original bug."""
import itertools
import os
import subprocess
import sys
import unittest

import torch
from comfy.ldm.wan.vae2_2 import AvgDown3D
from idream_qwen21 import IDreamQwen21TextEncode, safe_avg_down_forward
from idream_qwen21.turbo import IDreamQwen21TurboSigmas, run_with_lora


class RegistrationTests(unittest.TestCase):
    def test_video_profiles_do_not_import_image_model_dependencies(self):
        for profile in ("video", "video-h3"):
            with self.subTest(profile=profile):
                env = dict(os.environ, COMFYUI_PROFILE=profile)
                env["PYTHONPATH"] = os.path.dirname(os.path.dirname(__file__))
                code = (
                    "import sys, idream_qwen21 as nodes; "
                    "assert nodes.NODE_CLASS_MAPPINGS == {}; "
                    "assert 'idream_qwen21.nodes' not in sys.modules; "
                    "assert 'comfy_extras.nodes_qwen' not in sys.modules; "
                    "assert 'torch' not in sys.modules"
                )
                result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


class TurboTests(unittest.TestCase):
    def test_fused_mlp_matches_unmerged_gate_up_and_down_math(self):
        class MLP(torch.nn.Module):
            fused = True
            def __init__(self):
                super().__init__()
                self.gate_up = torch.nn.Linear(2, 6, bias=False)
                self.out = torch.nn.Linear(3, 2, bias=False)
            def forward(self, x):
                gate, up = self.gate_up(x).chunk(2, -1)
                return torch.nn.functional.linear(torch.nn.functional.silu(gate) * up, self.out.weight)
        model = torch.nn.ModuleDict({"mlp": MLP()})
        class Executor:
            class_obj = model
            def __call__(self, x): return model["mlp"](x)
        generator = torch.Generator().manual_seed(7)
        gate = [torch.randn(1, 2, generator=generator), torch.randn(3, 1, generator=generator)]
        up = [torch.randn(1, 2, generator=generator), torch.randn(3, 1, generator=generator)]
        down = [torch.randn(1, 3, generator=generator), torch.randn(2, 1, generator=generator)]
        x = torch.tensor([[1., 2.]])
        mlp = model["mlp"]
        base_gate, base_up = mlp.gate_up(x).chunk(2, -1)
        hidden = torch.nn.functional.silu(base_gate + x @ gate[0].T @ gate[1].T) * (base_up + x @ up[0].T @ up[1].T)
        expected = hidden @ mlp.out.weight.T + hidden @ down[0].T @ down[1].T
        state = {name: value.clone() for name, value in model.state_dict().items()}
        actual = run_with_lora({"mlp.gate_layer": gate, "mlp.proj": up, "mlp.out": down}, Executor(), x)
        torch.testing.assert_close(actual, expected)
        for module in model.modules(): self.assertFalse(module._forward_hooks)
        for name, value in model.state_dict().items(): torch.testing.assert_close(value, state[name], rtol=0, atol=0)

    def test_six_step_schedule_matches_author_grid_at_1024(self):
        latent = {"samples": torch.empty(1, 64, 64, 64)}
        (sigmas,) = IDreamQwen21TurboSigmas().get_sigmas(latent, 6)
        expected = torch.tensor([1, .967754458, .933358293, .857191977, .666755818, .400096293, 0])
        # Values from exp(mu)/(exp(mu)+(1/t-1)), mu=0.693548387,
        # not the ordinary linear scheduler or its terminal-0.02 stretch.
        torch.testing.assert_close(sigmas, expected, atol=1e-7, rtol=1e-6)
        with self.assertRaises(ValueError): IDreamQwen21TurboSigmas().get_sigmas(latent, 4)

    def test_adapter_hooks_clean_up_even_when_registration_fails(self):
        model = torch.nn.Sequential(torch.nn.Linear(2, 2, bias=False))
        class Executor:
            class_obj = model
            def __call__(self, x): return model(x)
        weights = [torch.ones(1, 2), torch.ones(2, 1)]
        x = torch.tensor([[1., 2.]])
        original = model(x)
        actual = run_with_lora({"0": weights}, Executor(), x)
        torch.testing.assert_close(actual, original + 3)
        self.assertFalse(model[0]._forward_hooks)
        with self.assertRaises(AttributeError):
            run_with_lora({"0": weights, "missing": weights}, Executor(), x)
        self.assertFalse(model[0]._forward_hooks)


class ConditioningTests(unittest.TestCase):
    def test_unconditional_encoder_runs_only_when_cfg_uses_it(self):
        class Clip:
            def __init__(self): self.prompts = []
            def tokenize(self, text, **_kwargs): return text
            def encode_from_tokens_scheduled(self, text):
                self.prompts.append(text)
                return [[torch.tensor([len(text)]), {}]]
        for cfg, expected in [(1, ["change shirt"]), (2, ["change shirt", "blur"])]:
            clip = Clip()
            output = IDreamQwen21TextEncode.execute(clip, "change shirt", "blur", cfg=cfg).result
            self.assertEqual(clip.prompts, expected)
            self.assertEqual(tuple(output[2]["samples"].shape), (1, 64, 64, 64))
            if cfg == 1: self.assertIs(output[0], output[1])
            else: self.assertIsNot(output[0], output[1])


class TemporalPaddingTests(unittest.TestCase):
    def test_matches_cpu_for_temporal_spatial_and_strided_inputs(self):
        for factor_t, factor_s, frames, strided in itertools.product(
            (1, 2, 4), (1, 2), (1, 2, 5), (False, True)
        ):
            with self.subTest(factor_t=factor_t, factor_s=factor_s, frames=frames, strided=strided):
                x = torch.arange(2 * 4 * frames * 8 * 12, dtype=torch.float32).reshape(2, 4, frames, 8, 12)
                if strided:
                    x = x[..., ::2]
                module = AvgDown3D(4, 4, factor_t, factor_s)
                expected = module(x)
                torch.testing.assert_close(safe_avg_down_forward(module, x), expected, rtol=0, atol=0)

    @unittest.skipUnless(torch.backends.mps.is_available(), "Apple GPU required")
    def test_large_mps_padding_preserves_every_pixel(self):
        for height, width, dtype in itertools.product((512, 416), (512, 608), (torch.float32, torch.bfloat16)):
            with self.subTest(height=height, width=width, dtype=dtype):
                # Constant values per channel make every corrupted pixel
                # observable; both square and product portrait sizes failed.
                x = torch.arange(96, dtype=dtype).reshape(1, 96, 1, 1, 1).expand(1, 96, 1, height, width).contiguous()
                module = AvgDown3D(96, 192, 2)
                expected = module(x)
                actual = safe_avg_down_forward(module, x.to("mps")).cpu()
                torch.testing.assert_close(actual, expected, rtol=0, atol=0)
                torch.mps.empty_cache()


if __name__ == "__main__":
    unittest.main()
