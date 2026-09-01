from __future__ import annotations

import importlib
import math
import sys
import types
import unittest
from unittest.mock import Mock


fake_management = types.ModuleType("comfy.model_management")
fake_memory_management = types.ModuleType("comfy.memory_management")
fake_comfy = types.ModuleType("comfy")
fake_comfy.__path__ = []
fake_comfy.model_management = fake_management
fake_comfy.memory_management = fake_memory_management
sys.modules.setdefault("comfy", fake_comfy)
sys.modules.setdefault("comfy.model_management", fake_management)
sys.modules.setdefault("comfy.memory_management", fake_memory_management)

memory_lifecycle = importlib.import_module("idream_memory_lifecycle")


class FakeModel:
    pass


class FakePatcher:
    def __init__(self, device: str, size_mb: int):
        self.model = FakeModel()
        self.load_device = device
        self._size = size_mb * 1024**2

    def model_size(self):
        return self._size


class FakeLoadedModel:
    def __init__(self, device: str, *, size_mb: int, unload_error: Exception | None = None):
        self.device = device
        self.model = FakePatcher(device, size_mb)
        self._size = size_mb * 1024**2
        self._unload_error = unload_error
        self.unload_calls: list[object] = []

    def model_memory(self):
        return self._size

    def model_unload(self, memory_to_free):
        self.unload_calls.append(memory_to_free)
        if self._unload_error is not None:
            raise self._unload_error


class MemoryLifecycleTest(unittest.TestCase):
    def setUp(self):
        fake_management.get_torch_device = Mock(return_value="mps")
        fake_management.soft_empty_cache = Mock()
        fake_management.current_loaded_models = []
        fake_memory_management.extra_ram_release = Mock(return_value=0)

    def test_releases_only_off_device_models_and_preserves_passthrough(self):
        text_encoder = FakeLoadedModel("cpu", size_mb=14_613)
        diffusion_model = FakeLoadedModel("mps", size_mb=16_201)
        fake_management.current_loaded_models = [text_encoder, diffusion_model]

        value = object()
        dependency = object()
        result = memory_lifecycle.IDreamUnloadOffDeviceModels().unload(
            value,
            after=dependency,
        )

        self.assertEqual(result, (value, dependency))
        self.assertEqual(text_encoder.unload_calls, [None])
        self.assertEqual(diffusion_model.unload_calls, [])
        self.assertEqual(fake_management.current_loaded_models, [diffusion_model])
        fake_memory_management.extra_ram_release.assert_called_once_with(
            1 << 62,
            free_active=True,
        )
        fake_management.soft_empty_cache.assert_called_once_with()

    def test_failed_unload_is_best_effort_and_keeps_the_model_registered(self):
        text_encoder = FakeLoadedModel(
            "cpu",
            size_mb=14_613,
            unload_error=RuntimeError("cannot unload"),
        )
        fake_management.current_loaded_models = [text_encoder]

        memory_lifecycle.release_off_device_models()

        self.assertEqual(fake_management.current_loaded_models, [text_encoder])
        fake_management.soft_empty_cache.assert_called_once_with()

    def test_failed_cache_eviction_does_not_fail_the_render(self):
        fake_memory_management.extra_ram_release = Mock(
            side_effect=RuntimeError("cache unavailable"),
        )

        value = object()
        dependency = object()

        self.assertEqual(
            memory_lifecycle.IDreamUnloadOffDeviceModels().unload(
                value,
                dependency,
            ),
            (value, dependency),
        )
        fake_management.soft_empty_cache.assert_called_once_with()

    def test_failed_accelerator_cache_cleanup_does_not_fail_the_render(self):
        fake_management.soft_empty_cache = Mock(
            side_effect=RuntimeError("accelerator cache unavailable"),
        )

        value = object()
        dependency = object()

        self.assertEqual(
            memory_lifecycle.IDreamUnloadOffDeviceModels().unload(
                value,
                dependency,
            ),
            (value, dependency),
        )
        fake_management.soft_empty_cache.assert_called_once_with()

    def test_discards_declared_dead_clip_owner_after_conditioning(self):
        text_encoder = FakeLoadedModel("cpu", size_mb=7_388)
        owner = types.SimpleNamespace(
            patcher=text_encoder.model,
            cond_stage_model=text_encoder.model.model,
        )
        fake_management.current_loaded_models = [text_encoder]

        value = object()
        dependency = object()
        result = memory_lifecycle.IDreamUnloadOffDeviceModels().unload(
            value,
            dependency,
            release=owner,
        )

        self.assertEqual(result, (value, dependency))
        self.assertIsNone(owner.cond_stage_model)
        self.assertIsNone(owner.patcher.model)

    def test_clip_loaders_are_never_reused_after_owner_discard(self):
        self.assertTrue(
            math.isnan(memory_lifecycle.IDreamFreshCheckpointCLIPLoader.IS_CHANGED()),
        )
        self.assertTrue(
            math.isnan(memory_lifecycle.IDreamFreshCLIPLoader.IS_CHANGED()),
        )


if __name__ == "__main__":
    unittest.main()
