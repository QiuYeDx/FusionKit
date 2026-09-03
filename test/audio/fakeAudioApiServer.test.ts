import { describe, expect, it } from "vitest";
import {
  createMimoAsrBody,
  createMimoStreamingAsrEvents,
  createMimoStreamingSpeechEvents,
  createOpenAIRealtimeClientSecretBody,
  createOpenAISpeechBuffer,
  startFakeAudioApiServer,
} from "./fakeAudioApiServer";

describe("MiMo ASR contract fixtures", () => {
  it.each(["stop", "length", "content_filter"] as const)(
    "models the %s finish reason and duration usage",
    (finishReason) => {
      expect(
        createMimoAsrBody({
          text: "转写结果",
          finishReason,
          usage: { seconds: 12 },
        }),
      ).toMatchObject({
        choices: [
          {
            message: { content: "转写结果" },
            finish_reason: finishReason,
          },
        ],
        usage: { seconds: 12 },
      });
    },
  );

  it("models empty text and missing choices independently", () => {
    expect(createMimoAsrBody({})).toMatchObject({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
    });
    expect(createMimoAsrBody({ omitChoices: true })).toMatchObject({
      choices: [],
    });
  });

  it("models normal, truncated, filtered, empty, and disconnected SSE states", () => {
    const normal = createMimoStreamingAsrEvents({
      textChunks: ["你", "好"],
      usage: { seconds: 2 },
    });
    expect(normal).toHaveLength(4);
    expect(normal.at(-2)).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { seconds: 2 },
    });
    expect(normal.at(-1)).toBe("[DONE]");

    for (const finishReason of ["length", "content_filter"] as const) {
      expect(
        createMimoStreamingAsrEvents({ textChunks: [], finishReason }).at(0),
      ).toMatchObject({ choices: [{ finish_reason: finishReason }] });
    }
    expect(createMimoStreamingAsrEvents({ textChunks: [] })).toHaveLength(2);
    expect(
      createMimoStreamingAsrEvents({
        textChunks: ["partial"],
        includeTerminalChunk: false,
        includeDone: false,
      }),
    ).toEqual([
      expect.objectContaining({
        choices: [expect.objectContaining({ finish_reason: null })],
      }),
    ]);
  });

  it("uses decimal Base64 character budgets at exact boundaries", () => {
    const encodedCharacters = (bytes: number) => 4 * Math.ceil(bytes / 3);
    expect(encodedCharacters(7_500_000)).toBe(10_000_000);
    expect(encodedCharacters(7_500_001)).toBe(10_000_004);
    expect(encodedCharacters(6_750_000)).toBe(9_000_000);
  });
});

describe("fake audio API server", () => {
  it("captures MiMo chat audio JSON requests", async () => {
    const server = await startFakeAudioApiServer();
    try {
      server.enqueueRoute("mimo_chat_completions", {
        body: createMimoAsrBody({ text: "转写结果" }),
      });

      const response = await fetch(server.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": "mimo-test-key",
        },
        body: JSON.stringify({
          model: "mimo-v2.5-asr",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: {
                    data: "data:audio/wav;base64,UklGRg==",
                  },
                },
              ],
            },
          ],
          asr_options: { language: "zh" },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        model: "mimo-v2.5-asr",
      });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({
        method: "POST",
        route: "mimo_chat_completions",
      });
      expect(server.requests[0].body).toMatchObject({
        model: "mimo-v2.5-asr",
        asr_options: { language: "zh" },
      });
    } finally {
      await server.close();
    }
  });

  it("returns binary OpenAI speech responses", async () => {
    const server = await startFakeAudioApiServer();
    try {
      server.enqueueRoute("openai_speech", {
        headers: { "Content-Type": "audio/wav" },
        rawBody: createOpenAISpeechBuffer("wav-bytes"),
      });

      const response = await fetch(server.audioSpeechUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          input: "hello",
          voice: "alloy",
        }),
      });

      expect(response.headers.get("content-type")).toContain("audio/wav");
      const audio = Buffer.from(await response.arrayBuffer());
      expect(audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(audio.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(server.requests[0].route).toBe("openai_speech");
    } finally {
      await server.close();
    }
  });

  it("returns SSE events for streaming speech fixtures", async () => {
    const server = await startFakeAudioApiServer();
    try {
      server.enqueueRoute("mimo_chat_completions", {
        sseEvents: createMimoStreamingSpeechEvents({
          audioBase64Chunks: ["AQI=", "AwQ="],
          textChunks: ["你", "好"],
        }),
      });

      const response = await fetch(server.chatCompletionsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mimo-v2.5-tts",
          stream: true,
        }),
      });

      const body = await response.text();
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(body).toContain("data: ");
      expect(body).toContain("AQI=");
      expect(body).toContain("[DONE]");
      expect(server.requests[0].route).toBe("mimo_chat_completions");
    } finally {
      await server.close();
    }
  });

  it("supports OpenAI realtime ephemeral session fixtures", async () => {
    const server = await startFakeAudioApiServer();
    try {
      server.enqueueRoute("openai_realtime_client_secrets", {
        body: createOpenAIRealtimeClientSecretBody({
          clientSecret: "ek_test",
          model: "gpt-realtime",
        }),
      });

      const response = await fetch(server.realtimeClientSecretsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: { model: "gpt-realtime" } }),
      });

      expect(await response.json()).toMatchObject({
        model: "gpt-realtime",
        client_secret: { value: "ek_test" },
      });
      expect(server.requests[0].route).toBe("openai_realtime_client_secrets");
    } finally {
      await server.close();
    }
  });
});
