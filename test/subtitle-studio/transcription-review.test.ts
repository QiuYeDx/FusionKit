import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { transcriptToDocument } from '../../electron/main/subtitle-studio/transcription/document-adapter';
import type { MediaSubtitleDocument } from '../../src/subtitle-studio/domain';
import {
  CUE_REVIEW_PHANTOM_PHRASES, CUE_REVIEW_THRESHOLDS, collapseRepetition, cueReviewIgnoreKey, documentReviewLanguage, reviewCue, reviewDocument,
  reviewLanguage, reviewPosition, reviewStep, reviewText, visibleReview, type CueReviewInput,
} from '../../src/subtitle-studio/transcription-review';
import { cueReviewIgnores } from '../../src/services/subtitle-studio/cue-review-ignores';

const zlib = (text: string) => deflateSync(Buffer.from(text, 'utf8')).length;
const cue = (text: string, durationMs = 3000, extra: Partial<CueReviewInput> = {}): CueReviewInput => ({ text, startMs: 10_000, endMs: 10_000 + durationMs, edited: false, language: 'ja', ...extra });
type Segment = { text: string; startMs: number; endMs: number; confidence?: number };
function media(segments: Segment[], extra: Record<string, unknown> = {}): MediaSubtitleDocument {
  return transcriptToDocument({ schemaVersion: 1, source: { displayName: 'Review.wav', durationMs: 600_000 },
    model: { engine: 'whisper_cpp', modelId: 'large-v3', modelHash: 'a'.repeat(64), backend: 'cuda' }, ...extra,
    segments: segments.map((segment, index) => ({ id: `s${index}`, ...segment })) }, { newId: randomUUID });
}

describe('transcription review rules', () => {
  it('flags the requirement samples as phantom phrase, non-speech, repetition and rate, and leaves an ordinary line alone (AC-ASRQ-03-2)', () => {
    expect(reviewCue(cue('ご視聴ありがとうございました', 2500, { confidence: 0.31 }))).toEqual(['low_confidence', 'phantom_phrase']);
    expect(reviewCue(cue('♪～♪', 2000, { confidence: 0.62 }))).toEqual(['non_speech_only']);
    expect(reviewCue(cue('あああああああああああ', 3000, { confidence: 0.7 }))).toEqual(['repetition_loop']);
    // 21 characters in one second, far past 12 per second.
    expect(reviewCue(cue('今日はとても良い天気ですね本当にそう思います', 1000, { confidence: 0.88 }))).toEqual(['abnormal_rate']);
    expect(reviewCue(cue('今日はとても良い天気ですね。', 2500, { confidence: 0.88 }))).toEqual([]);
    // The same samples with the main process's compressor give the same answers.
    for (const [text, durationMs, reasons] of [['ご視聴ありがとうございました', 2500, ['phantom_phrase']], ['♪～♪', 2000, ['non_speech_only']],
      ['あああああああああああ', 3000, ['repetition_loop']], ['今日はとても良い天気ですね。', 2500, []]] as const) {
      expect(reviewCue(cue(text, durationMs), zlib)).toEqual(reasons);
    }
  });

  it('uses confidence only on unedited cues that have one, below the threshold', () => {
    const threshold = CUE_REVIEW_THRESHOLDS.lowConfidence;
    expect(reviewCue(cue('そうなんですか', 1500, { confidence: threshold - 0.001 }))).toEqual(['low_confidence']);
    expect(reviewCue(cue('そうなんですか', 1500, { confidence: threshold }))).toEqual([]);
    // Edited: the confidence described the recognized text, not this one.
    expect(reviewCue(cue('そうなんですか', 1500, { confidence: 0.1, edited: true }))).toEqual([]);
    // An older transcript without confidence: text rules only.
    expect(reviewCue(cue('そうなんですか', 1500))).toEqual([]);
    expect(reviewCue(cue('ご視聴ありがとうございました', 2500, { edited: true }))).toEqual(['phantom_phrase']);
    // The values calibrated on the large-v3 A/B run (records/T-ASRQ-09.md): B-noise's made-up loop scored 0.51.
    expect(CUE_REVIEW_THRESHOLDS).toMatchObject({ lowConfidence: 0.55, cjkMaxRate: 12, otherMaxRate: 30, slowMinDurationMs: 10_000, slowMaxRate: 0.8 });
    expect(reviewCue(cue('しっかりと', 2000, { confidence: 0.51 }))).toEqual(['low_confidence']);
  });

  it('matches phantom phrases per language after normalizing, and not common real lines', () => {
    expect(reviewText('Thanks  for Watching！')).toBe('thanksforwatching');
    // Full-width letters and half-width kana match after NFKC.
    expect(reviewText('ｻﾌﾞｽｸ ＴＨＡＮＫＳ')).toBe('サブスクthanks');
    expect(reviewCue(cue('Ｔｈａｎｋｓ ｆｏｒ ｗａｔｃｈｉｎｇ', 2000, { language: 'en' }))).toEqual(['phantom_phrase']);
    expect(reviewCue(cue('最後までご視聴いただきありがとうございました。'))).toEqual(['phantom_phrase']);
    expect(reviewCue(cue('チャンネル登録よろしくお願いします'))).toEqual(['phantom_phrase']);
    expect(reviewCue(cue('字幕由Amara.org社区提供', 3000, { language: 'zh' }))).toEqual(['phantom_phrase']);
    expect(reviewCue(cue('请不吝点赞 订阅 转发 打赏支持明镜与点点栏目', 4000, { language: 'zh' }))).toEqual(['phantom_phrase']);
    expect(reviewCue(cue('感謝觀看', 2000, { language: 'zh' }))).toEqual(['phantom_phrase']);
    // A made-up English ending in a Japanese document is found by its own script.
    expect(reviewCue(cue('Thanks for watching!', 2000))).toEqual(['phantom_phrase']);
    expect(reviewCue(cue('Subtitles by the Amara.org community', 3000, { language: 'en' }))).toEqual(['phantom_phrase']);
    for (const text of ['おやすみなさい', 'ありがとう', 'ありがとうございました', '谢谢大家', 'Thank you.', 'ご視聴の皆さん、こんにちは']) {
      expect(reviewCue(cue(text, 2000)), text).toEqual([]);
    }
    for (const patterns of Object.values(CUE_REVIEW_PHANTOM_PHRASES)) {
      for (const pattern of patterns) for (const line of ['おやすみなさい', 'ありがとう', '谢谢', 'thankyou']) expect(pattern.test(line), `${pattern} ${line}`).toBe(false);
    }
  });

  it('finds repetition loops by repeated units and, with a compressor, by the deflate ratio', () => {
    expect(reviewCue(cue('はい、はい、はい、はい'))).toEqual(['repetition_loop']);
    expect(reviewCue(cue('しゅりゅくぷぷぷぷぷぷぷぷぷぷぷ'))).toEqual(['repetition_loop']);
    // Doubled words and three repeats are ordinary speech, and a run that covers too little is not a loop.
    expect(reviewCue(cue('はいはい'))).toEqual([]);
    expect(reviewCue(cue('うんうんうん'))).toEqual([]);
    expect(reviewCue(cue('ああああ、そういうことだったんですね、なるほど', 4000))).toEqual([]);
    // A long phrase looping three times: no unit of ten or fewer repeats four times, but it deflates far better than 2.4 : 1.
    const loop = 'あなたのことが好きです、ずっと前から'.repeat(4);
    expect(reviewCue(cue(loop, 9000))).toEqual([]);
    expect(reviewCue(cue(loop, 9000), zlib)).toEqual(['repetition_loop']);
    expect(reviewCue(cue('昨日の夜、駅前の本屋で新しい小説を買ってから家に帰りました', 6000), zlib)).toEqual([]);
  });

  it('marks symbol-only lines and bracketed notes as non-speech, but not lines with speech beside a note', () => {
    for (const text of ['（笑）', '【音楽】', '[拍手]', '♪', '……', '(BGM) ♪']) expect(reviewCue(cue(text, 2000)), text).toEqual(['non_speech_only']);
    expect(reviewCue(cue('(笑)ありがとう', 2000))).toEqual([]);
    expect(reviewCue(cue('♪ 君の名前を呼んだ ♪', 3000))).toEqual([]);
    // A long note is not also counted as a slow line: there is no speech to time.
    expect(reviewCue(cue('【音楽】', 15_000))).toEqual(['non_speech_only']);
  });

  it('flags speech too fast for its script, and long cues with almost no text', () => {
    const kana = (chars: number) => 'いろはにほへとちりぬるをわかよたれそつねならむ'.slice(0, chars);
    expect(reviewCue(cue(kana(12), 1000))).toEqual([]);
    expect(reviewCue(cue(kana(13), 1000))).toEqual(['abnormal_rate']);
    // Slow: under 0.8 characters per second from 10 s on (T-ASRQ-09's drama opening: 8 characters in 12.5 s); a shorter cue is not judged.
    expect(reviewCue(cue('お母さんお客さん', 12_500))).toEqual(['abnormal_rate']);
    expect(reviewCue(cue('お母さんお客さん', 9_900))).toEqual([]);
    expect(reviewCue(cue('the quick brown fox jumps over', 1000, { language: 'en' }))).toEqual([]);
    expect(reviewCue(cue('the quick brown fox jumps over the lazy dog again', 1000, { language: 'en' }))).toEqual(['abnormal_rate']);
    expect(reviewCue(cue('うん', 12_000))).toEqual(['abnormal_rate']);
    expect(reviewCue(cue('うん', 9_000))).toEqual([]);
    expect(reviewCue(cue('こんにちは', 0))).toEqual(['abnormal_rate']);
    // A text cue without an end has no rate.
    expect(reviewCue({ text: 'うん', startMs: 0, endMs: null, edited: false })).toEqual([]);
  });

  it('flags a line repeating the one before it shortly after', () => {
    const previous = { text: 'そうなんですね。', startMs: 8000, endMs: 9500 };
    expect(reviewCue(cue('そうなんですね', 2000, { previous }))).toEqual(['duplicate_neighbor']);
    expect(reviewCue(cue('そうなんですね', 2000, { previous: { ...previous, endMs: 9000 } }))).toEqual([]);
    expect(reviewCue(cue('はい', 2000, { previous: { text: 'はい', startMs: 9000, endMs: 9900 } }))).toEqual([]);
  });

  it('collapses the longest repetition to one unit and keeps what follows', () => {
    expect(collapseRepetition('あああああああああああ')).toBe('あ');
    expect(collapseRepetition('はい、はい、はい、はい。')).toBe('はい。');
    expect(collapseRepetition('しゅりゅくぷぷぷぷぷぷぷぷぷぷぷ')).toBe('しゅりゅくぷ');
    expect(collapseRepetition('ねえ、あなたのことが好きです、あなたのことが好きです、あなたのことが好きです')).toBe('ねえ、あなたのことが好きです');
    expect(collapseRepetition('Thank you, thank you, thank you, thank you!')).toBe('Thank you!');
    expect(collapseRepetition('今日はとても良い天気ですね。')).toBeNull();
    expect(collapseRepetition('はいはい')).toBeNull();
  });

  it('reads the language from the transcript, the audio track or the script', () => {
    expect(['ja', 'jpn', 'Japanese', 'zh-CN', 'cmn', 'eng', 'fr', undefined].map(reviewLanguage)).toEqual(['ja', 'ja', 'ja', 'zh', 'zh', 'en', undefined, undefined]);
    expect(documentReviewLanguage(media([{ text: '谢谢', startMs: 0, endMs: 1000 }], { detectedLanguage: 'ja' }))).toBe('ja');
    const tracked = media([{ text: '谢谢', startMs: 0, endMs: 1000 }]);
    expect(documentReviewLanguage({ ...tracked, origin: { ...tracked.origin, audioTrack: { ordinal: 2, language: 'jpn' } } })).toBe('ja');
    expect(documentReviewLanguage(media([{ text: '他说了什么', startMs: 0, endMs: 1000 }, { text: '我不知道', startMs: 1000, endMs: 2000 }, { text: 'はい', startMs: 2000, endMs: 3000 }]))).toBe('zh');
  });
});

describe('reviewing a whole document', () => {
  const segments: Segment[] = [
    { text: '先輩、おはようございます。', startMs: 0, endMs: 2000, confidence: 0.91 },
    { text: 'ご視聴ありがとうございました', startMs: 2000, endMs: 4000, confidence: 0.3 },
    { text: '♪～♪', startMs: 4000, endMs: 6000, confidence: 0.8 },
    { text: 'まだ朝なのに。', startMs: 6000, endMs: 8000, confidence: 0.2 },
    { text: 'あああああああああああ', startMs: 8000, endMs: 11_000, confidence: 0.6 },
    { text: '今日はとても良い天気ですね本当にそう思います', startMs: 11_000, endMs: 12_000, confidence: 0.86 },
    { text: 'そうなんですね', startMs: 12_000, endMs: 13_000, confidence: 0.9 },
    { text: 'そうなんですね', startMs: 13_200, endMs: 14_000, confidence: 0.9 },
  ];

  it('lists flagged cues in document order with per-reason counts and the confidence used', () => {
    const doc = media(segments);
    const result = reviewDocument(doc, { compressedSize: zlib });
    expect(result.cues.map(entry => [entry.index, entry.reasons, entry.confidence])).toEqual([
      [1, ['low_confidence', 'phantom_phrase'], 0.3], [2, ['non_speech_only'], 0.8], [3, ['low_confidence'], 0.2], [4, ['repetition_loop'], 0.6],
      [5, ['abnormal_rate'], 0.86], [7, ['duplicate_neighbor'], 0.9]]);
    expect(result.cues.map(entry => entry.cueId)).toEqual([1, 2, 3, 4, 5, 7].map(index => doc.cues[index].id));
    expect(result).toMatchObject({ total: 6, truncated: false, confidence: true,
      counts: { low_confidence: 2, phantom_phrase: 1, repetition_loop: 1, non_speech_only: 1, abnormal_rate: 1, duplicate_neighbor: 1 } });
    // Deterministic: the same document gives the same result.
    expect(reviewDocument(doc, { compressedSize: zlib })).toEqual(result);
  });

  it('drops confidence for edited, split and inserted cues, which may share a segment', () => {
    const doc = media(segments);
    // Edited: same text checks, no confidence. Split: the second half shares the first half's segment.
    doc.cues[3] = { ...doc.cues[3], sourceRevision: 2, source: { plain: 'まだ朝なのに！', spans: [{ text: 'まだ朝なのに！', marks: [] }] } };
    const half = { ...doc.cues[1], id: randomUUID(), sourceRevision: 2, timingRevision: 2, timing: { ...doc.cues[1].timing, startMs: 3000 }, source: { plain: 'ました', spans: [{ text: 'ました', marks: [] }] } };
    doc.cues[1] = { ...doc.cues[1], sourceRevision: 2, timingRevision: 2, timing: { ...doc.cues[1].timing, endMs: 3000 }, source: { plain: 'ご視聴ありがとうござい', spans: [{ text: 'ご視聴ありがとうござい', marks: [] }] } };
    doc.cues.splice(2, 0, half);
    const result = reviewDocument(doc, { compressedSize: zlib });
    expect(result.cues.find(entry => entry.cueId === doc.cues[4].id)).toBeUndefined();
    expect(result.cues.filter(entry => entry.cueId === doc.cues[1].id || entry.cueId === half.id)).toEqual([]);
    expect(result.counts.low_confidence).toBe(0);
    expect(result.cues.every(entry => entry.confidence === undefined || doc.cues[entry.index].sourceRevision === 1)).toBe(true);
  });

  it('reviews an older document without confidence by its text alone', () => {
    const doc = media(segments.map(({ confidence: _, ...segment }) => segment));
    const result = reviewDocument(doc, { compressedSize: zlib });
    expect(result.confidence).toBe(false);
    expect(result.counts.low_confidence).toBe(0);
    expect(result.cues.map(entry => entry.index)).toEqual([1, 2, 4, 5, 7]);
    expect(result.cues.every(entry => entry.confidence === undefined)).toBe(true);
  });

  it('caps the listed cues but counts them all, and hides ignored flags until the text changes', () => {
    const many = media(Array.from({ length: 30 }, (_, index) => ({ text: `第${index}句です`, startMs: index * 2000, endMs: index * 2000 + 1500, confidence: 0.2 })));
    const capped = reviewDocument(many, { limit: 10 });
    expect(capped).toMatchObject({ total: 30, truncated: true, counts: { low_confidence: 30 } });
    expect(capped.cues.map(entry => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const result = reviewDocument(media(segments), { compressedSize: zlib });
    const ignored = new Set([cueReviewIgnoreKey(result.cues[0]), cueReviewIgnoreKey(result.cues[2]), `${result.cues[3].cueId}:2`]);
    const visible = visibleReview(result, ignored);
    expect(visible.cues.map(entry => entry.index)).toEqual([2, 4, 5, 7]);
    expect(visible).toMatchObject({ total: 4, counts: { low_confidence: 0, phantom_phrase: 0, non_speech_only: 1, repetition_loop: 1 } });
    expect(visibleReview(result, ignored, 'repetition_loop').cues.map(entry => entry.index)).toEqual([4]);
    expect(visibleReview(result, new Set(), 'low_confidence').cues.map(entry => entry.index)).toEqual([1, 3]);
  });

  it('keeps ignores per document, for the session when storage is unavailable, until they are restored', () => {
    // No localStorage here: reading and writing it throws, so ignores last for the session.
    expect(cueReviewIgnores.read('doc-a').size).toBe(0);
    cueReviewIgnores.add('doc-a', 'cue-1:1');
    expect([...cueReviewIgnores.add('doc-a', 'cue-2:1')]).toEqual(['cue-1:1', 'cue-2:1']);
    expect([...cueReviewIgnores.read('doc-a')]).toEqual(['cue-1:1', 'cue-2:1']);
    expect(cueReviewIgnores.read('doc-b').size).toBe(0);
    expect(cueReviewIgnores.clear('doc-a').size).toBe(0);
    expect(cueReviewIgnores.read('doc-a').size).toBe(0);
  });

  it('moves through flagged cues from where the list is, wrapping at both ends', () => {
    const cues = [{ index: 4 }, { index: 120 }, { index: 260 }];
    expect([0, 4, 5, 200, 261].map(anchor => reviewPosition(cues, anchor))).toEqual([0, 0, 1, 2, 0]);
    expect(reviewPosition([], 0)).toBe(-1);
    expect([reviewStep(3, 0, 1), reviewStep(3, 2, 1), reviewStep(3, 0, -1), reviewStep(3, -1, 1), reviewStep(0, 0, 1)]).toEqual([1, 0, 2, 0, -1]);
  });
});
