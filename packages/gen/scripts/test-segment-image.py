"""Canonical segmentation regressions; requires NumPy, Pillow and Torch.

Use the existing Comfy Python environment through PATH. Missing dependencies
are test errors, never skipped. No model checkpoint is loaded by this suite.
"""

import contextlib
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("segment-image.py")
FIXTURES = json.loads((Path(__file__).parent / "fixtures/segmentation-candidate-metrics.json").read_text())["cases"]
spec = importlib.util.spec_from_file_location("segment_image", SCRIPT)
segment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(segment)


class SegmentContractTests(unittest.TestCase):
    def saved_overlap_fixture(self, name):
        """Replay saved areas/intersection, not an invented semantic mask."""
        import numpy as np
        saved = FIXTURES[name]
        first, second = saved["candidates"]
        intersection = saved["intersectionPixels"]
        self.assertEqual(first["maskPixels"] + second["maskPixels"] - intersection, saved["maskPixels"])
        # The gate depends on set areas/overlap only. The original per-query
        # bitmaps were not retained, so reconstruct exactly those saved metrics.
        a = np.zeros((1, saved["totalPixels"]), dtype=np.bool_)
        b = np.zeros_like(a)
        a[0, :first["maskPixels"]] = True
        b_start = first["maskPixels"] - intersection
        b[0, b_start:b_start + second["maskPixels"]] = True
        return [(first["index"], first["score"], a), (second["index"], second["score"], b)], saved

    def test_saved_mug_and_green_mug_disagreements_are_refused_in_both_score_orders(self):
        for name in ("mug", "green-mug"):
            items, saved = self.saved_overlap_fixture(name)
            for reverse in (False, True):
                with self.subTest(name=name, reversedScores=reverse):
                    arranged = items if not reverse else [(items[0][0], items[1][1], items[0][2]),
                                                         (items[1][0], items[0][1], items[1][2])]
                    _, _, groups = self.group_items(arranged)
                    self.assertEqual(groups[0]["memberIndices"], [98, 104])
                    self.assertEqual(groups[0]["pairCount"], 1)
                    self.assertEqual(groups[0]["disagreementPairCount"], 1)
                    pair = groups[0]["worstPair"]
                    self.assertEqual(pair["indices"], [98, 104])
                    self.assertEqual(pair["maskPixels"], [item["maskPixels"] for item in saved["candidates"]])
                    self.assertEqual(pair["unionPixels"], saved["maskPixels"])
                    self.assertEqual(pair["disputedPixels"], 7519 if name == "mug" else 7565)
                    self.assertEqual(pair["iou"], saved["intersectionPixels"] / saved["maskPixels"])
                    with self.assertRaises(segment.SegmentError) as failure:
                        self.run_fusion(arranged)
                    self.assertEqual(failure.exception.code, "target_region_uncertain")
                    self.assertEqual(failure.exception.exit_code, 3)

    def test_overlap_chain_refusal_does_not_depend_on_representative_score(self):
        import numpy as np
        masks = []
        for start, end in [(0, 80), (0, 100), (50, 100)]:
            mask = np.zeros((1, 400), dtype=np.bool_)
            mask[0, start:end] = True
            masks.append(mask)
        # IoU(A,B)=.8, IoU(B,C)=.5, IoU(A,C)=.3. A greedy winner
        # can hide B/C disagreement by putting C in a separate instance.
        for scores in itertools.permutations((0.9, 0.8, 0.7)):
            with self.subTest(scores=scores):
                items = [(index, scores[index], mask) for index, mask in enumerate(masks)]
                _, _, groups = self.group_items(items)
                self.assertEqual(len(groups), 1)
                self.assertEqual(groups[0]["memberIndices"], [0, 1, 2])
                self.assertEqual(groups[0]["pairCount"], 3)
                self.assertEqual(groups[0]["disagreementPairCount"], 2)
                self.assertEqual(groups[0]["worstPair"]["indices"], [0, 2])
                self.assertEqual(groups[0]["worstPair"]["iou"], 0.3)
                with self.assertRaises(segment.SegmentError) as failure:
                    self.run_fusion(items)
                self.assertEqual(failure.exception.code, "target_region_uncertain")

    def test_region_agreement_threshold_includes_point_eight(self):
        import numpy as np
        whole = np.zeros((1, 400), dtype=np.bool_)
        whole[0, :100] = True
        at_threshold = np.zeros_like(whole)
        at_threshold[0, :80] = True
        union, _, _ = self.run_fusion([(1, 0.9, at_threshold), (2, 0.8, whole)])
        np.testing.assert_array_equal(union, whole)
        below_threshold = at_threshold.copy()
        below_threshold[0, 79] = False
        with self.assertRaises(segment.SegmentError) as failure:
            self.run_fusion([(1, 0.9, below_threshold), (2, 0.8, whole)])
        self.assertEqual(failure.exception.code, "target_region_uncertain")

    def test_consistency_checks_the_pair_between_two_nonrepresentatives(self):
        import numpy as np
        masks = []
        for start, end in [(0, 100), (0, 85), (15, 100)]:
            mask = np.zeros((1, 400), dtype=np.bool_)
            mask[0, start:end] = True
            masks.append(mask)
        items = [(index, 0.9 - index * 0.1, mask) for index, mask in enumerate(masks)]
        _, _, groups = self.group_items(items)
        self.assertEqual(groups[0]["representativeIndex"], 0)
        self.assertEqual(groups[0]["pairCount"], 3)
        self.assertEqual(groups[0]["disagreementPairCount"], 1)
        self.assertEqual(groups[0]["worstPair"]["indices"], [1, 2])
        self.assertEqual(groups[0]["worstPair"]["iou"], 0.7)
        with self.assertRaises(segment.SegmentError) as failure:
            self.run_fusion(items)
        self.assertEqual(failure.exception.code, "target_region_uncertain")

    def test_saved_multiple_and_absent_target_boundaries_still_hold(self):
        import numpy as np
        for name, expected_failure in (("multiple-one", "target_ambiguous"),
                                       ("multiple-all", None), ("absent", "target_not_found")):
            with self.subTest(name=name):
                saved = FIXTURES[name]
                # The saved multi-object union equals the sum of candidate areas:
                # this is a lossless set-metric replay of their disjointness.
                self.assertEqual(sum(item["maskPixels"] for item in saved["candidates"]), saved["maskPixels"])
                offset = 0
                items = []
                for candidate in saved["candidates"]:
                    mask = np.zeros((1, saved["totalPixels"]), dtype=np.bool_)
                    mask[0, offset:offset + candidate["maskPixels"]] = True
                    offset += candidate["maskPixels"]
                    items.append((candidate["index"], candidate["score"], mask))
                _, packed, groups = self.group_items(items)
                union = segment.fuse_instance_masks(groups, packed, saved["totalPixels"])
                mask_pixels = int(np.unpackbits(union, count=saved["totalPixels"]).sum())
                failure = segment.region_failure(len(groups), mask_pixels, saved["totalPixels"], saved["selection"])
                if expected_failure is None:
                    self.assertIsNone(failure)
                else:
                    self.assertEqual(failure[0], expected_failure)

    def group_items(self, items):
        import numpy as np
        candidates = [{"index": index, "score": score, "maskPixels": int(mask.sum())}
                      for index, score, mask in items]
        packed = {index: np.packbits(mask) for index, _, mask in items}
        groups = segment.group_instance_masks(candidates, packed)
        return candidates, packed, groups

    def run_nms(self, items):
        candidates, _, groups = self.group_items(items)
        kept = [group["representativeIndex"] for group in groups]
        return kept, {candidate["index"]: candidate for candidate in candidates}

    def test_nested_duplicate_is_one_independent_instance(self):
        import numpy as np
        outer = np.ones((10, 10), dtype=np.bool_)
        inner = outer.copy()
        inner[:2] = False
        inner[:, :2] = False
        kept, candidates = self.run_nms([(8, 0.6, inner), (17, 0.7, outer)])
        self.assertEqual(kept, [17])
        self.assertEqual(candidates[8]["suppressedBy"], 17)
        self.assertEqual(candidates[8]["suppressionIoU"], 0.64)
        self.assertEqual(candidates[17]["decision"], "kept")
        self.assertIsNone(segment.region_failure(len(kept), 100, 1000, "one"))

    def test_distinct_instances_cannot_be_replaced_by_top_one(self):
        import numpy as np
        left = np.zeros((10, 10), dtype=np.bool_)
        left[:, :4] = True
        right = np.zeros((10, 10), dtype=np.bool_)
        right[:, 6:] = True
        kept, candidates = self.run_nms([(5, 0.6, left), (12, 0.9, right)])
        self.assertEqual(kept, [12, 5])
        self.assertTrue(all(candidate["decision"] == "kept" for candidate in candidates.values()))
        self.assertEqual(segment.region_failure(len(kept), 80, 1000, "one")[0], "target_ambiguous")
        self.assertIsNone(segment.region_failure(len(kept), 80, 1000, "all"))

    def test_nms_threshold_is_inclusive_and_tie_break_is_index(self):
        import numpy as np
        outer = np.ones((10, 10), dtype=np.bool_)
        half = outer.copy()
        half[:5] = False
        kept, candidates = self.run_nms([(20, 0.7, half), (3, 0.7, outer)])
        self.assertEqual(kept, [3])
        self.assertEqual(candidates[20]["suppressionIoU"], 0.5)
        self.assertEqual(candidates[20]["suppressedBy"], 3)

    def test_empty_candidate_never_counts_as_an_instance(self):
        import numpy as np
        kept, candidates = self.run_nms([(1, 0.9, np.zeros((8, 8), dtype=np.bool_))])
        self.assertEqual(kept, [])
        self.assertEqual(candidates[1]["decision"], "empty")

    def run_fusion(self, items):
        import numpy as np
        candidates, packed, groups = self.group_items(items)
        union = segment.fuse_instance_masks(groups, packed, items[0][2].size)
        return np.unpackbits(union, count=items[0][2].size).reshape(items[0][2].shape), groups, candidates

    def test_high_score_partial_mask_cannot_discard_same_instance_regions(self):
        import numpy as np
        outer = np.zeros((20, 20), dtype=np.bool_)
        outer[:10, :10] = True
        inner = np.zeros_like(outer)
        # IoU .9 is consistent under the new conservative refusal rule.
        # The prior .64 input is now covered by explicit refusal tests.
        inner[:9, :10] = True
        union, groups, candidates = self.run_fusion([(98, 0.9, inner), (104, 0.7, outer)])
        np.testing.assert_array_equal(union, outer)
        self.assertEqual(groups[0]["representativeIndex"], 98)
        self.assertEqual(groups[0]["memberIndices"], [98, 104])
        self.assertEqual(groups[0]["representativeMaskPixels"], 90)
        self.assertEqual(groups[0]["mergedMaskPixels"], 100)
        self.assertEqual(groups[0]["addedMaskPixels"], 10)
        self.assertEqual(groups[0]["disagreementPairCount"], 0)
        self.assertEqual(candidates[1]["suppressedBy"], 98)
        self.assertEqual(candidates[1]["suppressionIoU"], 0.9)
        self.assertIsNone(segment.region_failure(len(groups), int(union.sum()), union.size, "one"))

    def test_fused_distinct_instances_still_reject_one_and_preserve_all(self):
        import numpy as np
        left = np.zeros((20, 20), dtype=np.bool_)
        left[:10, :10] = True
        left_inner = np.zeros_like(left)
        left_inner[:9, :10] = True
        right = np.zeros_like(left)
        right[10:, 10:] = True
        right_inner = np.zeros_like(left)
        right_inner[11:, 10:] = True
        union, groups, _ = self.run_fusion([(4, 0.95, left_inner), (10, 0.7, left),
                                          (17, 0.9, right_inner), (20, 0.6, right)])
        np.testing.assert_array_equal(union, left | right)
        self.assertEqual([group["memberIndices"] for group in groups], [[4, 10], [17, 20]])
        self.assertEqual([group["mergedMaskPixels"] for group in groups], [100, 100])
        self.assertEqual(segment.region_failure(len(groups), int(union.sum()), union.size, "one")[0], "target_ambiguous")
        self.assertIsNone(segment.region_failure(len(groups), int(union.sum()), union.size, "all"))

    def test_no_candidate_fusion_is_empty(self):
        import numpy as np
        groups = segment.group_instance_masks([], {})
        union = segment.fuse_instance_masks(groups, {}, 25)
        self.assertEqual(groups, [])
        np.testing.assert_array_equal(np.unpackbits(union, count=25), np.zeros(25, dtype=np.uint8))

    def test_high_similarity_cannot_override_missing_presence(self):
        import torch
        score = segment.joint_scores(torch.tensor([[10.0, 9.0]]), torch.tensor([[-10.0]]))
        self.assertEqual(int((score >= segment.SCORE_THRESHOLD).sum()), 0)

    def test_high_presence_preserves_both_candidates(self):
        import torch
        score = segment.joint_scores(torch.tensor([[10.0, 9.0]]), torch.tensor([[10.0]]))
        count = int((score >= segment.SCORE_THRESHOLD).sum())
        self.assertEqual(count, 2)
        self.assertEqual(segment.region_failure(count, 100, 1000, "one")[0], "target_ambiguous")
        self.assertIsNone(segment.region_failure(count, 100, 1000, "all"))

    def test_invalid_presence_fails_closed(self):
        import torch
        for presence in (torch.tensor([[float("nan")]]), torch.ones((1, 2))):
            with self.assertRaises(segment.SegmentError):
                segment.joint_scores(torch.ones((1, 2)), presence)

    def test_region_rejects_empty_and_whole_frame(self):
        self.assertEqual(segment.region_failure(0, 0, 1000, "one")[0], "target_not_found")
        self.assertEqual(segment.region_failure(1, 0, 1000, "one")[0], "target_not_found")
        self.assertEqual(segment.region_failure(1, 1000, 1000, "one")[0], "mask_too_large")
        self.assertIsNone(segment.region_failure(1, 650, 1000, "one"))
        self.assertEqual(segment.region_failure(1, 651, 1000, "one")[0], "mask_too_large")

    def test_concept_cannot_override_cardinality(self):
        self.assertEqual(segment.validate_target(" blue cardigan "), "blue cardigan")
        for target in ("", "mug:2", "mug,cardigan", "mug\ncardigan", "a" * 161):
            with self.assertRaises(segment.SegmentError):
                segment.validate_target(target)

    def test_artifact_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mask.png"
            segment.write_new(path, b"first")
            with self.assertRaises(FileExistsError):
                segment.write_new(path, b"second")
            self.assertEqual(path.read_bytes(), b"first")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_missing_arguments_return_json_and_exit_two(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = segment.main([])
        self.assertEqual(code, 2)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["code"], "invalid_arguments")

    def test_uncertain_region_returns_structured_exit_three_before_mask_output(self):
        items, _ = self.saved_overlap_fixture("green-mug")

        def replay_saved_candidates(args, evidence):
            candidates, packed, groups = self.group_items(items)
            evidence.update(candidates=candidates, instanceGroups=groups,
                            rawCandidateCount=len(candidates), independentInstanceCount=len(groups))
            segment.fuse_instance_masks(groups, packed, items[0][2].size)

        arguments = ["--comfy-root", "/unused-comfy", "--checkpoint", "/unused.safetensors",
                     "--stdio", "--lease-fd", "3", "--parent-pid", str(os.getppid()),
                     "--target", "green mug", "--selection", "one"]
        output = io.StringIO()
        with mock.patch.object(segment, "watch_parent"), mock.patch.object(segment, "segment", side_effect=replay_saved_candidates), \
                mock.patch.object(segment, "write_new") as write, contextlib.redirect_stdout(output):
            code = segment.main(arguments)
        write.assert_not_called()
        self.assertEqual(code, 3)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["code"], "target_region_uncertain")
        self.assertEqual(result["instanceMaskAgreementThreshold"], 0.8)
        self.assertEqual(result["instanceMaskAgreementPolicy"], "conservative-rejection-only")
        self.assertFalse(result["maskCorrectnessCertified"])
        self.assertEqual(result["instanceGroups"][0]["worstPair"]["disputedPixels"], 7565)
        self.assertNotIn("mergedMaskPixels", result["instanceGroups"][0])
        self.assertNotIn("maskPngBase64", result)
        self.assertNotIn("maskSha256", result)

    def test_stdin_png_is_decoded_without_output_files(self):
        from PIL import Image
        source = io.BytesIO()
        Image.new("RGB", (7, 5), "green").save(source, format="PNG")
        output = io.StringIO()
        source.seek(0)
        arguments = ["--comfy-root", "/missing-comfy", "--checkpoint", "/missing-checkpoint.safetensors",
                     "--stdio", "--lease-fd", "3", "--parent-pid", str(os.getppid()),
                     "--target", "green mug", "--selection", "one"]
        with mock.patch.object(segment, "watch_parent") as guard, mock.patch("sys.stdin", io.TextIOWrapper(source)), contextlib.redirect_stdout(output):
            code = segment.main(arguments)
        guard.assert_called_once_with(os.getppid(), 3)
        self.assertEqual(code, 2)
        result = json.loads(output.getvalue())
        self.assertEqual(result["code"], "checkpoint_missing")
        self.assertEqual((result["width"], result["height"]), (7, 5))
        self.assertEqual(len(result["sourceSha256"]), 64)

    def test_stdio_rejects_jpeg_and_empty_source(self):
        from PIL import Image
        source = io.BytesIO()
        Image.new("RGB", (7, 5), "green").save(source, format="JPEG")
        for data in (source.getvalue(), b""):
            with self.assertRaises(segment.SegmentError) as failure:
                segment.read_source(data, {}, png_only=True)
            self.assertEqual(failure.exception.code, "invalid_source")

    def test_stdio_requires_owner_and_rejects_file_paths(self):
        base = ["--comfy-root", "/missing-comfy", "--checkpoint", "/missing-checkpoint.safetensors",
                "--stdio", "--target", "mug", "--selection", "one"]
        for extra in ([], ["--source", "/source.png", "--lease-fd", "3", "--parent-pid", str(os.getppid())]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = segment.main(base + extra)
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(output.getvalue())["code"], "invalid_arguments")

    def test_parent_watchdog_rejects_invalid_owner_or_lease(self):
        for parent_pid, fd, error in [(os.getpid(), 3, "invalid_parent"), (os.getppid(), 0, "invalid_lease"),
                                      (os.getppid(), 9999999, "invalid_lease")]:
            with self.assertRaises(segment.SegmentError) as failure:
                segment.watch_parent(parent_pid, fd)
            self.assertEqual(failure.exception.code, error)


if __name__ == "__main__":
    unittest.main()
