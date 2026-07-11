import { describe, expect, it } from "vitest";
import {
  createMimoAsrBody,
  createMimoStreamingSpeechEvents,
  createOpenAIRealtimeClientSecretBody,
  createOpenAISpeechBuffer,
  startFakeAudioApiServer,
} from "./fakeAudioApiServer";

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
