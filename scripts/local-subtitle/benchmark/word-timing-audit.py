"""Offline structural audit. Passing does not establish speech presence or accuracy."""
import argparse
import json
import math
from pathlib import Path


def audit_word_timing(segments, duration_seconds, long_word_seconds=2.0):
    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    if not finite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("invalid media duration")
    if not finite(long_word_seconds) or long_word_seconds <= 0:
        raise ValueError("invalid diagnostic threshold")
    if not isinstance(segments, list):
        raise ValueError("invalid segments")
    findings = []
    words_count = 0
    longest = 0.0
    previous_segment_end = 0.0
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise ValueError("invalid segment")
        start, end = segment.get("start"), segment.get("end")
        if not finite(start) or not finite(end) or not 0 <= start < end <= duration_seconds + 1e-6:
            findings.append({"segment": index, "kind": "invalid_segment_range"})
            continue
        if start < previous_segment_end - 1e-6:
            findings.append({"segment": index, "kind": "segment_overlap_or_reverse"})
        previous_segment_end = end
        text = segment.get("text")
        words = segment.get("words")
        if not isinstance(text, str) or not isinstance(words, list) or not words:
            findings.append({"segment": index, "kind": "missing_text_or_words"})
            continue
        pieces = []
        previous_end = start
        for word_index, word in enumerate(words):
            if not isinstance(word, dict) or not isinstance(word.get("word"), str):
                findings.append({"segment": index, "word": word_index, "kind": "invalid_word"})
                continue
            pieces.append(word["word"])
            words_count += 1
            left, right = word.get("start"), word.get("end")
            if not finite(left) or not finite(right) or not start - 1e-6 <= left < right <= end + 1e-6:
                findings.append({"segment": index, "word": word_index, "kind": "invalid_word_range"})
                continue
            if left < previous_end - 1e-6:
                findings.append({"segment": index, "word": word_index, "kind": "word_overlap_or_reverse"})
            previous_end = right
            longest = max(longest, right - left)
            if right - left > long_word_seconds:
                findings.append({"segment": index, "word": word_index, "kind": "long_word_review"})
        # Preserve punctuation; normalization only permits outer decoder whitespace.
        if "".join(pieces).strip() != text.strip():
            findings.append({"segment": index, "kind": "word_text_coverage_mismatch"})
    return {
        "evidence": "structural_review_only",
        "segmentCount": len(segments), "wordCount": words_count,
        "longestWordSeconds": round(longest, 6),
        "longWordReviewThresholdSeconds": long_word_seconds,
        "findings": findings,
        "automaticAcceptance": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("response", type=Path)
    parser.add_argument("--duration", type=float, required=True)
    args = parser.parse_args()
    body = json.loads(args.response.read_text(encoding="utf-8"))
    print(json.dumps(audit_word_timing(body["segments"], args.duration), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
