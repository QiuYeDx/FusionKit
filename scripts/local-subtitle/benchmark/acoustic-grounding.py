"""Offline fixed-text audio ablation diagnostics. Never exports replacement subtitles."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import time
import wave

SAMPLE_RATE = 16000
MAX_ENCODINGS = 32
MAX_SCORES = 48


def file_hash(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def mask_audio(audio, start_ms, end_ms, fade_ms=10):
    """Keep length/origin unchanged and only attenuate the specified interval."""
    import numpy as np
    if not all(type(value) is int for value in (start_ms, end_ms, fade_ms)):
        raise ValueError('Mask bounds must be integer milliseconds')
    start, end = start_ms * 16, end_ms * 16
    if not 0 <= start < end <= len(audio) or fade_ms < 0:
        raise ValueError('Invalid mask bounds')
    result = audio.copy()
    gain = np.zeros(end - start, dtype=np.float32)
    fade = min(fade_ms * 16, len(gain) // 2)
    if fade:
        gain[:fade] = np.linspace(1, 0, fade, endpoint=False)
        gain[-fade:] = np.linspace(0, 1, fade, endpoint=True)
    result[start:end] *= gain
    return result


def score_summary(probabilities):
    values = [float(value) for value in probabilities]
    if not values or any(not math.isfinite(value) or not 0 <= value <= 1 for value in values):
        raise ValueError('Invalid conditional probabilities')
    logs = [math.log(max(value, 1e-12)) for value in values]
    return {'tokenProbabilities': values, 'meanLogProbability': sum(logs) / len(logs),
            'firstTokenLogProbability': logs[0], 'logFloor': 1e-12}


def validate_manifest(manifest):
    groups = manifest.get('groups')
    if not isinstance(groups, list) or not 1 <= len(groups) <= 8:
        raise ValueError('Expected 1-8 groups')
    ids, encodings, scores = set(), 0, 0
    for group in groups:
        if not isinstance(group.get('id'), str) or not group['id'] or group['id'] in ids:
            raise ValueError('Invalid group identity')
        ids.add(group['id'])
        if type(group.get('originMs')) is not int or group['originMs'] < 0:
            raise ValueError('Invalid audio origin')
        digest = group.get('audioSha256', '')
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('Invalid audio fingerprint')
        texts, masks = group.get('texts'), group.get('masks')
        if not isinstance(texts, list) or not 1 <= len(texts) <= 4 or not isinstance(masks, list) or len(masks) > 20:
            raise ValueError('Invalid experiment groups')
        text_ids = set()
        for text in texts:
            if not isinstance(text.get('id'), str) or not text['id'] or text['id'] in text_ids or not isinstance(text.get('text'), str) or not 0 < len(text['text']) <= 500:
                raise ValueError('Invalid fixed text')
            text_ids.add(text['id'])
        for mask in masks:
            if not isinstance(mask, list) or len(mask) != 2 or any(type(value) is not int for value in mask) or not 0 <= mask[0] < mask[1] <= 30000:
                raise ValueError('Invalid mask range')
        encodings += 2 + len(masks)
        scores += (2 + len(masks)) * len(texts)
    if encodings > MAX_ENCODINGS or scores > MAX_SCORES:
        raise ValueError('Ablation budget exceeded')
    return encodings, scores


def summarize_group(group):
    """Within-text log-score contrasts; no cross-text probability or onset claim."""
    original, silence = group['conditions'][:2]
    summary = []
    for index, fixed in enumerate(group['texts']):
        base = original['scores'][index]
        silent = silence['scores'][index]
        masks = []
        for condition in group['conditions'][2:]:
            score = condition['scores'][index]
            masks.append({
                'clipBoundsMs': [group['originMs'] + value for value in condition['maskMs']],
                'meanLogDrop': base['meanLogProbability'] - score['meanLogProbability'],
                'firstTokenLogDrop': base['firstTokenLogProbability'] - score['firstTokenLogProbability'],
            })
        delta = base['meanLogProbability'] - silent['meanLogProbability']
        strongest = max(masks, key=lambda item: item['firstTokenLogDrop'], default=None)
        summary.append({'textId': fixed['id'], 'realMeanLogProbability': base['meanLogProbability'],
                        'silenceMeanLogProbability': silent['meanLogProbability'],
                        'realMinusSilence': delta, 'masks': masks,
                        'strongestFirstTokenMask': strongest,
                        'interpretation': 'audio_dependence_requires_review' if delta > 0 else 'no_positive_contrast_to_silence',
                        'automaticReplacementAllowed': False})
    return summary


def validate_output(output, model_dir, inputs):
    resolved = output.resolve()
    if resolved == model_dir.resolve() or model_dir.resolve() in resolved.parents or resolved in {item.resolve() for item in inputs}:
        raise ValueError('Output cannot overwrite an input or model')


def run(manifest_path, model_dir, receipt_path, output):
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    import numpy as np
    from faster_whisper import WhisperModel
    from faster_whisper.audio import pad_or_trim
    from faster_whisper.tokenizer import Tokenizer
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    expected_encodings, expected_scores = validate_manifest(manifest)
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    validate_output(output, model_dir, [manifest_path, receipt_path, *(Path(group['file']) for group in manifest['groups'])])
    for item in receipt['files']:
        model_file = (model_dir / item['file']).resolve()
        if model_file.parent != model_dir.resolve() or file_hash(model_file) != item['sha256']:
            raise ValueError('Model identity mismatch')
    model = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=8, local_files_only=True)
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task='transcribe', language='ja')
    report = {'method': 'fixed_text_audio_ablation', 'modelRevision': receipt['revision'],
              'acousticTruth': 'unverified', 'automaticReplacementAllowed': False,
              'encodings': 0, 'scores': 0, 'groups': []}
    for group in manifest['groups']:
        source = Path(group['file'])
        if file_hash(source) != group['audioSha256']:
            raise ValueError('Audio identity mismatch')
        with wave.open(str(source), 'rb') as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != SAMPLE_RATE or not 0 < wav.getnframes() <= 30 * SAMPLE_RATE:
                raise ValueError('Expected bounded PCM16 mono 16kHz')
            audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
        tokens = [tokenizer.encode(text['text']) for text in group['texts']]
        for fixed, text in zip(tokens, group['texts']):
            if not 0 < len(fixed) <= 200 or tokenizer.decode(fixed) != text['text']:
                raise ValueError('Fixed token roundtrip failed')
        variants = [('original', None), ('silence', None)] + [('mask', mask) for mask in group['masks']]
        group_result = {key: group[key] for key in ['id','originMs','audioSha256','texts']}
        group_result['conditions'] = []
        for kind, mask in variants:
            started = time.monotonic()
            signal = audio if kind == 'original' else np.zeros_like(audio) if kind == 'silence' else mask_audio(audio, *mask)
            features = model.feature_extractor(signal)
            encoded = model.encode(pad_or_trim(features))
            report['encodings'] += 1
            values = []
            for fixed in tokens:
                aligned = model.model.align(encoded, tokenizer.sot_sequence, [fixed], [len(audio) // 160])[0]
                probabilities = list(aligned.text_token_probs)
                if len(probabilities) != len(fixed):
                    raise ValueError('Unexpected token evidence count')
                values.append(score_summary(probabilities))
                report['scores'] += 1
            group_result['conditions'].append({'kind':kind,'maskMs':mask,'scores':values,'elapsedMs':round((time.monotonic()-started)*1000)})
            print(json.dumps({'group':group['id'],'condition':kind,'maskMs':mask,'encodings':report['encodings'],'scores':report['scores']}), flush=True)
        group_result['inputUnchanged'] = file_hash(source) == group['audioSha256']
        if not group_result['inputUnchanged']:
            raise ValueError('Audio input changed')
        group_result['summary'] = summarize_group(group_result)
        report['groups'].append(group_result)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    assert report['encodings'] == expected_encodings and report['scores'] == expected_scores
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['manifest', 'model', 'receipt', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    run(args.manifest,args.model,args.receipt,args.output)
