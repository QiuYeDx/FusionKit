import importlib.util
import math
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('grounding', Path(__file__).with_name('acoustic-grounding.py'))
grounding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grounding)


class GroundingTests(unittest.TestCase):
    def test_mask_preserves_source_length_and_outside_samples(self):
        source = np.ones(16000, dtype=np.float32)
        result = grounding.mask_audio(source, 400, 600)
        np.testing.assert_array_equal(source, np.ones_like(source))
        np.testing.assert_array_equal(result[:6400], source[:6400])
        np.testing.assert_array_equal(result[9600:], source[9600:])
        self.assertEqual(len(source), len(result))
        self.assertTrue(np.all(result[6560:9440] == 0))
        self.assertTrue(np.all((result >= 0) & (result <= 1)))
        self.assertEqual(result[6400], 1)
        self.assertEqual(result[9599], 1)

    def test_bad_mask_bounds_fail_instead_of_clipping(self):
        for bounds in [(-1, 100), (0, 1001), (100, 100), (float('nan'), 10)]:
            with self.assertRaises(ValueError):
                grounding.mask_audio(np.zeros(16000), *bounds)

    def test_scores_keep_zero_probability_evidence_and_have_finite_log_floor(self):
        result = grounding.score_summary([0, 0.5, 1])
        self.assertEqual(result['tokenProbabilities'], [0, 0.5, 1])
        self.assertTrue(math.isfinite(result['meanLogProbability']))
        self.assertAlmostEqual(result['firstTokenLogProbability'], math.log(1e-12))
        for values in [[], [float('nan')], [float('inf')], [-.1], [1.1]]:
            with self.assertRaises(ValueError):
                grounding.score_summary(values)

    def test_budgets_count_each_text_scored_against_each_audio_condition(self):
        group = {'id':'one','originMs':20000,'audioSha256':'a'*64,
                 'texts':[{'id':'a','text':'one'},{'id':'b','text':'two'}],
                 'masks':[[1000,1500]]}
        self.assertEqual(grounding.validate_manifest({'groups':[group]}), (3,6))
        with self.assertRaisesRegex(ValueError, 'budget'):
            grounding.validate_manifest({'groups':[{**group,'id':str(i),'masks':[[1000,1500]]*10} for i in range(3)]})
        with self.assertRaises(ValueError):
            grounding.validate_manifest({'groups':[group,group]})
        with self.assertRaises(ValueError):
            grounding.validate_manifest({'groups':[{**group,'audioSha256':'not-a-hash'}]})

    def test_positive_audio_contrast_is_not_automatic_word_verification(self):
        group={'originMs':20000,'texts':[{'id':'noise'}],'conditions':[
            {'scores':[grounding.score_summary([.4,.5])]},
            {'scores':[grounding.score_summary([.1,.2])]},
            {'maskMs':[3000,3500],'scores':[grounding.score_summary([.2,.4])]},
        ]}
        summary=grounding.summarize_group(group)[0]
        self.assertEqual(summary['interpretation'],'audio_dependence_requires_review')
        self.assertFalse(summary['automaticReplacementAllowed'])
        self.assertEqual(summary['strongestFirstTokenMask']['clipBoundsMs'],[23000,23500])
        group['conditions'][0],group['conditions'][1]=group['conditions'][1],group['conditions'][0]
        self.assertEqual(grounding.summarize_group(group)[0]['interpretation'],'no_positive_contrast_to_silence')

    def test_output_cannot_overwrite_source_manifest_or_model(self):
        model=Path('test-model')
        source=Path('test-input.wav')
        for output in [source,model,model/'model.bin']:
            with self.assertRaises(ValueError):
                grounding.validate_output(output,model,[source])
        grounding.validate_output(Path('test-results.json'),model,[source])


if __name__ == '__main__':
    unittest.main()
