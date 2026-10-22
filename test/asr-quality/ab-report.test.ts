import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { ASR_AB_BUDGET, ASR_AB_SAMPLES, ASR_AB_VARIANTS, asrAbEnabled, asrAbTimeoutMs, modelIdOfFile, parseAsrAbSelection } from './ab-config';
import { alignCues, comparableText, confidenceDistribution, countChanges, cueChars, describeProfileFields, formatClock, formatRange, minorDetail,
  formatSrt, listeningRegions, renderDiff, renderListening, renderSummary, summarizeRequestFields,
  type AsrAbCase, type AsrAbCue, type AsrAbReport } from './ab-report';

const cue = (startMs: number, endMs: number, text: string, confidence?: number): AsrAbCue =>
  ({ startMs, endMs, text, ...(confidence === undefined ? {} : { confidence }) });

describe('A/B selection', () => {
  it('is gated by an explicit flag and defaults to every sample, variant, large-v3 and CUDA', () => {
    expect(asrAbEnabled({})).toBe(false); expect(asrAbEnabled({ FUSIONKIT_ASR_AB: 'true' })).toBe(false);
    expect(asrAbEnabled({ FUSIONKIT_ASR_AB: '1' })).toBe(true);
    const selection = parseAsrAbSelection({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
    expect(selection).toMatchObject({ sampleIds: ['A', 'B', 'C', 'B-noise', 'independent', 'full', 'drama', 'pv-zh', 'pv-ja'],
      variants: [...ASR_AB_VARIANTS], device: 'cuda', modelId: 'large-v3' });
    expect(selection.modelPath).toBeUndefined();
    expect(selection.resourceRoot).toBe(path.resolve('C:\\Users\\me\\AppData\\Roaming', 'FusionKit', 'speech-resources'));
    expect(ASR_AB_SAMPLES.find(sample => sample.id === 'pv-zh')?.language).toBe('zh');
    expect(ASR_AB_SAMPLES.filter(sample => sample.language === 'zh').map(sample => sample.id)).toEqual(['pv-zh']);
  });
  it('reads trimmed, de-duplicated lists and rejects unknown names instead of skipping them', () => {
    const selection = parseAsrAbSelection({ FUSIONKIT_ASR_AB_SAMPLES: ' A, B-noise ,A', FUSIONKIT_ASR_AB_VARIANTS: 'standard', FUSIONKIT_ASR_AB_DEVICE: 'cpu' });
    expect(selection).toMatchObject({ sampleIds: ['A', 'B-noise'], variants: ['standard'], device: 'cpu' });
    expect(() => parseAsrAbSelection({ FUSIONKIT_ASR_AB_SAMPLES: 'A,Z' })).toThrow(/Z/);
    expect(() => parseAsrAbSelection({ FUSIONKIT_ASR_AB_SAMPLES: ' , ' })).toThrow(/empty/);
    expect(() => parseAsrAbSelection({ FUSIONKIT_ASR_AB_VARIANTS: 'loud_v1' })).toThrow(/loud_v1/);
    expect(() => parseAsrAbSelection({ FUSIONKIT_ASR_AB_DEVICE: 'metal' })).toThrow(/metal/);
    expect(() => parseAsrAbSelection({ FUSIONKIT_ASR_AB_MODEL: '../model' })).toThrow(/invalid/);
  });
  it('names a downloaded model after its file unless the model ID is given', () => {
    expect(modelIdOfFile('D:/models/ggml-large-v3-turbo-q8_0.bin')).toBe('large-v3-turbo-q8_0');
    const file = path.resolve('D:/models/ggml-belle-large-v3-turbo-zh.bin');
    expect(parseAsrAbSelection({ FUSIONKIT_ASR_AB_MODEL_PATH: file })).toMatchObject({ modelId: 'belle-large-v3-turbo-zh', modelPath: file });
    expect(parseAsrAbSelection({ FUSIONKIT_ASR_AB_MODEL_PATH: file, FUSIONKIT_ASR_AB_MODEL: 'belle' }).modelId).toBe('belle');
  });
  it('budgets every selected case', () => {
    expect(asrAbTimeoutMs({ sampleIds: ['A', 'B-noise'], variants: ['standard'] }))
      .toBe(2 * (ASR_AB_BUDGET.caseMs + ASR_AB_BUDGET.cleanupMs) + ASR_AB_BUDGET.resourcesMs);
  });
});

describe('A/B text and time formatting', () => {
  it('writes the SRT layout of the app export, and an empty file for no cues', () => {
    expect(formatSrt([cue(0, 1500, 'あ'), cue(3_723_004, 3_725_000, 'い\nう')]))
      .toBe('1\n00:00:00,000 --> 00:00:01,500\nあ\n\n2\n01:02:03,004 --> 01:02:05,000\nい\nう\n');
    expect(formatSrt([])).toBe('');
  });
  it('gives listeners whole-second ranges that cover the region', () => {
    expect(formatClock(0)).toBe('00:00'); expect(formatClock(59_999)).toBe('00:59'); expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatRange(1_200, 4_100)).toBe('00:01–00:05'); expect(formatRange(752_400, 753_000)).toBe('12:32–12:33');
  });
  it('compares words without width, case, whitespace or punctuation', () => {
    expect(comparableText('ＡＢ、 ｃ。「です」!')).toBe('abcです'); expect(cueChars(' あい う\n')).toBe(3);
    expect(comparableText('♪')).toBe('♪');
  });
});

describe('A/B time-overlap alignment', () => {
  it('keeps identical runs the same and reports changed, added and removed sentences', () => {
    const base = [cue(0, 2000, 'おはよう'), cue(3000, 5000, 'こんにちは'), cue(8000, 9000, '消える')];
    const other = [cue(20, 1990, 'おはよう'), cue(3000, 5000, 'こんばんは'), cue(6000, 7000, '増える')];
    const groups = alignCues(base, other);
    expect(groups.map(group => [group.kind, group.startMs, group.endMs])).toEqual([['same', 0, 2000], ['changed', 3000, 5000],
      ['added', 6000, 7000], ['removed', 8000, 9000]]);
    expect(countChanges(groups)).toEqual({ same: 1, minor: 0, changed: 1, added: 1, removed: 1 });
    expect(alignCues(base, base).every(group => group.kind === 'same')).toBe(true);
    expect(alignCues([], [])).toEqual([]);
  });
  it('treats a split, a punctuation change or a moved boundary with the same words as minor', () => {
    expect(alignCues([cue(0, 4000, 'あいうえお')], [cue(0, 1800, 'あいう'), cue(1800, 4000, 'えお')]).map(group => group.kind)).toEqual(['minor']);
    expect(alignCues([cue(0, 2000, 'はい')], [cue(0, 2000, 'はい。')])[0]!.kind).toBe('minor');
    expect(alignCues([cue(0, 2000, 'はい')], [cue(0, 2600, 'はい')])[0]!.kind).toBe('minor');
    expect(alignCues([cue(0, 2000, 'はい')], [cue(200, 2200, 'はい')])[0]!.kind).toBe('same');
    expect(minorDetail({ base: [cue(0, 4000, 'あいうえお')], other: [cue(0, 1800, 'あいう'), cue(1800, 4000, 'えお')] })).toBe('断句 1→2');
    expect(minorDetail({ base: [cue(0, 2000, 'はい')], other: [cue(0, 2000, 'はい。')] })).toBe('标点');
    expect(minorDetail({ base: [cue(30, 3660, '一')], other: [cue(0, 3090, '一')] })).toBe('边界 0.6 s');
  });
  it('does not chain neighbours through a shared edge of a few frames', () => {
    const base = [cue(0, 2000, '一つ目'), cue(2000, 4000, '二つ目')];
    const groups = alignCues(base, [cue(1950, 4000, '二つ目')]);
    expect(groups.map(group => [group.kind, group.base.map(value => value.text)])).toEqual([['removed', ['一つ目']], ['same', ['二つ目']]]);
    // A short cue overlapping most of itself still counts, even when the overlap is under 300 ms.
    expect(alignCues([cue(0, 2000, 'ねえ')], [cue(1800, 2050, 'ねえ')])[0]!.base).toHaveLength(1);
  });
  it('keeps contiguous sentences apart when every edge moved by up to 1.3 s (real A, standard vs quiet_whisper_v1)', () => {
    const base = [cue(30, 3660, '一'), cue(3660, 9630, '二'), cue(9630, 17350, 'へへへ。あ、あの'), cue(17350, 23910, '四'), cue(23910, 29090, '五、六')];
    const other = [cue(0, 3090, '一'), cue(3090, 8980, '二'), cue(8980, 18620, 'あはは、あの'), cue(18620, 23780, '四'),
      cue(23780, 27590, '五、'), cue(27590, 29360, '六')];
    expect(alignCues(base, other).map(group => [group.kind, group.base.length, group.other.length]))
      .toEqual([['minor', 1, 1], ['minor', 1, 1], ['changed', 1, 1], ['minor', 1, 1], ['minor', 1, 2]]);
  });
  it('joins an unpaired cue to its largest real overlap instead of reporting it added and removed', () => {
    expect(alignCues([cue(0, 3000, 'あいう')], [cue(2000, 6000, 'あいうえ')]).map(group => group.kind)).toEqual(['changed']);
    // A cue across a pause overlaps a quarter of each neighbour: the three form one group, not an addition.
    const groups = alignCues([cue(0, 6000, 'a'), cue(8000, 14_000, 'b')], [cue(5000, 9000, 'a b')]);
    expect(groups.map(group => [group.kind, group.base.map(value => value.text), group.other.map(value => value.text)]))
      .toEqual([['minor', ['a', 'b'], ['a b']]]);
  });
  it('orders unsorted input and groups one long cue against several', () => {
    const groups = alignCues([cue(5000, 6000, 'b'), cue(0, 1000, 'a')], [cue(0, 6000, 'a b')]);
    expect(groups).toHaveLength(1); expect(groups[0]).toMatchObject({ kind: 'minor', startMs: 0, endMs: 6000 });
    expect(groups[0]!.base.map(value => value.text)).toEqual(['a', 'b']);
  });
});

describe('A/B statistics', () => {
  it('buckets confidence at the review threshold and reports none for older transcripts', () => {
    expect(confidenceDistribution([cue(0, 1, 'a'), cue(1, 2, 'b')])).toBeUndefined();
    const distribution = confidenceDistribution([0.1, 0.3, 0.44, 0.45, 0.7, 0.8, 1].map((value, index) => cue(index, index + 1, 'x', value)));
    expect(distribution).toMatchObject({ count: 7, min: 0.1, median: 0.45, buckets: [1, 2, 1, 1, 2] });
    expect(confidenceDistribution([cue(0, 1, 'a', 0.2), cue(1, 2, 'b', 0.6)])?.median).toBeCloseTo(0.4);
  });
  it('counts each sent field value per request kind and names only the profile fields', () => {
    const standard = { language: 'ja', vad: 'true', beam_size: '5', vad_min_silence_duration_ms: '500' };
    const summary = summarizeRequestFields([{ kind: 'primary', fields: standard }, { kind: 'primary', fields: { ...standard, vad_speech_pad_ms: '1000' } },
      { kind: 'separator', fields: { ...standard, vad: 'false', token_timestamps: 'true' } }]);
    expect(summary.primary).toEqual({ count: 2, fields: { language: { ja: 2 }, vad: { true: 2 }, beam_size: { 5: 2 },
      vad_min_silence_duration_ms: { 500: 2 }, vad_speech_pad_ms: { 1000: 1 } } });
    expect(summary.separator?.fields.vad).toEqual({ false: 1 });
    expect(describeProfileFields(summary)).toBe('vad_speech_pad_ms=1000×1');
    expect(describeProfileFields(summarizeRequestFields([{ kind: 'separator', fields: { vad_threshold: '0.5' } }]))).toBe('无');
    expect(describeProfileFields(summarizeRequestFields([{ kind: 'primary', fields: { vad_threshold: '0.35', suppress_nst: 'true' } },
      { kind: 'quality_recovery', fields: { vad_threshold: '0.35' } }]))).toBe('vad_threshold=0.35×1; suppress_nst=true×1; 重放 vad_threshold=0.35×1');
  });
});

describe('A/B listening regions', () => {
  it('pads, clamps and merges word differences across variants, ignoring minor ones', () => {
    const quiet = alignCues([cue(1000, 2000, 'あ'), cue(9000, 9500, 'い')], [cue(1000, 2000, 'あ。'), cue(9000, 9500, 'う'), cue(400, 800, '増')]);
    const noisy = alignCues([cue(9000, 9500, 'い')], [cue(10_400, 11_000, '別')]);
    const regions = listeningRegions([{ variant: 'quiet_whisper_v1', groups: quiet }, { variant: 'noisy_music_v1', groups: noisy }], 11_200);
    expect(regions.map(region => [region.startMs, region.endMs, region.entries.map(entry => `${entry.variant}:${entry.kind}`)])).toEqual([
      [0, 1300, ['quiet_whisper_v1:added']],
      [8500, 11_200, ['quiet_whisper_v1:changed', 'noisy_music_v1:removed', 'noisy_music_v1:added']],
    ]);
    expect(regions[1]!.entries[0]).toMatchObject({ base: 'い', other: 'う' });
    expect(listeningRegions([{ variant: 'quiet_whisper_v1', groups: alignCues([cue(0, 1, 'a')], [cue(0, 1, 'a')]) }])).toEqual([]);
  });
});

describe('A/B reports', () => {
  const done = (sampleId: string, variant: AsrAbCase['variant'], cues: AsrAbCue[], extra: Partial<AsrAbCase> = {}): AsrAbCase =>
    ({ sampleId, variant, status: cues.length ? 'completed' : 'no_content', cues, timings: { totalMs: 12_300, normalizeMs: 400, loadMs: 3000, inferenceMs: 8000 },
      requests: [{ ordinal: 1, kind: 'primary', fields: { vad: 'true', ...variant === 'standard' ? {} : { vad_threshold: '0.35' } }, language: 'ja' }],
      profileApplied: variant !== 'standard', ...extra });
  const report: AsrAbReport = { runId: 'run-x', startedAt: '2026-10-22T00:00:00.000Z', completedAt: '2026-10-22T00:10:00.000Z',
    model: { id: 'large-v3', sha256: 'a'.repeat(64), source: '已安装（只读）' }, device: 'cuda', environment: ['GPU：test'],
    variants: ['standard', 'quiet_whisper_v1', 'noisy_music_v1'],
    samples: [{ id: 'A', language: 'ja', description: '30 s | ASMR', status: 'present', path: 'C:/samples/A.wav', durationMs: 30_000 },
      { id: 'B-noise', language: 'ja', description: '负对照', status: 'present', durationMs: 18_000 },
      { id: 'drama', language: 'ja', description: '广播剧', status: 'missing', reason: 'E:/workspace/fusionkit 不存在' }],
    cases: [done('A', 'standard', [cue(0, 2000, 'おはよう', 0.9), cue(3000, 5000, 'こんにちは', 0.4)]),
      done('A', 'quiet_whisper_v1', [cue(0, 2000, 'おはよう', 0.9), cue(3000, 5000, 'こんばんは|', 0.5)]),
      { sampleId: 'A', variant: 'noisy_music_v1', status: 'not_implemented', cues: [], requests: [], timings: {}, error: '任务配置不接受 advanced.audioProfile' },
      done('B-noise', 'standard', []), done('B-noise', 'quiet_whisper_v1', [cue(4000, 5000, 'ご視聴ありがとうございました', 0.2)]),
      done('B-noise', 'noisy_music_v1', [], { profileApplied: false })] };

  it('summarizes counts, timings, confidence, missing samples, the negative control and inactive variants', () => {
    const text = renderSummary(report);
    expect(text).toContain('| A | standard | 完成 | 2 | 9 | 1（1/0/0） | 12.3 s / 0.4 s / 3.0 s / 8.0 s | <0.30:0 0.30–0.45:1 0.45–0.60:0 0.60–0.80:0 ≥0.80:1；中位 0.65 | 未实现 | 无 |');
    expect(text).toContain('| A | noisy_music_v1 | 未实现 | — | — | 0（0/0/0）');
    expect(text).toContain('vad_threshold=0.35×1'); expect(text).toContain('30 s \\| ASMR');
    expect(text).toContain('| drama | ja | 广播剧 | — | 缺失：E:/workspace/fusionkit 不存在 |');
    expect(text).toContain('- standard：（无文字）'); expect(text).toContain('- quiet_whisper_v1：00:04–00:05 ご視聴ありがとうございました');
    expect(text).toContain('- A / noisy_music_v1：未实现（任务配置不接受 advanced.audioProfile）');
    expect(text).toContain('- B-noise / noisy_music_v1：任务已接受该音频类型，但没有任何识别请求带上预设字段');
  });
  it('lists aligned differences per sample and says why a pair cannot be compared', () => {
    const text = renderDiff(report);
    expect(text).toContain('### standard → quiet_whisper_v1'); expect(text).toContain('相同 1 · 细微 0 · 改变 1 · 新增 0 · 消失 0；字幕 2 → 2，字数 9 → 10');
    expect(text).toContain('| 00:03–00:05 | 改变 | こんにちは | こんばんは\\| |');
    expect(text).toContain('无法比较：standard 完成，noisy_music_v1 未实现。');
    expect(text).toContain('| 00:04–00:05 | 新增 | — | ご視聴ありがとうございました |');
    expect(text).not.toContain('## drama');
    const edges = { ...report, samples: report.samples.slice(0, 1), variants: ['standard', 'quiet_whisper_v1'] as AsrAbReport['variants'],
      cases: [done('A', 'standard', [cue(0, 2000, 'はい')]), done('A', 'quiet_whisper_v1', [cue(0, 2600, 'はい')])] };
    expect(renderDiff(edges)).toContain('没有文字差异。\n\n细微差异 1 处（文字相同，不需听审）：\n\n| 区间 | 说明 | standard | quiet_whisper_v1 |\n'
      + '| --- | --- | --- | --- |\n| 00:00–00:03 | 边界 0.6 s | はい | はい |');
    const standardOnly = { ...report, variants: ['standard'] as AsrAbReport['variants'], cases: report.cases.filter(value => value.variant === 'standard') };
    expect(renderDiff(standardOnly)).toContain('## A\n\n只运行了 standard，没有可比较的变体。');
    expect(renderListening(standardOnly)).toContain('没有可比较的变体。');
  });
  it('gives the listener padded ranges, the sample file and an empty verdict column', () => {
    const text = renderListening(report);
    expect(text).toContain('文件：C:/samples/A.wav'); expect(text).toContain('未比较：noisy_music_v1（standard 完成，未实现）。');
    expect(text).toContain('| 1 | 00:02–00:06 | quiet_whisper_v1 改变 | こんにちは | こんばんは\\| |  |');
    expect(text).toContain('| 1 | 00:03–00:06 | quiet_whisper_v1 新增 | — | ご視聴ありがとうございました |  |');
    expect(text).toContain('（由用户填写，Agent 不代签）');
  });
});
