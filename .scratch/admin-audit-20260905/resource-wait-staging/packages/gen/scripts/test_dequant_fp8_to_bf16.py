import tempfile
import unittest
from pathlib import Path
import sys

import torch
from safetensors.torch import load_file, save_file

sys.path.insert(0, str(Path(__file__).parent))

from dequant_fp8_to_bf16 import convert_file, read_header


class DequantFp8ToBf16Test(unittest.TestCase):
    def test_converts_scaled_and_plain_fp8_without_dropping_real_scales(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.safetensors"
            destination = root / "output.safetensors"
            scaled = torch.tensor([[1.0, -2.0]], dtype=torch.float8_e4m3fn)
            plain = torch.tensor([[3.0, 4.0]], dtype=torch.float8_e4m3fn)
            save_file(
                {
                    "layer.weight": scaled,
                    "layer.weight_scale": torch.tensor(0.5),
                    "layer.comfy_quant": torch.tensor(1, dtype=torch.uint8),
                    "plain.weight": plain,
                    "real.logit_scale": torch.tensor(2.0),
                },
                source,
            )

            result = convert_file(source, destination)
            output = load_file(destination)

            self.assertEqual(result["source_fp8"], 2)
            self.assertEqual(result["dropped_sidecars"], 2)
            self.assertEqual(output["layer.weight"].dtype, torch.bfloat16)
            self.assertEqual(output["plain.weight"].dtype, torch.bfloat16)
            torch.testing.assert_close(
                output["layer.weight"].float(),
                scaled.float() * 0.5,
            )
            self.assertIn("real.logit_scale", output)
            self.assertNotIn("layer.weight_scale", output)
            self.assertNotIn("layer.comfy_quant", output)
            self.assertFalse(any("F8" in str(meta["dtype"]) for meta in read_header(destination).values()))

    def test_refuses_to_overwrite_a_completed_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.safetensors"
            destination = root / "output.safetensors"
            save_file(
                {"layer.weight": torch.tensor([1.0], dtype=torch.float8_e4m3fn)},
                source,
            )
            destination.write_bytes(b"keep")

            with self.assertRaises(FileExistsError):
                convert_file(source, destination)
            self.assertEqual(destination.read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
