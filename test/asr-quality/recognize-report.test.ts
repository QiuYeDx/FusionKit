import { describe, expect, it } from 'vitest';
import { describeFields, oddLead, renderRecognizeReport, type AsrRecognizeCue, type AsrRecognizeReport } from './recognize-report';

describe('odd leading characters', () => {
  it('finds the stray token in front of a line, as anime-whisper wrote it with timestamps', () => {
    // records/model-smoke.md: A-00, A-01, C-00 (U+FFFD) and the 30 s window of C.
    expect(oddLead(' There来たのって何がだ?', '来たのって何事?')).toBe('There');
    expect(oddLead('Sったのって何がだ?', '来たのって何事?')).toBe('S');
    expect(oddLead('\uFFFD…こら、おい', 'おい、リズム取るな')).toBe('\uFFFD');
    expect(oddLead('000おい、リズム取るな。', 'おい、リズム取るな')).toBe('000');
  });
  it('leaves alone a line that starts with words, or with what the original starts with', () => {
    expect(oddLead('来たのって何がだ?…あっ', '来たのって何事?')).toBeUndefined();
    expect(oddLead('A班的杰奎林同学拜托我的', 'A班的杰奎林同学拜托我的')).toBeUndefined();
    expect(oddLead('10分くらい遅れそう', '10分くらい遅れそうなの')).toBeUndefined();
    expect(oddLead('', 'おい')).toBeUndefined();
    expect(oddLead('  おい', 'おい')).toBeUndefined();
  });
});

const cue = (value: Partial<AsrRecognizeCue>): AsrRecognizeCue =>
  ({ sampleId: 'A', index: 1, startMs: 30, endMs: 3660, original: { text: '来たのって何事?', confidence: 0.79 }, ...value });

describe('recognize report', () => {
  it('lists every value a field took, and only the fields that tell how a clip was asked for', () => {
    expect(describeFields([{ fields: { language: 'ja', no_timestamps: 'true', vad: 'false', response_format: 'verbose_json' } },
      { fields: { language: 'ja', no_timestamps: 'false', vad: 'false' } }, {}])).toBe('language=ja, no_timestamps=true/false, vad=false');
    expect(describeFields([])).toBe('无');
  });
  it('renders one row per cue with the original, the recognized text, the timed control and a blank verdict', () => {
    const report: AsrRecognizeReport = { runId: 'run-x', startedAt: 't0', completedAt: 't1', cuesRun: 'D:/runs/run-2512BY', environment: ['GPU：test'],
      samples: [{ id: 'A', language: 'ja', path: 'C:/a|b.wav', sha256: 'f'.repeat(64), durationMs: 30000, cues: 5 }],
      models: [{ modelId: 'anime-whisper-q8_0', sha256: 'a'.repeat(64), sampleIds: ['A'], devicePreference: 'auto', processIds: [42],
        serverLoads: ['inference/cuda/anime-whisper-q8_0'], backendProofs: [{ processId: 42, backend: 'cuda', acceleratorPackGeneration: '96eee2a1ff' }],
        observerErrors: [], cleanup: { joined: true, processesExited: true, killed: [], workRemoved: true },
        cues: [cue({ clipMs: 4030, elapsedMs: 2500, serverMs: 2100, loadMs: 1800, fields: { language: 'ja', no_timestamps: 'true', vad: 'false' },
          result: { text: '来たのって何がだ?…あっ', language: 'japanese', confidence: 0.812, reasons: [] },
          timed: { heard: { text: ' There来たのって', language: 'japanese', segments: [] }, oddLead: 'There', fields: { no_timestamps: 'false' } } }),
        cue({ index: 2, startMs: 3660, endMs: 9630, original: { text: 'あ、そうだ。' }, error: 'Error: busy' })] }] };
    const text = renderRecognizeReport(report);
    expect(text).toContain('| A | ja | C:/a\\|b.wav | 30.0 s | 5 |');
    expect(text).toContain('识别 1/2 句，失败 1 句；总耗时 2.5 s，其中服务 2.1 s、首句加载 1.8 s；字数 14 → 12');
    expect(text).toContain('应用请求字段：language=ja, no_timestamps=true, vad=false');
    expect(text).toContain('开头怪字：应用路径 0/1 句，有时间戳对照 1/1 句');
    expect(text).toContain('| 1 | A #1 | 00:00–00:04 | 来たのって何事?（0.790） | 来たのって何がだ?…あっ（0.812） | — | 无 |  There来たのって（怪字 There） | 4.0 s | 2.5 s / 2.1 s |  |');
    expect(text).toContain('| 2 | A #2 | 00:03–00:10 | あ、そうだ。 | 失败：Error: busy | — | — | — | — | — / — |  |');
  });
});
