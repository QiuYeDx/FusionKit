// Fixed migration inputs shared by both implementations. No legacy implementation imports.
type Api = {
  rawSegment: (id: number, start: number, end: number, text: string) => any;
  serverResponse: (request: any, duration: number, segments: any[]) => any;
  validResponse: (request: any, window: any, text: string) => any;
  repeatedResponse: (request: any, window: any) => any;
};
type Input = { request: any; window: any; index: number };
export type ReplayCase = {
  id: string;
  options: Record<string, unknown>;
  accelerator?: boolean;
  quietCandidates?: Array<{ startFrame: number; endFrame: number }>;
  inference: (api: Api, input: Input) => any;
  expected: {
    status: 'completed' | 'failed';
    requests: number;
    errorCode?: string;
    ranges?: number[][];
    conditioned?: boolean[];
    temperatures?: number[];
    parentKeys?: Array<string | undefined>;
    texts?: string[];
    times?: number[][];
    joinedSource?: string;
    scans?: number;
    dtw?: Array<string | undefined>;
    noExport?: boolean;
  };
};

const response = (api: Api, request: any, window: any, segments: any[], language = 'en', epoch = 1) => {
  const value = api.serverResponse(request, window.endMs - window.startMs, segments);
  return { processEpoch: epoch, response: { ...value, result: { ...value.result, language } } };
};

const longUnpunctuated = 'これは句読点のない長い発話を表示文字数だけで分割しないための確認です'.repeat(3);
const first = '今日はいい天気ですね';
const second = '明日は家で休みます';

function dtwCase(id: string, backend: 'cuda' | 'cpu', modelId: string, points: boolean): ReplayCase {
  const qualified = backend === 'cuda' && modelId === 'large-v3';
  return {
    id, accelerator: backend === 'cuda',
    options: { backend, modelId, vadEnabled: true, formats: ['SRT', 'LRC'] },
    inference: (api, { request, window }) => {
      const segments = request.vadEnabled ? [api.rawSegment(0, 0, 10000, first + second)] : [
        { ...api.rawSegment(0, 0, 4000, first), dtwTokens: [{ text: '今日は', pointMs: 1200 }, { text: 'いい天気ですね', pointMs: 3700 }] },
        { ...api.rawSegment(1, 4000, 10000, second), dtwTokens: [{ text: '明日', pointMs: points ? 4500 : null }, { text: 'は家で休みます', pointMs: 6800 }] },
      ];
      const value = response(api, request, window, segments, 'ja', request.vadEnabled ? 1 : 2);
      return { ...value, response: { ...value.response, result: { ...value.response.result,
        wordTimelineStatus: request.vadEnabled ? 'discarded_vad_compressed_timeline' : request.timingMode === 'dtw_large_v3' ? 'dtw_token_points' : 'not_requested',
      } } };
    },
    expected: { status: 'completed', requests: backend === 'cuda' ? 2 : 1,
      dtw: backend === 'cuda' ? [undefined, qualified ? 'dtw_large_v3' : undefined] : [undefined],
      times: qualified && points ? [[0, 4500], [4500, 10000]] : [[0, 10000]],
      joinedSource: first + second,
    },
  };
}

export const replayCases: ReplayCase[] = [
  {
    id: 'fixed-unknown-boundary-and-legal-repetition',
    options: { taskWindowStrategy: 'fixed_v1', totalFrames: 20 * 16000, formats: ['SRT', 'LRC'] },
    inference: (api, { request, window }) => response(api, request, window, [
      api.rawSegment(0, 0, 14000, longUnpunctuated),
      api.rawSegment(1, 14500, 15000, 'うん'),
      api.rawSegment(2, 15600, 16100, 'うん'),
    ], 'ja'),
    expected: { status: 'completed', requests: 1, times: [[0, 14000], [14500, 15000], [15600, 16100]],
      joinedSource: longUnpunctuated + 'うんうん', scans: 0 },
  },
  ...(['fixed_v1', 'acoustic_quiet_v1'] as const).map(strategy => ({
    id: `root-plan-${strategy}`, options: { taskWindowStrategy: strategy, totalFrames: 65 * 16000, vadEnabled: true },
    quietCandidates: [{ startFrame: 24400 * 16, endFrame: 25600 * 16 }],
    inference: (api: Api, { request, window }: Input) => api.validResponse(request, window, `Window ${window.startMs}.`),
    expected: { status: 'completed' as const, requests: 3, scans: strategy === 'acoustic_quiet_v1' ? 1 : 0,
      ranges: strategy === 'acoustic_quiet_v1' ? [[0, 25000], [25000, 55000], [50000, 65000]] : [[0, 30000], [25000, 55000], [50000, 65000]],
    },
  })),
  {
    id: 'quiet-conditioned-long-response-falls-back-to-original',
    options: { totalFrames: 30 * 16000, vadEnabled: true, quietAudioGainDb: 12 },
    inference: (api, { request, window, index }) => response(api, request, window,
      [api.rawSegment(0, 0, 12000, index === 0 ? 'Discarded candidate' : 'Original output')]),
    expected: { status: 'completed', requests: 2, conditioned: [true, false], texts: ['Original output'], times: [[0, 12000]] },
  },
  {
    id: 'quiet-empty-negative-control-does-not-retry',
    options: { vadEnabled: true, quietAudioGainDb: 12 },
    inference: (api, { request, window }) => response(api, request, window, []),
    expected: { status: 'failed', errorCode: 'no_speech_detected', requests: 1, conditioned: [true], noExport: true },
  },
  {
    id: 'degenerate-root-splits-into-two-bounded-children',
    options: { totalFrames: 20 * 16000 },
    inference: (api, { request, window, index }) => index === 0 ? api.repeatedResponse(request, window) : api.validResponse(request, window, `child-${index}`),
    expected: { status: 'completed', requests: 3, parentKeys: [undefined, 'w000000', 'w000000'], texts: ['child-1', 'child-2'] },
  },
  {
    id: 'unsplittable-window-has-one-fresh-temperature-replay',
    options: { totalFrames: 5 * 16000 },
    inference: (api, { request, window, index }) => index === 0 ? api.repeatedResponse(request, window) : api.validResponse(request, window, 'recovered'),
    expected: { status: 'completed', requests: 2, temperatures: [0, 0.2], texts: ['recovered'] },
  },
  {
    id: 'cross-window-variant-keeps-a-bounded-dtw-witness', accelerator: true,
    options: { backend: 'cuda', modelId: 'large-v3', totalFrames: 55 * 16000, vadEnabled: true, formats: ['SRT', 'LRC'] },
    inference: (api, { request, window }) => {
      const left = 'ん?なんだどうして', right = 'ん?何だ?どうしたのって何がだ?';
      const segments = request.vadEnabled ? window.startMs === 0
        ? [api.rawSegment(0, 24960, 30000, left)] : [api.rawSegment(0, 1350, 6230, right)]
        : [{ ...api.rawSegment(0, 4920, 11300, 'ん?なんだ どうしたのって何がだ'),
          dtwTokens: [{ text: 'ん?なんだ', pointMs: 6420 }, { text: ' どうしたのって何がだ', pointMs: 11060 }] }];
      const value = response(api, request, window, segments, 'ja', request.vadEnabled ? 1 : 2);
      return { ...value, response: { ...value.response, result: { ...value.response.result,
        wordTimelineStatus: request.vadEnabled ? 'discarded_vad_compressed_timeline' : 'dtw_token_points',
      } } };
    },
    expected: { status: 'completed', requests: 3, texts: ['ん?何だ?どうしたのって何がだ?'], times: [[24960, 31230]],
      ranges: [[0, 30000], [25000, 55000], [20000, 40000]], dtw: [undefined, undefined, 'dtw_large_v3'] },
  },
  dtwCase('cuda-f16-preserves-qualified-word-points', 'cuda', 'large-v3', true),
  dtwCase('cuda-f16-missing-point-preserves-unsplit-source', 'cuda', 'large-v3', false),
  dtwCase('cuda-quantized-model-cannot-claim-dtw-timing', 'cuda', 'large-v3-q5_0', true),
  dtwCase('cpu-f16-cannot-claim-cuda-dtw-timing', 'cpu', 'large-v3', true),
  {
    id: 'cleanup-failure-prevents-export', options: { disposeNormalizedFailure: true },
    inference: (api, { request, window }) => api.validResponse(request, window, 'Safe source.'),
    expected: { status: 'failed', errorCode: 'cleanup_failed', requests: 1, noExport: true },
  },
];
