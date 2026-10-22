"""Actual quantized Linear and ModelPatcher lifecycle regression, CPU/MPS."""
import os
import unittest

import torch
from comfy import ops
from comfy.model_patcher import ModelPatcher
from idream_qwen21.resident import resident_int8_model


class ResidentWeightsTests(unittest.TestCase):
    def make_patcher(self, device):
        torch.manual_seed(20261012)
        linear = ops.mixed_precision_ops(compute_dtype=torch.bfloat16, disabled={"int8_tensorwise"}).Linear(256, 32, bias=False, device=device)
        import json
        linear.load_state_dict({
            "weight": torch.randint(-127, 128, (32, 256), dtype=torch.int8),
            "weight_scale": torch.full((32, 1), .002),
            "comfy_quant": torch.tensor(list(json.dumps({"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}).encode()), dtype=torch.uint8),
        })
        model = torch.nn.Module()
        model.diffusion_model = torch.nn.ModuleDict({"linear": linear})
        return ModelPatcher(model, torch.device(device), torch.device("cpu")), linear

    def check_device(self, device):
        patcher, linear = self.make_patcher(device)
        x = torch.randn(4, 256, dtype=torch.bfloat16, device=device)
        original = linear.weight
        expected = linear(x)
        prepared = resident_int8_model(patcher, torch.device(device))
        self.assertIs(linear.weight, original)
        self.assertFalse(patcher.object_patches)
        self.assertGreater(prepared.model_size(), patcher.model_size())
        prepared.patch_model(load_weights=False)
        live = lambda: patcher.model.diffusion_model["linear"]
        self.assertIsNot(live().weight, original)
        torch.testing.assert_close(live()(x), expected, rtol=0, atol=0)
        prepared.unpatch_model(unpatch_weights=False)
        self.assertIs(linear.weight, original)
        torch.testing.assert_close(live()(x), expected, rtol=0, atol=0)
        # A distinct clone must retain the original quantized path.
        self.assertFalse(patcher.clone().object_patches)

        # Exercise the managed, already-loaded clone transition, including its
        # memory accounting; patch_model alone does not cover this early return.
        patcher.partially_load(torch.device(device), extra_memory=10**9)
        self.assertEqual(patcher.loaded_size(), patcher.model_size())
        prepared.partially_load(torch.device(device), extra_memory=10**9)
        self.assertEqual(prepared.loaded_size(), prepared.model_size())
        torch.testing.assert_close(live()(x), expected, rtol=0, atol=0)
        patcher.partially_load(torch.device(device), extra_memory=10**9)
        self.assertEqual(patcher.loaded_size(), patcher.model_size())
        torch.testing.assert_close(linear(x), expected, rtol=0, atol=0)
        patcher.unpatch_model(unpatch_weights=True)

    def test_rebuild_while_a_resident_sibling_is_active(self):
        patcher, linear = self.make_patcher("cpu")
        original = linear.weight
        prepared = resident_int8_model(patcher, torch.device("cpu"))
        prepared.patch_model(load_weights=False)
        try:
            rebuilt = resident_int8_model(patcher, torch.device("cpu"))
            self.assertEqual(rebuilt.model_size(), prepared.model_size())
            torch.testing.assert_close(rebuilt.get_model_object("diffusion_model.linear").weight, prepared.get_model_object("diffusion_model.linear").weight, rtol=0, atol=0)
        finally:
            prepared.unpatch_model(unpatch_weights=False)
        self.assertIs(linear.weight, original)

    def test_cpu_clone_and_restore_preserve_quantized_path(self):
        self.check_device("cpu")

    @unittest.skipUnless(os.environ.get("IDREAM_TEST_RESIDENT_MPS") == "1", "Requires accelerator lease")
    def test_mps_uses_identical_bf16_weights_and_restores_original(self):
        self.check_device("mps")

    def test_weight_updates_cannot_be_silently_frozen(self):
        model = torch.nn.Module()
        model.diffusion_model = torch.nn.Linear(2, 2)
        patcher = ModelPatcher(model, torch.device("cpu"), torch.device("cpu"))
        patcher.patches["diffusion_model.weight"] = ["pending adapter"]
        with self.assertRaisesRegex(ValueError, "weight patches"):
            resident_int8_model(patcher, torch.device("cpu"))

    @unittest.skipUnless(os.environ.get("IDREAM_TEST_RESIDENT_MPS") == "1", "Requires accelerator lease")
    def test_cached_clones_release_mps_weights_and_reload(self):
        import gc
        from comfy.quant_ops import QuantizedTensor
        patcher, source = self.make_patcher("mps")
        x = torch.randn(4, 256, dtype=torch.bfloat16, device="mps")
        expected = source(x)
        prepared = resident_int8_model(patcher, torch.device("mps"))
        sibling = prepared.clone()
        prepared.partially_load(torch.device("mps"), extra_memory=10**9)
        prepared.detach(unpatch_all=False)
        sibling.partially_load(torch.device("mps"), extra_memory=10**9)
        self.assertEqual(sibling.loaded_size(), sibling.model_size())
        live = lambda: patcher.model.diffusion_model["linear"]
        torch.testing.assert_close(live()(x), expected, rtol=0, atol=0)
        weight_bytes = live().weight.nbytes
        torch.mps.synchronize()
        allocated_before = torch.mps.current_allocated_memory()
        sibling.detach()
        for cached in (prepared, sibling):
            for value in cached.object_patches.values():
                tensors = value.parameters() if isinstance(value, torch.nn.Module) else (value,)
                self.assertTrue(all(tensor.device.type == "cpu" for tensor in tensors))
        self.assertTrue(all(p.device.type == "cpu" for p in patcher.model.parameters()))
        self.assertIs(live(), source)
        self.assertIsInstance(source.weight, QuantizedTensor)
        gc.collect()
        torch.mps.synchronize()
        torch.mps.empty_cache()
        allocated_after = torch.mps.current_allocated_memory()
        self.assertLessEqual(allocated_after, allocated_before - weight_bytes)
        print({"resident_mps_bytes": weight_bytes, "allocated_before": allocated_before, "allocated_after": allocated_after})
        sibling.partially_load(torch.device("mps"), extra_memory=10**9)
        self.assertEqual(sibling.loaded_size(), sibling.model_size())
        self.assertEqual(patcher.model.diffusion_model["linear"].weight.device.type, "mps")
        torch.testing.assert_close(live()(x), expected, rtol=0, atol=0)
        sibling.partially_load(torch.device("mps"), extra_memory=10**9)
        self.assertEqual(live().weight.device.type, "mps")
        torch.testing.assert_close(live()(x), expected, rtol=0, atol=0)
        sibling.detach()


if __name__ == "__main__":
    unittest.main()
