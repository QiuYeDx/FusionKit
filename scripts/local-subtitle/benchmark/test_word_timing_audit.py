import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("word-timing-audit.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def segment(text="私だ。", start=2, end=4, words=None):
    return {"start": start, "end": end, "text": text,
            "words": words if words is not None else [{"word": text, "start": start, "end": end}]}


class WordTimingAuditTests(unittest.TestCase):
    def kinds(self, segments):
        return {f["kind"] for f in module.audit_word_timing(segments, 30)["findings"]}

    def test_ordered_exact_text_does_not_authorize_acceptance(self):
        result = module.audit_word_timing([segment()], 30)
        self.assertEqual(result["findings"], [])
        self.assertFalse(result["automaticAcceptance"])

    def test_zero_duration_and_nonfinite_word_ranges(self):
        for end in [2, float("nan"), float("inf")]:
            self.assertIn("invalid_word_range", self.kinds([segment(words=[{"word": "私だ。", "start": 2, "end": end}])]))

    def test_lost_punctuation_is_not_hidden_by_normalization(self):
        self.assertIn("word_text_coverage_mismatch", self.kinds([segment(words=[{"word": "私だ", "start": 2, "end": 4}])]))

    def test_outside_parent_and_reversed_segments(self):
        self.assertIn("invalid_word_range", self.kinds([segment(words=[{"word": "私だ。", "start": 0, "end": 4}])]))
        self.assertIn("segment_overlap_or_reverse", self.kinds([segment(start=4, end=5), segment()]))

    def test_long_span_requires_review(self):
        self.assertIn("long_word_review", self.kinds([segment(start=0, end=24)]))

    def test_no_text_is_not_proof_of_silence(self):
        result = module.audit_word_timing([], 18)
        self.assertFalse(result["automaticAcceptance"])
        self.assertEqual(result["evidence"], "structural_review_only")


if __name__ == "__main__":
    unittest.main()
