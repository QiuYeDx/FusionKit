import { describe, expect, it } from "vitest";
import {
  MIMO_TTS_MODEL_BY_MODE,
  createDefaultAudioApiRoutes,
} from "@/lib/audio-provider-registry";
import type {
  AudioTaskRouteIntent,
  SpeechSynthesisMode,
} from "@/type/audio";
import type { SyncAudioRuntimeConfigRequest } from "@/type/audioIpc";
import { AudioRuntimeConfigStore } from "../../electron/main/audio/audio-runtime-config";

const OWNER_A = 101;
const OWNER_B = 202;

describe("AudioRuntimeConfigStore", () => {
  it("isolates snapshots and revisions by renderer owner", () => {
    const store = new AudioRuntimeConfigStore();
    const syncedA = store.sync(
      createMimoSnapshot({ presetVoiceModel: "owner-a-tts" }),
      OWNER_A,
    );
    const syncedB = store.sync(
      createMimoSnapshot({ presetVoiceModel: "owner-b-tts" }),
      OWNER_B,
    );

    expect(
      resolveSpeech(store, OWNER_A, syncedA.revision, "preset_voice"),
    ).toMatchObject({
      ok: true,
      config: { model: "owner-a-tts" },
    });
    expect(
      resolveSpeech(store, OWNER_B, syncedB.revision, "preset_voice"),
    ).toMatchObject({
      ok: true,
      config: { model: "owner-b-tts" },
    });

    expect(
      resolveSpeech(store, OWNER_A, syncedB.revision, "preset_voice"),
    ).toMatchObject({
      ok: false,
      issue: { code: "stale_audio_config" },
    });
    expect(
      resolveSpeech(store, OWNER_B, syncedA.revision, "preset_voice"),
    ).toMatchObject({
      ok: false,
      issue: { code: "stale_audio_config" },
    });
  });

  it("invalidates stale revisions when the same owner syncs again", () => {
    const store = new AudioRuntimeConfigStore();
    const first = store.sync(
      createMimoSnapshot({ presetVoiceModel: "first-model" }),
      OWNER_A,
    );
    const second = store.sync(
      createMimoSnapshot({ presetVoiceModel: "second-model" }),
      OWNER_A,
    );

    expect(second.revision).not.toBe(first.revision);
    expect(
      resolveSpeech(store, OWNER_A, first.revision, "preset_voice"),
    ).toMatchObject({
      ok: false,
      issue: { code: "stale_audio_config" },
    });
    expect(
      resolveSpeech(store, OWNER_A, second.revision, "preset_voice"),
    ).toMatchObject({
      ok: true,
      config: { model: "second-model" },
    });
  });

  it("clears only the released owner's snapshot", () => {
    const store = new AudioRuntimeConfigStore();
    const syncedA = store.sync(createMimoSnapshot(), OWNER_A);
    const syncedB = store.sync(createMimoSnapshot(), OWNER_B);

    store.clearOwner(OWNER_A);

    expect(store.isRevisionCurrent(OWNER_A, syncedA.revision)).toBe(false);
    expect(
      resolveSpeech(store, OWNER_A, syncedA.revision, "voice_design"),
    ).toMatchObject({
      ok: false,
      issue: { code: "stale_audio_config" },
    });
    expect(store.isRevisionCurrent(OWNER_B, syncedB.revision)).toBe(true);
    expect(
      resolveSpeech(store, OWNER_B, syncedB.revision, "voice_design"),
    ).toMatchObject({ ok: true });
  });

  it("deep-clones profiles, assignments, routes, and verification on sync", () => {
    const store = new AudioRuntimeConfigStore();
    const snapshot = createMimoSnapshot({
      verification: {
        "speechSynthesis.preset_voice": {
          status: "verified",
          updatedAt: "2026-07-13T00:00:00.000Z",
        },
      },
    });
    const originalModel =
      snapshot.profiles[0].routes.speechSynthesis.preset_voice!.model;
    const synced = store.sync(snapshot, OWNER_A);

    snapshot.assignment.speechSynthesis = null;
    snapshot.profiles[0].apiKey = "mutated-key";
    snapshot.profiles[0].baseUrl = "https://mutated.example/v1";
    snapshot.profiles[0].routes.speechSynthesis.preset_voice!.model =
      "mutated-model";
    snapshot.profiles[0].routes.speechSynthesis.preset_voice!.enabled = false;
    snapshot.profiles[0].verification![
      "speechSynthesis.preset_voice"
    ]!.status = "failed";

    expect(
      resolveSpeech(store, OWNER_A, synced.revision, "preset_voice"),
    ).toEqual({
      ok: true,
      config: {
        audioProfileId: "audio_mimo",
        providerPreset: "mimo",
        assignmentKey: "speechSynthesis",
        routeKey: "speechSynthesis.preset_voice",
        apiKey: "mimo-secret-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        transport: "mimo_chat_audio",
        model: originalModel,
      },
    });
  });

  it("resolves all MiMo speech modes to their exact assigned routes", () => {
    const store = new AudioRuntimeConfigStore();
    const synced = store.sync(createMimoSnapshot(), OWNER_A);

    for (const [mode, model] of Object.entries(MIMO_TTS_MODEL_BY_MODE) as Array<
      [SpeechSynthesisMode, string]
    >) {
      expect(resolveSpeech(store, OWNER_A, synced.revision, mode)).toMatchObject({
        ok: true,
        config: {
          audioProfileId: "audio_mimo",
          assignmentKey: "speechSynthesis",
          routeKey: `speechSynthesis.${mode}`,
          transport: "mimo_chat_audio",
          model,
        },
      });
    }
  });

  it("does not let legacy verification metadata block real requests", () => {
    const store = new AudioRuntimeConfigStore();
    const synced = store.sync(
      createMimoSnapshot({
        verification: {
          "speechSynthesis.voice_clone": { status: "failed" },
          "speechSynthesis.preset_voice": { status: "verified" },
        },
      }),
      OWNER_A,
    );

    expect(resolveSpeech(store, OWNER_A, synced.revision, "voice_clone"))
      .toMatchObject({
        ok: true,
        config: { routeKey: "speechSynthesis.voice_clone" },
      });
    expect(
      resolveSpeech(store, OWNER_A, synced.revision, "preset_voice"),
    ).toMatchObject({
      ok: true,
      config: { routeKey: "speechSynthesis.preset_voice" },
    });
  });

  it("ignores runtime payload fields that attempt to override the trusted route", () => {
    const store = new AudioRuntimeConfigStore();
    const synced = store.sync(createMimoSnapshot(), OWNER_A);
    const untrustedIntent = {
      assignmentKey: "speechSynthesis",
      mode: "voice_clone",
      model: "renderer-model",
      transport: "openai_audio",
      apiKey: "renderer-key",
      baseUrl: "https://renderer.example/v1",
    } as AudioTaskRouteIntent & Record<string, unknown>;

    expect(
      store.resolveRoute(untrustedIntent, OWNER_A, synced.revision),
    ).toMatchObject({
      ok: true,
      config: {
        apiKey: "mimo-secret-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        transport: "mimo_chat_audio",
        model: MIMO_TTS_MODEL_BY_MODE.voice_clone,
      },
    });
  });
});

function resolveSpeech(
  store: AudioRuntimeConfigStore,
  ownerId: number,
  revision: string | undefined,
  mode: SpeechSynthesisMode,
) {
  return store.resolveRoute(
    { assignmentKey: "speechSynthesis", mode },
    ownerId,
    revision,
  );
}

function createMimoSnapshot(options: {
  presetVoiceModel?: string;
  verification?: SyncAudioRuntimeConfigRequest["profiles"][number]["verification"];
} = {}): SyncAudioRuntimeConfigRequest {
  const routes = createDefaultAudioApiRoutes("mimo");
  if (options.presetVoiceModel) {
    routes.speechSynthesis.preset_voice!.model = options.presetVoiceModel;
  }

  return {
    profiles: [
      {
        id: "audio_mimo",
        providerPreset: "mimo",
        apiKey: "mimo-secret-key",
        baseUrl: "https://api.xiaomimimo.com/v1",
        routes,
        ...(options.verification
          ? { verification: options.verification }
          : {}),
      },
    ],
    assignment: {
      transcription: "audio_mimo",
      speechSynthesis: "audio_mimo",
      realtimeCaptions: "audio_mimo",
      realtimeVoice: null,
    },
  };
}
