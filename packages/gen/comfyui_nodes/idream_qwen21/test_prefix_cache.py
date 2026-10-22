"""Real Qwen current_patcher/ModelPatcher/PoseBranchCache lifecycle on CPU."""

import os
import unittest
import uuid
import torch
from comfy import ops
from comfy.model_base import QwenImage21
from comfy.model_patcher import ModelPatcher
from comfy.patcher_extension import CallbacksMP
from comfy.ldm.qwen_image21.model import QwenImage21Transformer2DModel
from idream_qwen21.prefix_cache import reuse_qwen_prefix_cache


class TinyBase(torch.nn.Module):
    current_patcher = QwenImage21.current_patcher

    def __init__(self):
        super().__init__()
        self._current_patcher = None
        self.device = torch.device("cpu")
        self.diffusion_model = QwenImage21Transformer2DModel(
            num_layers=1,
            num_attention_heads=1,
            attention_head_dim=128,
            context_in_dim=128,
            dtype=torch.float32,
            device="cpu",
            operations=ops.manual_cast,
        )


class PrefixReuseTests(unittest.TestCase):
    def make(self, device="cpu"):
        root = TinyBase()
        p = ModelPatcher(root, torch.device(device), torch.device("cpu"))
        m = reuse_qwen_prefix_cache(p)
        m.partially_load(torch.device(device), extra_memory=10**9)
        m.pre_run()
        self.addCleanup(m.detach)
        return m, root.diffusion_model

    def fill(self, d, key=None):
        key = torch.arange(8, dtype=torch.float32).reshape(1, 8) if key is None else key
        cache, hit = d.select_prefix_cache(
            key, 1024, torch.device("cpu"), {"device": "gpu", "dtype": "default"}
        )
        if not hit:
            cache.put(0, torch.ones(1, 2, 2, 1, 128))
        return cache, key

    def test_complete_prefix_survives_cleanup_and_clone_detach(self):
        m, d = self.make()
        cache, key = self.fill(d)
        m.cleanup()
        m.detach(unpatch_all=False)
        m.partially_load(torch.device("cpu"), extra_memory=10**9)
        m.pre_run()
        again, hit = d.select_prefix_cache(
            key, 1024, torch.device("cpu"), {"device": "gpu", "dtype": "default"}
        )
        self.assertTrue(
            hit, "Unchanged repeated input must not recompute the reference prefix"
        )
        self.assertIs(again, cache)

    def test_changed_input_replaces_the_single_slot(self):
        m, d = self.make()
        cache, key = self.fill(d)
        m.cleanup()
        m.pre_run()
        self.fill(d, key + 1)
        self.assertEqual(len(d.prefix_cache.slots), 1)
        self.assertTrue(d.prefix_cache.select(key + 1, create=False))
        self.assertFalse(d.prefix_cache.select(key, create=False))

    def test_full_detach_frees_cache(self):
        m, d = self.make()
        cache, _ = self.fill(d)
        m.cleanup()
        m.detach()
        self.assertIsNone(d.prefix_cache)
        self.assertEqual(cache.memory_bytes(), 0)

    def test_changed_weights_options_and_hooks_do_not_reuse(self):
        for mutation in ["weights", "options", "hooks", "clone"]:
            with self.subTest(mutation=mutation):
                m, d = self.make()
                cache, key = self.fill(d)
                m.cleanup()
                if mutation == "weights":
                    m.patches_uuid = uuid.uuid4()
                if mutation == "options":
                    m.model_options["transformer_options"]["qwen_image21_cache"] = {
                        "dtype": "int8",
                        "device": "gpu",
                    }
                if mutation == "hooks":
                    m.hook_patches["changed"] = "hook"
                active = m.clone() if mutation == "clone" else m
                active.pre_run()
                self.assertIsNone(d.prefix_cache)
                self.assertEqual(cache.memory_bytes(), 0)

    def test_incomplete_prefix_is_discarded(self):
        m, d = self.make()
        cache, key = self.fill(d)
        cache.slot["blocks"].clear()
        m.cleanup()
        m.pre_run()
        self.assertIsNone(d.prefix_cache)

    def test_methods_restore_on_unpatch(self):
        m, d = self.make()
        m.detach()
        self.assertIs(
            d.reset_prefix_cache.__func__,
            QwenImage21Transformer2DModel.reset_prefix_cache,
        )
        self.assertIs(
            d.select_prefix_cache.__func__,
            QwenImage21Transformer2DModel.select_prefix_cache,
        )

    def test_reused_prefix_matches_fresh_forward_with_new_noise_and_timestep(self):
        torch.set_num_threads(1)
        torch.manual_seed(78)
        root = TinyBase()
        with torch.no_grad():
            for p in root.parameters():
                p.normal_(0, 0.02)
        base = ModelPatcher(root, torch.device("cpu"), torch.device("cpu"))
        base.partially_load(torch.device("cpu"), extra_memory=10**9)
        d = root.diffusion_model
        context = torch.randn(1, 5, 128)
        refs = [torch.randn(1, 64, 2, 2)]
        noise = [torch.randn(1, 64, 2, 2) for _ in range(2)]
        expected = []
        with torch.inference_mode():
            for i, x in enumerate(noise):
                base.pre_run()
                expected.append(
                    d(
                        x,
                        torch.tensor([1.0 - i * 0.5]),
                        context,
                        ref_latents=refs,
                        image_slots=[0],
                    ).clone()
                )
                base.cleanup()
            m = reuse_qwen_prefix_cache(base)
            m.partially_load(torch.device("cpu"), extra_memory=10**9)
            for i, x in enumerate(noise):
                m.pre_run()
                actual = d(
                    x,
                    torch.tensor([1.0 - i * 0.5]),
                    context,
                    ref_latents=refs,
                    image_slots=[0],
                )
                m.cleanup()
                torch.testing.assert_close(actual, expected[i], rtol=0, atol=0)
            m.detach()

    def test_runtime_cache_options_cannot_reuse_the_old_representation(self):
        m, d = self.make()
        old, key = self.fill(d)
        m.cleanup()
        m.pre_run()
        cache, hit = d.select_prefix_cache(
            key, 1024, torch.device("cpu"), {"device": "gpu", "dtype": "int8"}
        )
        self.assertFalse(hit)
        self.assertIsNot(cache, old)
        self.assertEqual(cache.dtype, "int8")
        self.assertEqual(old.memory_bytes(), 0)

    def test_cfg_branches_keep_stock_multislot_behavior_within_one_run(self):
        m, d = self.make()
        cache, key = self.fill(d)
        self.fill(d, key + 1)
        self.assertEqual(len(cache.slots), 2)
        m.cleanup()
        self.assertIsNone(d.prefix_cache)

    def test_existing_cache_method_patch_is_rejected(self):
        m, d = self.make()
        with self.assertRaisesRegex(ValueError, "existing cache method patch"):
            reuse_qwen_prefix_cache(m)

    def test_rebuild_while_a_sibling_is_active_does_not_capture_its_methods(self):
        m, d = self.make()
        source = m.clone()
        source.object_patches = {}
        source.remove_callbacks_with_key(
            CallbacksMP.ON_DETACH, "idream_qwen_prefix_reuse"
        )
        rebuilt = reuse_qwen_prefix_cache(source)
        m.detach()
        rebuilt.partially_load(torch.device("cpu"), extra_memory=10**9)
        rebuilt.pre_run()
        self.addCleanup(rebuilt.detach)
        cache, key = self.fill(d)
        rebuilt.cleanup()
        rebuilt.detach()
        self.assertIsNone(d.prefix_cache)
        self.assertEqual(cache.memory_bytes(), 0)

    @unittest.skipUnless(
        os.environ.get("IDREAM_TEST_RESIDENT_MPS") == "1", "Requires accelerator lease"
    )
    def test_mps_cache_is_retained_then_physically_freed_on_unload(self):
        import gc

        m, d = self.make("mps")
        key = torch.arange(8, dtype=torch.float32, device="mps").reshape(1, 8)
        cache, _ = d.select_prefix_cache(
            key, 16 << 20, torch.device("mps"), {"device": "gpu", "dtype": "default"}
        )
        cache.put(
            0, torch.ones(1, 2, 1024, 32, 128, dtype=torch.bfloat16, device="mps")
        )
        cache_bytes = cache.memory_bytes()
        m.cleanup()
        self.assertIs(d.prefix_cache, cache)
        torch.mps.synchronize()
        before = torch.mps.current_allocated_memory()
        m.detach()
        gc.collect()
        torch.mps.synchronize()
        torch.mps.empty_cache()
        after = torch.mps.current_allocated_memory()
        self.assertIsNone(d.prefix_cache)
        self.assertEqual(cache.memory_bytes(), 0)
        self.assertLessEqual(after, before - cache_bytes)
        print(
            {
                "prefix_cache_bytes": cache_bytes,
                "allocated_before": before,
                "allocated_after": after,
            }
        )


if __name__ == "__main__":
    unittest.main()
