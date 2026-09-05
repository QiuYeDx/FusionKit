import { describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_SERVER_HTTP_POLICY,
  LocalSubtitleServerContractError,
  createLocalSubtitleServerInferenceFields,
  mapLocalSubtitleLanguageToWhisper,
  parseLocalSubtitleServerHealth,
  parseLocalSubtitleServerVerboseJson,
  validateLocalSubtitleServerInferenceRequest,
} from "../../electron/main/local-subtitle/server-contract";

describe("local subtitle official server contract", () => {
  it("only forwards conditioned padding with VAD and keeps ordinary requests unchanged", () => {
    expect(createLocalSubtitleServerInferenceFields({...validRequest(), vadSpeechPadMs: 1000}))
      .toMatchObject({vad_speech_pad_ms: "1000", token_timestamps: "false"});
    expect(createLocalSubtitleServerInferenceFields(validRequest())).not.toHaveProperty("vad_speech_pad_ms");
    expect(() => createLocalSubtitleServerInferenceFields({...validRequest(), vadSpeechPadMs: 1000, vadEnabled: false})).toThrow();
    expect(() => createLocalSubtitleServerInferenceFields({...validRequest(), vadSpeechPadMs: 2000} as never)).toThrow();
  });
  it("pins the accepted upstream release and transport limits", () => {
    expect(LOCAL_SUBTITLE_SERVER_HTTP_POLICY).toMatchObject({
      contractVersion: 1,
      engineVersion: "v1.9.1",
      engineCommit: "f049fff95a089aa9969deb009cdd4892b3e74916",
      host: "127.0.0.1",
      privatePathEntropyBytes: 24,
      maxInferenceResponseBytes: 64 * 1024 * 1024,
      maxInferenceUploadBytes: 1024 * 1024,
      inferenceRequestTimeoutMs: 15 * 60 * 1_000,
      maxActiveRequests: 1,
      restartAfterAbort: true,
      parseHumanLogs: false,
      allowFetchDefaultTimeouts: false,
      allowMediaConversion: false,
    });
    expect(Object.isFrozen(LOCAL_SUBTITLE_SERVER_HTTP_POLICY)).toBe(true);
  });

  it("maps the v1 batch settings to an exact multipart field allowlist", () => {
    expect(
      createLocalSubtitleServerInferenceFields(validRequest()),
    ).toEqual({
      response_format: "verbose_json",
      language: "ja",
      translate: "false",
      vad: "true",
      token_timestamps: "false",
      no_language_probabilities: "true",
      beam_size: "5",
      temperature: "0",
      temperature_inc: "0.2",
      no_timestamps: "false",
      vad_min_silence_duration_ms: "500",
      prompt: "FusionKit",
    });
  });

  it("keeps token timestamps disabled when VAD is disabled in contract v1", () => {
    expect(
      createLocalSubtitleServerInferenceFields({
        ...validRequest(),
        taskMode: "translate_to_english",
        vadEnabled: false,
        initialPrompt: undefined,
      }),
    ).toEqual({
      response_format: "verbose_json",
      language: "ja",
      translate: "true",
      vad: "false",
      token_timestamps: "false",
      no_language_probabilities: "true",
      beam_size: "5",
      temperature: "0",
      temperature_inc: "0.2",
      no_timestamps: "false",
    });
  });

  it.each([
    { field: "requestGeneration", value: 0 },
    { field: "language", value: "../../ja" },
    { field: "taskMode", value: "summarize" },
    { field: "beamSize", value: 0 },
    { field: "temperature", value: Number.NaN },
    { field: "vadEnabled", value: "true" },
    { field: "vadMinSilenceMs", value: 99 },
    { field: "initialPrompt", value: "bad\u0000prompt" },
  ])("rejects invalid $field without forwarding it upstream", ({ field, value }) => {
    expect(() =>
      createLocalSubtitleServerInferenceFields({
        ...validRequest(),
        [field]: value,
      } as never),
    ).toThrow(LocalSubtitleServerContractError);
  });

  it("requires a main-owned normalized window path", () => {
    expect(() =>
      validateLocalSubtitleServerInferenceRequest({
        ...validRequest(),
        filePath: "",
      }),
    ).toThrow(/normalized window/u);
  });

  it("accepts an exact Windows file ID above the JavaScript safe integer range", () => {
    expect(() =>
      validateLocalSubtitleServerInferenceRequest({
        ...validRequest(),
        expectedFileIdentity: {
          ...validFileIdentity(),
          objectIdentity: {
            volumeSerialHex: "00000001",
            fileIdHex: "00000000000000000020000000000001",
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    { label: "missing", identity: undefined },
    { label: "extra key", identity: { ...validFileIdentity(), path: "/private/window.wav" } },
    {
      label: "invalid object identity",
      identity: { ...validFileIdentity(), objectIdentity: { dev: -1, ino: 2, birthtimeMs: 3 } },
    },
    {
      label: "variable-width Windows file ID",
      identity: {
        ...validFileIdentity(),
        objectIdentity: { volumeSerialHex: "00000001", fileIdHex: "9007199254740993" },
      },
    },
    { label: "empty file", identity: { ...validFileIdentity(), size: 0 } },
    { label: "negative mtime", identity: { ...validFileIdentity(), mtimeMs: -1 } },
    { label: "non-finite ctime", identity: { ...validFileIdentity(), ctimeMs: Number.POSITIVE_INFINITY } },
  ])("rejects a $label expected window identity", ({ identity }) => {
    expect(() =>
      validateLocalSubtitleServerInferenceRequest({
        ...validRequest(),
        expectedFileIdentity: identity,
      } as never),
    ).toThrow(/window identity/u);
  });

  it("maps BCP-47 variants and legacy aliases to pinned Whisper codes", () => {
    expect(mapLocalSubtitleLanguageToWhisper("zh-Hans")).toBe("zh");
    expect(mapLocalSubtitleLanguageToWhisper("jv-ID")).toBe("jw");
    expect(mapLocalSubtitleLanguageToWhisper("fil-PH")).toBe("tl");
    expect(() => mapLocalSubtitleLanguageToWhisper("xx-Test")).toThrow(
      /not supported/u,
    );
  });

  it("accepts only the exact health contract", () => {
    expect(parseLocalSubtitleServerHealth({ status: "ok" })).toBe(true);
    expect(() =>
      parseLocalSubtitleServerHealth({ status: "loading model" }),
    ).toThrow(LocalSubtitleServerContractError);
    expect(() =>
      parseLocalSubtitleServerHealth({ status: "ok", endpoint: "/private" }),
    ).toThrow(LocalSubtitleServerContractError);
  });

  it("normalizes strict verbose_json timestamps to integer milliseconds", () => {
    const result = parseLocalSubtitleServerVerboseJson(
      validVerboseJson(),
      { taskMode: "transcribe", vadEnabled: true },
    );

    expect(result).toEqual({
      contractVersion: 1,
      task: "transcribe",
      language: "japanese",
      durationMs: 2_500,
      text: "hello",
      segments: [
        {
          id: 0,
          startMs: 120,
          endMs: 2_340,
          text: "hello",
          temperature: 0,
          averageLogProbability: -0.25,
          noSpeechProbability: 0.01,
        },
      ],
      wordTimelineStatus: "discarded_vad_compressed_timeline",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.segments)).toBe(true);
  });

  it("does not expose upstream words when token timestamps are not requested", () => {
    const result = parseLocalSubtitleServerVerboseJson(
      validVerboseJson(),
      { taskMode: "transcribe", vadEnabled: false },
    );

    expect(result.wordTimelineStatus).toBe("not_requested");
    expect(result.segments[0]).not.toHaveProperty("words");
  });

  it.each([
    {
      label: "C1 control",
      mutate: (body: ReturnType<typeof validVerboseJson>) => {
        body.text = "bad\u0085text";
      },
    },
    {
      label: "unpaired high surrogate",
      mutate: (body: ReturnType<typeof validVerboseJson>) => {
        body.segments[0]!.text = "bad\ud800";
      },
    },
    {
      label: "unpaired low surrogate in discarded words",
      mutate: (body: ReturnType<typeof validVerboseJson>) => {
        body.segments[0]!.words![0]!.word = "bad\udc00text";
      },
    },
  ])("rejects $label in verbose_json text", ({ mutate }) => {
    const body = validVerboseJson();
    mutate(body);
    expect(() =>
      parseLocalSubtitleServerVerboseJson(body, {
        taskMode: "transcribe",
        vadEnabled: true,
      }),
    ).toThrow(LocalSubtitleServerContractError);
  });

  it.each([
    { ...validVerboseJson(), extra: true },
    { ...validVerboseJson(), task: "summarize" },
    { ...validVerboseJson(), duration: Number.NaN },
    { ...validVerboseJson(), segments: "human log text" },
    {
      ...validVerboseJson(),
      segments: [{ ...validVerboseJson().segments[0], end: 0.1 }],
    },
    {
      ...validVerboseJson(),
      segments: [
        {
          ...validVerboseJson().segments[0],
          words: [{ word: "hello", start: 0.1, probability: 0.5 }],
        },
      ],
    },
  ])("rejects malformed or expanded verbose_json %#", (body) => {
    expect(() =>
      parseLocalSubtitleServerVerboseJson(body, {
        taskMode: "transcribe",
        vadEnabled: true,
      }),
    ).toThrow(LocalSubtitleServerContractError);
  });

  it("rejects a response task that differs from the frozen request", () => {
    expect(() =>
      parseLocalSubtitleServerVerboseJson(validVerboseJson(), {
        taskMode: "translate_to_english",
        vadEnabled: true,
      }),
    ).toThrow(/does not match/u);
  });
});

it("requests DTW points only for explicit Japanese non-VAD transcription", () => {
  const request = { ...validRequest(), vadEnabled: false, timingMode: "dtw_large_v3" as const };
  expect(createLocalSubtitleServerInferenceFields(request)).toMatchObject({ token_timestamps: "true", temperature_inc: "0.2" });
  for (const patch of [{ vadEnabled: true }, { language: "en" }, { taskMode: "translate_to_english" as const }]) {
    expect(() => createLocalSubtitleServerInferenceFields({ ...request, ...patch })).toThrow(/DTW/);
  }
});

it("preserves separate DTW points while ordinary and VAD requests discard them", () => {
  const raw = validVerboseJson(); raw.segments[0]!.words[0]!.t_dtw = 42;
  const options = { taskMode: "transcribe" as const, vadEnabled: false, timingMode: "dtw_large_v3" as const };
  const result = parseLocalSubtitleServerVerboseJson(raw, options);
  expect(result.wordTimelineStatus).toBe("dtw_token_points");
  expect(result.segments[0]!.dtwTokens).toEqual([{ text: "hello", pointMs: 420 }]);
  expect(result.segments[0]!.dtwTokens?.[0]).not.toHaveProperty("startMs");
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
    raw.segments[0]!.words[0]!.t_dtw = value;
    expect(parseLocalSubtitleServerVerboseJson(raw, options).segments[0]!.dtwTokens?.[0]?.pointMs).toBeNull();
  }
  expect(() => parseLocalSubtitleServerVerboseJson(raw, { ...options, vadEnabled: true })).toThrow(/DTW/);
  expect(parseLocalSubtitleServerVerboseJson(raw, { taskMode: "transcribe", vadEnabled: false }).segments[0]).not.toHaveProperty("dtwTokens");
});

function validRequest() {
  return {
    requestGeneration: 1,
    filePath: "/private/window.wav",
    expectedFileIdentity: validFileIdentity(),
    language: "ja",
    taskMode: "transcribe" as const,
    beamSize: 5,
    temperature: 0,
    vadEnabled: true,
    vadMinSilenceMs: 500,
    initialPrompt: "FusionKit",
  };
}

function validFileIdentity() {
  return Object.freeze({
    objectIdentity: Object.freeze({
      volumeSerialHex: "00000001",
      fileIdHex: "00000000000000000000000000000002",
    }),
    size: 4_096,
    mtimeMs: 1_000.25,
    ctimeMs: 1_000.5,
  });
}

function validVerboseJson() {
  return {
    task: "transcribe",
    language: "japanese",
    duration: 2.5,
    text: " hello\n",
    segments: [
      {
        id: 0,
        text: " hello ",
        start: 0.12,
        end: 2.34,
        tokens: [1, 2],
        words: [
          {
            word: "hello",
            start: 0.12,
            end: 0.8,
            t_dtw: -1,
            probability: 0.91,
          },
        ],
        temperature: 0,
        avg_logprob: -0.25,
        no_speech_prob: 0.01,
      },
    ],
  };
}
